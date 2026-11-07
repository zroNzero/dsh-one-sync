# Changelog

All notable changes to this project are documented here.

## [1.2.0] - 2026-11-07

### Added

- One-click setup with GitHub username and default workspace detection.
- Token help for the required fine-grained permissions.

### Fixed

- Migration now removes empty parent directories left behind by moved workspaces.
- Token and passphrase guidance is back in Chinese.

## [1.1.0] - 2026-11-07

### Added

- Auto-sync encrypted state after each turn, enabled per device.
- `Release Plugin` preview and release flow for the public repository.
- Incremental sync index for faster repeat syncs.
- Stage timings in the sync report.

### Changed

- Shared sync status between the sidebar and settings.
- Clearer UI labels and shorter copy.
- Concurrent state uploads and downloads with bounded concurrency.
