// Ampdeck v1.0.1 - Stream Deck Plugin for Plexamp
// Dual Web Worker architecture: poll worker (Plex sync) + render worker (interpolated display)

var websocket = null;
var pluginUUID = null;
var globalSettings = {};
var actions = {};

// Plex state
var currentTrack = null;
var currentAlbumArt = null;
var dominantColor = "#E5A00D";
var playbackState = "stopped";
var trackDuration = 0;
var lastArtPath = null;
var albumTrackCount = null;
var lastParentRatingKey = null;

// Interpolation state
var serverPosition = 0;
var serverTimestamp = 0;
var lastServerPosition = -1;
var displayPosition = 0;
var displayProgress = 0;

// Layout state (avoid resending unchanged layouts)
var lastLayoutState = {};

// Button hold state for seek-on-hold
var buttonHoldState = {};
var HOLD_THRESHOLD = 400;
var SEEK_INTERVAL = 200;
var SEEK_AMOUNT = 10000;

// Volume state
var currentVolume = 50;
var VOLUME_STEP = 5;

// Workers
var pollWorker = null;
var renderWorker = null;
var pollBlobUrl = null;
var renderBlobUrl = null;

function log(msg, data) {
    var ts = new Date().toISOString().substr(11, 8);
    if (data !== undefined) console.log("[Ampdeck " + ts + "] " + msg, data);
    else console.log("[Ampdeck " + ts + "] " + msg);
}

// ============================================
// SETTINGS HELPERS
// ============================================
function getTextColor() {
    return globalSettings.textColor || "#FFFFFF";
}

function getSecondaryTextColor() {
    var tc = getTextColor();
    // Return a dimmer version for secondary text
    if (tc === "#FFFFFF") return "#888888";
    if (tc === "#BBBBBB") return "#777777";
    if (tc === "#E5A00D") return "#B07A0A";
    if (tc === "#FFBF00") return "#B08600";
    if (tc === "#000000") return "#444444";
    return "#888888";
}

function getAccentColor() {
    if (globalSettings.dynamicColors === false) return "#E5A00D";
    return dominantColor;
}

// ============================================
// INTERPOLATION
// ============================================
function updateInterpolatedPosition() {
    if (playbackState === "playing" && serverTimestamp > 0) {
        var elapsed = Date.now() - serverTimestamp;
        displayPosition = Math.min(serverPosition + elapsed, trackDuration);
    } else {
        displayPosition = serverPosition;
    }
    displayProgress = trackDuration > 0 ? (displayPosition / trackDuration) * 100 : 0;
}

function renderTick() {
    updateInterpolatedPosition();
    updateAllDisplays();
}

// ============================================
// WEB WORKERS
// ============================================
function createTimerWorker(intervalMs) {
    var code = 'var iv=null;self.onmessage=function(e){if(e.data==="start"){if(iv)clearInterval(iv);iv=setInterval(function(){self.postMessage("tick");},' + intervalMs + ');}else if(e.data==="stop"){if(iv){clearInterval(iv);iv=null;}}};';
    var blob = new Blob([code], { type: "application/javascript" });
    var url = URL.createObjectURL(blob);
    var worker = new Worker(url);
    worker._blobUrl = url;
    return worker;
}

function terminateWorker(worker) {
    if (!worker) return;
    worker.postMessage("stop");
    worker.terminate();
    if (worker._blobUrl) URL.revokeObjectURL(worker._blobUrl);
}

