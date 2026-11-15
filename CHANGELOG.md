# Changelog

All notable changes to this project are documented here.

## [1.4.0] - 2026-11-15

### Added

- “只同步对话记录”开关：勾选后只读写加密状态仓库，只同步 sessions 与 workspace.json，代码仓库字段变灰不可填。

### Fixed

- Workspace migration now preserves and repairs absolute junctions/symlinks.
- Profile `node_modules` links pointing into a migrated workspace are retargeted.
- Migration warns when `node_modules` or nested `.git` may break links.

## [1.3.0] - 2026-11-08

### Fixed

- Config is saved locally before GitHub validation, so failed checks no longer clear inputs.
- New devices initialize and pull the configured code remote automatically.
- `.gitignore` is populated before the first code commit.
- Ghost plugins are removed when pulling a profile config.
- Atomic writes retry transient Windows EPERM/BUSY failures.

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
