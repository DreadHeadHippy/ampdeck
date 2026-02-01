# Changelog

## v1.0.1

### New Features
- **Dial controls**: Configurable dial actions for the Now Playing Strip. Choose between Next/Previous on rotate, Volume on rotate, or None. All modes support Play/Pause on dial press.
- **Configurable text color**: Choose from White, Light Gray, Orange, Amber, or Black for text on both buttons and the strip. Useful for matching lighter Stream Deck themes.
- **Dynamic color toggle**: Option to disable dynamic accent colors extracted from album art. When off, accents stay on the default orange.
- **macOS support**: Added install.sh for macOS and macOS platform entry in the manifest.

### Changes
- Appearance settings now appear on both button and strip property inspectors
- Layout refreshes immediately when appearance settings change
- Manifest TriggerDescription updated to reflect dial functionality

## v1.0.0

Initial release.

- Album art display with dominant color extraction
- Now Playing strip with configurable panels spanning all 4 dials
- Play/Pause, Previous, Next button actions
- Track Info button (codec, bitrate, track number)
- Time Elapsed button with progress bar
- Hold-to-seek on Previous/Next buttons
- Configurable sync offset for Plex reporting delay
- Interpolated progress (200ms render, 2s poll)
- Test Connection button in settings