// ============================================
// COLOR EXTRACTION
// ============================================
function extractDominantColor(imageDataUrl) {
    return new Promise(function(resolve) {
        var img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = function() {
            try {
                var canvas = document.createElement("canvas");
                var ctx = canvas.getContext("2d");
                canvas.width = 50; canvas.height = 50;
                ctx.drawImage(img, 0, 0, 50, 50);
                var pixels = ctx.getImageData(0, 0, 50, 50).data;
                var r = 0, g = 0, b = 0, count = 0;
                for (var i = 0; i < pixels.length; i += 4) {
                    var pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];
                    var brightness = (pr + pg + pb) / 3;
                    if (brightness > 30 && brightness < 220) {
                        var mx = Math.max(pr, pg, pb), mn = Math.min(pr, pg, pb);
                        if (mx > 0 && (mx - mn) / mx > 0.2) {
                            r += pr; g += pg; b += pb; count++;
                        }
                    }
                }
                if (count > 0) {
                    r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
                    var mn2 = Math.min(r, g, b);
                    r = Math.min(255, Math.round(r + (r - mn2) * 0.2));
                    g = Math.min(255, Math.round(g + (g - mn2) * 0.2));
                    b = Math.min(255, Math.round(b + (b - mn2) * 0.2));
                    var hex = "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0");
                    resolve(hex);
                } else { resolve("#E5A00D"); }
            } catch (e) { resolve("#E5A00D"); }
        };
        img.onerror = function() { resolve("#E5A00D"); };
        img.src = imageDataUrl;
    });
}

// ============================================
// STREAM DECK CONNECTION
// ============================================
function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo) {
    pluginUUID = inPluginUUID;
    websocket = new WebSocket("ws://127.0.0.1:" + inPort);

    websocket.onopen = function() {
        websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: inPluginUUID }));
        websocket.send(JSON.stringify({ event: "getGlobalSettings", context: inPluginUUID }));
        log("Plugin connected - Ampdeck v1.0.1");
    };

    websocket.onmessage = function(evt) {
        var data = JSON.parse(evt.data);
        switch (data.event) {
            case "willAppear": onWillAppear(data); break;
            case "willDisappear": onWillDisappear(data); break;
            case "didReceiveGlobalSettings": onDidReceiveGlobalSettings(data); break;
            case "didReceiveSettings": onDidReceiveSettings(data); break;
            case "keyDown": onKeyDown(data); break;
            case "keyUp": onKeyUp(data); break;
            case "dialRotate": onDialRotate(data); break;
            case "dialDown": onDialDown(data); break;
        }
    };
}

function onWillAppear(data) {
    actions[data.context] = { action: data.action, settings: data.payload.settings || {} };
    applyGlobalFromSettings(data.payload.settings || {});
    startPolling();
}

function onWillDisappear(data) {
    delete actions[data.context];
    delete lastLayoutState[data.context];
    if (buttonHoldState[data.context]) {
        clearInterval(buttonHoldState[data.context].seekInterval);
        delete buttonHoldState[data.context];
    }
    if (Object.keys(actions).length === 0) stopPolling();
}

function onDidReceiveGlobalSettings(data) {
    globalSettings = data.payload.settings || {};
    if (globalSettings.plexToken && globalSettings.plexServerUrl) pollPlex();
}

function onDidReceiveSettings(data) {
    if (actions[data.context]) actions[data.context].settings = data.payload.settings || {};
    applyGlobalFromSettings(data.payload.settings || {});
    saveGlobalSettings();
    // Force layout refresh when appearance settings change
    lastLayoutState[data.context] = null;
    updateInterpolatedPosition();
    updateAllDisplays();
}

function applyGlobalFromSettings(s) {
    if (s.plexServerUrl) globalSettings.plexServerUrl = s.plexServerUrl;
    if (s.plexToken) globalSettings.plexToken = s.plexToken;
    if (s.clientName) globalSettings.clientName = s.clientName;
    if (s.syncOffset !== undefined) globalSettings.syncOffset = s.syncOffset;
    if (s.textColor) globalSettings.textColor = s.textColor;
    if (s.dynamicColors !== undefined) globalSettings.dynamicColors = s.dynamicColors;
}

