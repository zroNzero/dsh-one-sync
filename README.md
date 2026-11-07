# dsh-one-sync

DSH 一键同步插件：把一个 Git 项目目录的代码，以及 DSH 本机的 `sessions / storages / memories` 状态，合并成一次「拉取 → 解密恢复 → 推送 → 加密上传」的闭环。

- 左侧栏底部：**一键同步**按钮（执行中旋转，结果在 tooltip 与设置页回显）。
- 设置 → **一键同步**：配置 `codeDir / stateRepo / token / passphrase`，并可立即同步、清除 Token。
- **单体大仓**：`codeDir` 可以是 Git 根目录的子目录，插件会自动向上找到 `.git` 根目录，以根目录为单位 pull/push。
- **状态仓库与代码仓库彻底分离**：`stateRepo` 只存 DSH 状态，代码使用 Git 根目录自己的 `origin`。
- 状态文件使用 **AES-256-GCM** 加密，确定性 IV；内容没变时不会产生新提交。
- 状态传输统一走 GitHub REST（Git Data API），不需要 SSH 密钥，也不使用 `refer/sync-mh.js` 里的旧 `client.getBranchHead` 接口。

## 配置

配置文件：`~/.dsh/one-sync.json`（`$DSH_HOME/one-sync.json`）。设置页保存的就是它。

