# Changelog

All notable changes to this project are documented here.

## [1.7.1] - 2026-11-22

### Fixed

- 浏览器能访问 GitHub、同步却报 `Recv failure: Connection was reset` / `Failed to connect to github.com port 443`：原因是浏览器走 Windows 系统代理（注册表 `ProxyEnable`/`ProxyServer`），而 git 和 Node 默认直连。现在启动时探测系统代理，git 命令注入 `-c http.proxy`/`-c https.proxy`，Node fetch 注入 `HTTPS_PROXY`/`NODE_USE_ENV_PROXY`。
- 代码拉取遇到连接重置时同样重试 3 次（之前只有推送有重试）。

## [1.7.0] - 2026-11-22

### Fixed

- 状态上传 422（input too large）：单个状态文件超过 12MB 时按 `*.dshx.partNNN` 分片上传，manifest 记录 `parts`，拉取端自动按序拼接还原，不再依赖本地克隆和 `git push`（该通道在受限网络下会 `curl 55` 卡死）。

## [1.6.1] - 2026-11-22

### Fixed

- 超大状态文件的本地克隆缓存损坏或残留时（上次克隆中断），自动清理后重新克隆，不再报 “destination path already exists”。

## [1.6.0] - 2026-11-22

### Fixed

- 状态上传遇到超大文件（单个会话约 40MB）时不再被 GitHub 422 拒绝：超过 20MB 的状态文件改走本地克隆 + `git push`，仓库缓存在 `~/.dsh/one-sync/state-repo`。
- 代码推送遇到 `curl 55`、连接重置、`RPC failed` 时自动重试 3 次，并调大 `http.postBuffer`、固定 HTTP/1.1。

## [1.5.0] - 2026-11-19

### Fixed

- 手机端（无 Git 大仓）只同步对话记录时无法下载：工作区路径以 `$DSH_HOME/workspaces` 为基准还原，会话 header 的 cwd 正常重映射。

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