// ============================================
// BUTTON PRESS HANDLING
// ============================================
function onKeyDown(data) {
    var ctx = data.context, action = data.action;
    buttonHoldState[ctx] = { pressTime: Date.now(), action: action, seekInterval: null, didSeek: false };

    if (action === "com.rackemrack.ampdeck.previous" || action === "com.rackemrack.ampdeck.next") {
        setTimeout(function() {
            if (buttonHoldState[ctx] && !buttonHoldState[ctx].didSeek) {
                buttonHoldState[ctx].didSeek = true;
                var dir = action.indexOf("previous") >= 0 ? -1 : 1;
                seekTrack(dir * SEEK_AMOUNT);
                buttonHoldState[ctx].seekInterval = setInterval(function() { seekTrack(dir * SEEK_AMOUNT); }, SEEK_INTERVAL);
            }
        }, HOLD_THRESHOLD);
    }
}

function onKeyUp(data) {
    var ctx = data.context, action = data.action, hs = buttonHoldState[ctx];
    if (hs && hs.seekInterval) clearInterval(hs.seekInterval);

    if (!hs || !hs.didSeek) {
        if (action === "com.rackemrack.ampdeck.album-art" || action === "com.rackemrack.ampdeck.play-pause") togglePlayPause();
        else if (action === "com.rackemrack.ampdeck.previous") skipPrevious();
        else if (action === "com.rackemrack.ampdeck.next") skipNext();
    }
    delete buttonHoldState[ctx];
}

// ============================================
// DIAL HANDLING (Stream Deck+ encoders)
// ============================================
function onDialRotate(data) {
    var ctx = data.context;
    var settings = actions[ctx] ? actions[ctx].settings : {};
    var dialAction = settings.dialAction || "none";
    var ticks = data.payload.ticks || 0;

    if (dialAction === "skip") {
        if (ticks > 0) skipNext();
        else if (ticks < 0) skipPrevious();
    } else if (dialAction === "volume") {
        var newVolume = Math.max(0, Math.min(100, currentVolume + (ticks * VOLUME_STEP)));
        setVolume(newVolume);
    }
}

function onDialDown(data) {
    var ctx = data.context;
    var settings = actions[ctx] ? actions[ctx].settings : {};
    var dialAction = settings.dialAction || "none";

    if (dialAction !== "none") {
        togglePlayPause();
    }
}

// ============================================
// PLEX PLAYBACK CONTROL
// ============================================
function getClientId() {
    if (currentTrack && currentTrack.Player) return currentTrack.Player.machineIdentifier;
    return null;
}

function plexCommand(path) {
    var machineId = getClientId();
    if (!machineId || !globalSettings.plexServerUrl || !globalSettings.plexToken) return;
    var url = globalSettings.plexServerUrl + path + "?commandID=1&X-Plex-Token=" + globalSettings.plexToken + "&X-Plex-Target-Client-Identifier=" + machineId;
    fetch(url).catch(function(e) { log("Cmd error: " + e.message); });
}

function togglePlayPause() {
    if (playbackState === "stopped") return;
    var cmd = playbackState === "playing" ? "pause" : "play";
    plexCommand("/player/playback/" + cmd);
    if (playbackState === "playing") {
        playbackState = "paused";
        serverPosition = displayPosition;
        serverTimestamp = Date.now();
    } else {
        playbackState = "playing";
        serverTimestamp = Date.now();
    }
    updateInterpolatedPosition();
    updateAllDisplays();
}

function skipNext() { plexCommand("/player/playback/skipNext"); }
function skipPrevious() { plexCommand("/player/playback/skipPrevious"); }

function seekTrack(offsetMs) {
    var machineId = getClientId();
    if (!machineId) return;
    var newPos = Math.max(0, Math.min(displayPosition + offsetMs, trackDuration));
    var url = globalSettings.plexServerUrl + "/player/playback/seekTo?commandID=1&offset=" + Math.round(newPos) + "&X-Plex-Token=" + globalSettings.plexToken + "&X-Plex-Target-Client-Identifier=" + machineId;
    fetch(url).then(function() {
        serverPosition = newPos;
        lastServerPosition = -1;
        serverTimestamp = Date.now();
        updateInterpolatedPosition();
        updateAllDisplays();
    }).catch(function(e) { log("Seek error: " + e.message); });
}