```json
{
  "codeDir": "D:\\PC\\my-project\\packages\\app",
  "stateRepo": "https://github.com/<用户名>/<状态私有仓库>.git",
  "token": "github_pat_xxx",
  "passphrase": "两台电脑约定的同一口令",
  "branch": "main",
  "deviceName": "home-pc",
  "maxFileMb": 45,
  "rememberKey": true
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `codeDir` | 当前工作区绝对路径，可以是 Git 根目录的子目录；插件自动向上寻找 `.git` 根目录并同步根目录。留空则只同步 DSH 状态。 |
| `stateRepo` | **全局 DSH 状态仓库**的 GitHub 地址（私有仓库），只存 `key.enc` / `state/`。与代码仓库完全分离；代码同步使用代码目录 Git 根目录自己的 `origin`。 |
| `token` | fine-grained PAT：状态仓库 `Contents: read/write`；classic PAT：`repo`。代码仓库走 HTTPS 或“发布新库”时也用它认证。 |
| `passphrase` | 两台电脑必须一致；用于生成/解开状态仓库里的 `key.enc`。 |
| `branch` | 代码与状态共用的分支名，默认 `main`。 |
| `deviceName` | 写入清单和提交信息；留空使用主机名。 |
| `maxFileMb` | 单文件上限，默认 45 MB；超限文件跳过，并保留远端旧副本。 |
| `rememberKey` | 是否把主密钥缓存到 `~/.dsh/one-sync/key`，默认开启。 |

> `token` 和 `passphrase` 以本机明文保存在配置文件里；插件会尽力把文件权限设为 600，但请确保本机账户安全。
>
> 旧版本的 `remote` 字段会在读取时自动迁移为 `stateRepo`；再次保存后配置文件只写 `stateRepo`。

## 单体大仓：自动向上寻找 Git 根目录

同步代码前，插件会在 `codeDir` 执行：

```text
git rev-parse --show-toplevel
```

- 如果 `codeDir` 是父仓库 A 的子目录 B，后续 `status / add / commit / pull / push` 全部在 A 执行；
- 如果找不到 Git 根目录，会报错并提示先初始化 Git 或修正 `codeDir`；
- 如果 `codeDir` 与根目录不一致，同步日志和前端结果会提示：
  `检测到嵌套子工作区，自动在根目录 <gitRoot> 进行同步`
- `~/.dsh/storages/workspace.json` 中的工作区 `path` 会自动重映射：
  - Push State：位于 `gitRoot` 下的绝对路径写成 `./相对路径` 后加密上传；
  - Pull State：把 `./相对路径` 用当前机器的 `gitRoot` 还原为绝对路径再写入本地。

## 安装

在 DSH 的添加插件界面，直接选择或输入本插件的本地绝对路径进行加载：

```text
D:\PC\dsh_sync\dsh-sync
```

如果界面要求选择具体文件，请选该目录下的 `package.json`。

加载后重启/刷新 DSH，确认：

1. 左侧栏底部出现「一键同步」按钮；
2. 设置页出现「一键同步」；
3. 填写配置并保存，点「立即一键同步」。

> 这是一个纯净的运行时包：`files` 只包含 `index.js`、`client.js`、`lib/`、`cordis.patch.yml`、`README.md`；没有测试目录，也不需要 `npm install`。

## 发布当前工作区为新库

设置页 →「一键同步」→「发布当前工作区为新库」：

- 把 `codeDir` 初始化为新 Git 仓库；
- 生成/保留 `.gitignore`；
- 创建 **GitHub 私密仓库** 并推送 `Initial commit`；
- **不会修改 `stateRepo`**：发布只负责代码仓库，DSH 状态仓库保持独立。

要求与限制：

- `codeDir` 必须是绝对路径，且当前目录不能已有 `.git`，也不能位于其他 Git 仓库内；否则会拒绝并提示「已有 Git 仓库，请直接使用一键同步」。嵌套子目录请直接用一键同步（会自动同步父仓库）。
- Token 需要创建仓库的权限：classic PAT 用 `repo`；fine-grained PAT 需要账号级 Repository creation / Administration write。
- 仓库名会被规范成 GitHub 可用的 slug；重名时发布会失败，请换一个名称。
- 若建仓成功但首次 push 失败，本地仓库和远端仓库都会保留；按错误提示手动 `git push -u origin <branch>` 即可。

## 同步顺序

1. **Git Pull**：先 `git rev-parse --show-toplevel` 找到 Git 根目录；`codeDir` 有未提交改动时在根目录自动 `commit`；然后 `pull --ff-only`，失败则 `pull --rebase`。冲突时执行 `git rebase --abort` 并报「代码产生冲突，已中止合并保护本地代码，请手动解决冲突后再试」。
2. **Pull State**：使用 `stateRepo`（REST）读取 `key.enc` / `state/manifest.json` / `state/**/*.dshx`，用 `decryptFile` 解密；按三方基线合并写入 `~/.dsh/sessions`、`~/.dsh/storages`、`~/.dsh/memories`，并恢复 `configs` 分组里的 Profile 配置与 `settings.yaml`。`workspace.json` 按**路径**与本地做并集：同一目录在 A/B 两台生成不同 UUID 时只保留一个工作区，双方的 `sessionIds` 合并。远端有、本地缺失的工作区目录会从代码大仓 `git checkout`；大仓里没有的空工作区则创建空目录。
3. **Git Push**：在 Git 根目录再次兜底提交，`push origin <branch>`；远端领先时自动 rebase 后重试一次。不会强推。本地新建的工作区文件会在这一步提交并推送。
4. **Push State**：扫描状态 → `encryptFile` → 与 `stateRepo` 的远端树按 git blob sha 比对 → `commitFiles` 一个原子提交。清单是「本地 + 远端」的并集：**本机没扫描到的远端会话不会被删除**，只会上传本机新增/修改的文件。状态拉取失败时本轮跳过状态上传，避免覆盖远端。

## 状态仓库布局

```text
key.enc                          passphrase 包装后的主密钥
state/manifest.json              清单（路径 / 明文哈希 / 密文哈希 / mtime / 尺寸）
state/sessions/<rel>.dshx        会话日志密文
state/storages/<rel>.dshx
state/memories/<rel>.dshx
state/configs/profiles/<profile>/package.json.dshx
state/configs/profiles/<profile>/cordis.patch.yml.dshx
state/configs/settings.yaml.dshx
```

- `configs` 分组同步当前 Profile 的 `package.json`、`cordis.patch.yml`，以及 `$DSH_HOME/settings.yaml`；拉取时以远端为准覆盖本地（旧版本会先备份到 `~/.dsh/one-sync/conflicts/`）。拉取配置后需要重启 DSH 生效；若 `package.json` 的依赖有变化，按需在 profile 目录执行 `pnpm install`。

- `key.enc` 用 scrypt（N=2^15）派生 KEK 后 AES-256-GCM 包装；文件本身用确定性 IV，相同明文得到相同密文。
- 本机状态目录（不入库）：`~/.dsh/one-sync/`，包含 `key`（主密钥缓存）、`key.enc`、`state.json`（三方基线）、`status.json`、`conflicts/`。
- 会话日志写入前检查 zstd 魔数；坏文件会被跳过，避免 DSH 启动时因损坏日志整体失败。

## 冲突策略

| local vs base vs remote | 行为 |
| --- | --- |
| local == remote | 不变 |
| local == base | 采用远端 |
| remote == base | 保留本机，等待下一次 push |
| 会话：两边都改，且本机 mtime > 基线 | **保留本机**；远端版本另存为 `<name>.remote.jsonl.zstd`，不覆盖本地 |
| 会话：首次同步双方已有同名文件，本机不旧于远端 | **保留本机**；远端版本另存为 `<name>.remote.jsonl.zstd` |
| configs：本地与远端不同 | 远端覆盖本机；本机旧版备份到 `~/.dsh/one-sync/conflicts/` |
| 其他两边都改 | 修改时间新者胜；远端较新则覆盖前备份到 `~/.dsh/one-sync/conflicts/` |
| 没有 base（首次拉取） | 远端时间戳比本机新才覆盖，且先备份本机 |

`.remote.jsonl.zstd` 副本只留在本机，扫描与 push 会排除它，不会再次上传。`pull` **不会删除本机文件**（避免误删活跃会话）；`push` **也不会自动删除远端独有文件**（它可能正是另一台电脑刚建的），因此状态仓库始终是两台设备的并集。

## 运行时要求

- 支持当前 DSH Web 插件格式（`dsh.bundle.patch` + `exports["./client"]` + `dsh.client.platform = "web"`）。
- Node.js ≥ 22。
- 无第三方依赖，不需要 `npm install`。
- 发布包只包含运行时文件，不包含 `test/`、日志或临时文件。

## 已知限制

- 状态仓库需要先存在；空仓库首次推送会用 Contents API 写入一个 README 来初始化。
- 非空仓库不会替你新建状态分支：如果设置的分支不存在，请先在 GitHub 创建，或把「分支」改成已存在的分支。
- `stateRepo` 与代码仓库彻底分离；发布新代码仓库不会修改 `stateRepo`，状态同步也不会写入代码仓库。
- 两机同时同步时，状态提交可能发生 ref 竞争；建议避免同一时刻点击同步。
- 工作区条目按路径并集，但 DSH 的会话目录名仍由本机绝对路径编码。两台 `codeDir` 使用相同绝对路径时，会话可以直接显示在对应工作区；完全不同的绝对路径目前只能保证会话文件被拉取，不能保证 DSH 自动挂到同名工作区下。
- 修改 `passphrase` 不会自动重新包装远端 `key.enc`。忘记口令需要两台电脑一起删除本机 `one-sync/key` 与远端 `key.enc` 后重置。
- 正在被 DSH 写入的会话文件在 Windows 上可能短暂无法覆盖；该文件会被跳过，下次同步再试。
- 代码同步使用 Git 根目录自己的 `origin`；`stateRepo` 只用于 DSH 状态仓库。