function setVolume(level) {
    var machineId = getClientId();
    if (!machineId || !globalSettings.plexServerUrl || !globalSettings.plexToken) return;
    currentVolume = Math.max(0, Math.min(100, level));
    var url = globalSettings.plexServerUrl + "/player/playback/setParameters?volume=" + currentVolume + "&commandID=1&X-Plex-Token=" + globalSettings.plexToken + "&X-Plex-Target-Client-Identifier=" + machineId;
    fetch(url).then(function() {
        log("Volume: " + currentVolume);
    }).catch(function(e) { log("Volume error: " + e.message); });
}

function saveGlobalSettings() {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ event: "setGlobalSettings", context: pluginUUID, payload: globalSettings }));
    }
}

// ============================================
// PLEX API
// ============================================
function fetchAlbumTrackCount(parentRatingKey) {
    if (!parentRatingKey || !globalSettings.plexServerUrl || !globalSettings.plexToken) return;
    if (parentRatingKey === lastParentRatingKey && albumTrackCount !== null) return;

    lastParentRatingKey = parentRatingKey;
    albumTrackCount = null;

    var url = globalSettings.plexServerUrl + "/library/metadata/" + parentRatingKey + "/children?X-Plex-Token=" + globalSettings.plexToken;
    fetch(url, { headers: { "Accept": "application/json" } })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data && data.MediaContainer && data.MediaContainer.size) {
                albumTrackCount = data.MediaContainer.size;
                log("Album tracks: " + albumTrackCount);
            }
        })
        .catch(function(e) { log("Track count error: " + e.message); });
}

function pollPlex() {
    if (!globalSettings.plexToken || !globalSettings.plexServerUrl) return;

    fetch(globalSettings.plexServerUrl + "/status/sessions?X-Plex-Token=" + globalSettings.plexToken, { headers: { "Accept": "application/json" } })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var track = findPlexampSession(data);

            if (track) {
                var newState = track.Player ? (track.Player.state || "playing") : "playing";
                var newDuration = track.duration || 0;
                var newPosition = track.viewOffset || 0;
                var trackChanged = !currentTrack || currentTrack.ratingKey !== track.ratingKey;

                // Only reset interpolation anchor when Plex reports a genuinely different position.
                // Avoids the "count up, snap back, repeat" loop caused by stale Plex data.
                if (newPosition !== lastServerPosition || trackChanged) {
                    var syncOffset = globalSettings.syncOffset !== undefined ? parseInt(globalSettings.syncOffset) : 1500;
                    serverPosition = newPosition + syncOffset;
                    serverTimestamp = Date.now();
                    lastServerPosition = newPosition;
                }

                playbackState = newState;
                trackDuration = newDuration;
                currentTrack = track;

                if (trackChanged) {
                    albumTrackCount = null;
                    fetchAlbumTrackCount(track.parentRatingKey);
                    var artPath = track.thumb || track.parentThumb || track.grandparentThumb;
                    if (artPath && artPath !== lastArtPath) {
                        lastArtPath = artPath;
                        fetchAlbumArt(artPath);
                    }
                }
            } else {
                if (currentTrack !== null || playbackState !== "stopped") {
                    currentTrack = null;
                    playbackState = "stopped";
                    serverPosition = 0;
                    serverTimestamp = 0;
                    lastServerPosition = -1;
                    trackDuration = 0;
                    albumTrackCount = null;
                    lastParentRatingKey = null;
                    lastArtPath = null;
                    currentAlbumArt = null;
                    dominantColor = "#E5A00D";
                    updateInterpolatedPosition();
                    updateAllDisplays();
                }
            }
        })
        .catch(function(e) { log("Poll error: " + e.message); });
}

function findPlexampSession(data) {
    if (!data || !data.MediaContainer || !data.MediaContainer.Metadata) return null;
    var clientName = globalSettings.clientName || "";
    var list = data.MediaContainer.Metadata;
    for (var i = 0; i < list.length; i++) {
        if (list[i].type === "track" && list[i].Player) {
            if (list[i].Player.title === clientName || list[i].Player.product === "Plexamp") {
                return list[i];
            }
        }
    }
    return null;
}

function fetchAlbumArt(thumbPath) {
    fetch(globalSettings.plexServerUrl + thumbPath + "?X-Plex-Token=" + globalSettings.plexToken)
        .then(function(r) { return r.blob(); })
        .then(function(blob) {
            var reader = new FileReader();
            reader.onloadend = function() {
                currentAlbumArt = reader.result;
                extractDominantColor(currentAlbumArt).then(function(color) {
                    dominantColor = color;
                    updateInterpolatedPosition();
                    updateAllDisplays();
                });
            };
            reader.readAsDataURL(blob);
        })
        .catch(function(e) { log("Art error: " + e.message); });
}

// ============================================
// DISPLAY UPDATES
// ============================================
function updateAllDisplays() {
    for (var ctx in actions) {
        var action = actions[ctx].action;
        if (action === "com.rackemrack.ampdeck.album-art") updateAlbumArtButton(ctx);
        else if (action === "com.rackemrack.ampdeck.strip") updateStripDisplay(ctx);
        else if (action === "com.rackemrack.ampdeck.play-pause") updatePlayPauseButton(ctx);
        else if (action === "com.rackemrack.ampdeck.info") updateInfoButton(ctx);
        else if (action === "com.rackemrack.ampdeck.time") updateTimeButton(ctx);
    }
}

function updateAlbumArtButton(ctx) {
    var canvas = document.createElement("canvas");
    canvas.width = 144; canvas.height = 144;
    var c = canvas.getContext("2d");
    c.fillStyle = "#000000";
    c.fillRect(0, 0, 144, 144);

    if (!currentAlbumArt) {
        c.fillStyle = "#333333";
        c.textAlign = "center";
        c.font = "14px sans-serif";
        c.fillText("No Track", 72, 76);
        setImage(ctx, canvas.toDataURL("image/png"));
        return;
    }

    var img = new Image();
    img.onload = function() {
        c.drawImage(img, 0, 0, 144, 144);
        if (playbackState === "paused") {
            c.fillStyle = "rgba(0,0,0,0.4)";
            c.fillRect(0, 0, 144, 144);
            c.fillStyle = "#FFFFFF";
            c.fillRect(52, 47, 14, 50);
            c.fillRect(78, 47, 14, 50);
        }
        setImage(ctx, canvas.toDataURL("image/png"));
    };
    img.src = currentAlbumArt;
}

function updatePlayPauseButton(ctx) {
    var canvas = document.createElement("canvas");
    canvas.width = 144; canvas.height = 144;
    var c = canvas.getContext("2d");
    c.fillStyle = "#000000";
    c.fillRect(0, 0, 144, 144);

    var textColor = getTextColor();

    if (playbackState === "stopped") {
        c.fillStyle = "#333333";
        c.beginPath();
        c.moveTo(50, 42); c.lineTo(110, 72); c.lineTo(50, 102);
        c.closePath(); c.fill();
    } else if (playbackState === "playing") {
        c.fillStyle = textColor;
        c.fillRect(45, 42, 18, 60);
        c.fillRect(81, 42, 18, 60);
    } else {
        c.fillStyle = textColor;
        c.beginPath();
        c.moveTo(50, 42); c.lineTo(110, 72); c.lineTo(50, 102);
        c.closePath(); c.fill();
    }
    setImage(ctx, canvas.toDataURL("image/png"));
}

function updateInfoButton(ctx) {
    var canvas = document.createElement("canvas");
    canvas.width = 144; canvas.height = 144;
    var c = canvas.getContext("2d");
    c.fillStyle = "#000000";
    c.fillRect(0, 0, 144, 144);

    var textColor = getTextColor();
    var secondaryColor = getSecondaryTextColor();
    var accentColor = getAccentColor();

    if (currentTrack) {
        var media = currentTrack.Media && currentTrack.Media[0];
        var format = media && media.audioCodec ? media.audioCodec.toUpperCase() : "---";
        var bitrate = media && media.bitrate ? Math.round(media.bitrate) + " kbps" : "";
        var trackNum = currentTrack.index || "?";
        var totalTracks = albumTrackCount || "?";

        c.textAlign = "center";
        c.font = "bold 28px sans-serif";
        c.fillStyle = textColor;
        c.fillText(format, 72, 42);

        c.font = "14px sans-serif";
        c.fillStyle = secondaryColor;
        c.fillText(bitrate, 72, 62);

        c.font = "bold 16px sans-serif";
        c.fillStyle = textColor;
        c.fillText("TRACK", 72, 95);

        c.font = "bold 28px sans-serif";
        c.fillStyle = accentColor;
        c.fillText(trackNum + "/" + totalTracks, 72, 125);
    } else {
        c.fillStyle = "#333333";
        c.textAlign = "center";
        c.font = "16px sans-serif";
        c.fillText("No Track", 72, 76);
    }
    setImage(ctx, canvas.toDataURL("image/png"));
}

function updateTimeButton(ctx) {
    var canvas = document.createElement("canvas");
    canvas.width = 144; canvas.height = 144;
    var c = canvas.getContext("2d");
    c.fillStyle = "#000000";
    c.fillRect(0, 0, 144, 144);

    var textColor = getTextColor();
    var secondaryColor = getSecondaryTextColor();
    var accentColor = getAccentColor();

    if (playbackState === "stopped") {
        c.textAlign = "center";
        c.font = "bold 36px sans-serif";
        c.fillStyle = "#333333";
        c.fillText("0:00", 72, 55);
        c.font = "20px sans-serif";
        c.fillText("/ 0:00", 72, 82);
        c.fillStyle = "#333333";
        c.fillRect(15, 108, 114, 10);
    } else {
        c.textAlign = "center";
        c.font = "bold 36px sans-serif";
        c.fillStyle = textColor;
        c.fillText(formatTime(displayPosition), 72, 55);

        c.font = "20px sans-serif";
        c.fillStyle = secondaryColor;
        c.fillText("/ " + formatTime(trackDuration), 72, 82);

        c.fillStyle = "#333333";
        c.fillRect(15, 108, 114, 10);
        if (displayProgress > 0) {
            c.fillStyle = accentColor;
            c.fillRect(15, 108, (displayProgress / 100) * 114, 10);
        }
    }
    setImage(ctx, canvas.toDataURL("image/png"));
}

function updateStripDisplay(ctx) {
    var settings = actions[ctx].settings || {};
    var displayMode = settings.displayMode || "artist";
    var fontSize = parseInt(settings.fontSize) || 16;
    var totalPanels = parseInt(settings.progressTotalPanels) || 3;
    var position = parseInt(settings.progressPosition) || 1;

    var textColor = settings.textColor || getTextColor();
    var accentColor = getAccentColor();

    // Compute dimmed version of the chosen text color for secondary text
    var stripSecondary;
    if (textColor === "#FFFFFF") stripSecondary = "#999999";
    else if (textColor === "#BBBBBB") stripSecondary = "#777777";
    else if (textColor === "#E5A00D") stripSecondary = "#B07A0A";
    else if (textColor === "#FFBF00") stripSecondary = "#B08600";
    else if (textColor === "#000000") stripSecondary = "#444444";
    else stripSecondary = "#999999";

    var label = "", text = "";
    if (currentTrack) {
        if (displayMode === "artist") { label = "ARTIST"; text = currentTrack.grandparentTitle || "Unknown"; }
        else if (displayMode === "album") { label = "ALBUM"; text = currentTrack.parentTitle || "Unknown"; }
        else if (displayMode === "track") { label = "TRACK"; text = currentTrack.title || "Unknown"; }
        else if (displayMode === "time") { label = "TIME"; text = formatTime(displayPosition) + " / " + formatTime(trackDuration); }
    } else {
        label = displayMode.toUpperCase();
        text = displayMode === "time" ? "0:00 / 0:00" : "Not Playing";
    }

    var labelSize = Math.max(14, Math.round(fontSize * 0.85));
    var progressBar = createProgressBarSegment(position, totalPanels, displayProgress, accentColor);

    // Compute a layout key that captures all appearance-affecting state
    var pausedDim = playbackState === "paused";
    var layoutKey = (pausedDim ? "p" : "a") + "|" + textColor + "|" + (pausedDim ? stripSecondary : textColor);
    if (lastLayoutState[ctx] !== layoutKey) {
        lastLayoutState[ctx] = layoutKey;

        var labelColor = pausedDim ? stripSecondary : textColor;
        var textDisplayColor = pausedDim ? stripSecondary : stripSecondary;

        setFeedbackLayout(ctx, {
            "id": "com.rackemrack.ampdeck.layout",
            "items": [
                { "key": "label", "type": "text", "rect": [0, 15, 200, labelSize + 4],
                  "font": { "size": labelSize, "weight": 700 },
                  "color": labelColor, "alignment": "center" },
                { "key": "displayText", "type": "text", "rect": [0, 15 + labelSize + 8, 200, fontSize + 8],
                  "font": { "size": fontSize, "weight": 400 },
                  "color": textDisplayColor, "alignment": "center" },
                { "key": "progressBar", "type": "pixmap", "rect": [0, 82, 200, 4] }
            ]
        });
    }

    setFeedback(ctx, { label: label, displayText: text, progressBar: progressBar });
}

// ============================================
// HELPERS
// ============================================
function formatTime(ms) {
    if (!ms || ms <= 0) return "0:00";
    var sec = Math.floor(ms / 1000);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
}

function createProgressBarSegment(position, totalPanels, progress, color) {
    var canvas = document.createElement("canvas");
    canvas.width = 200; canvas.height = 4;
    var c = canvas.getContext("2d");
    c.fillStyle = "#333333";
    c.fillRect(0, 0, 200, 4);

    if (position > 0 && position <= totalPanels) {
        var segSize = 100 / totalPanels;
        var segStart = (position - 1) * segSize;
        var segEnd = position * segSize;
        if (progress > segStart) {
            var pInSeg = Math.min(progress, segEnd) - segStart;
            var fillW = Math.round((pInSeg / segSize) * 200);
            if (fillW > 0) { c.fillStyle = color; c.fillRect(0, 0, fillW, 4); }
        }
    }
    return canvas.toDataURL("image/png");
}

// ============================================
// STREAM DECK API
// ============================================
function setImage(ctx, img) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ event: "setImage", context: ctx, payload: { image: img, target: 0 } }));
    }
}

function setFeedback(ctx, payload) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ event: "setFeedback", context: ctx, payload: payload }));
    }
}

function setFeedbackLayout(ctx, layout) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ event: "setFeedbackLayout", context: ctx, payload: { layout: layout } }));
    }
}

// ============================================
// POLLING CONTROL
// ============================================
function startPolling() {
    if (pollWorker) return;

    pollWorker = createTimerWorker(2000);
    pollWorker.onmessage = function() { pollPlex(); };
    pollWorker.postMessage("start");

    renderWorker = createTimerWorker(200);
    renderWorker.onmessage = function() { renderTick(); };
    renderWorker.postMessage("start");

    pollPlex();
    log("Started: poll@2s, render@200ms");
}

function stopPolling() {
    terminateWorker(pollWorker); pollWorker = null;
    terminateWorker(renderWorker); renderWorker = null;
    log("Stopped polling");
}

log("Ampdeck v1.0.1 loaded");
