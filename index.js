/**
 * dsh-one-sync —— Host 半身。
 *
 * 一次「一键同步」的顺序：
 *   1. Git Pull            在 Git 根目录拉取代码
 *   2. Pull State          拉取 DSH 状态密文 → 解密 → 与本地 workspace.json
 *                          做路径并集 → 从代码大仓补齐缺失的工作区目录
 *   3. Git Push            提交并推送本机新增代码（含刚补回的工作区）
 *   4. Push State          把并集后的状态加密上传；远端独有文件绝不删除
 *
 * 配置：~/.dsh/one-sync.json（codeDir / stateRepo / token / passphrase 等）。
 * 代码仓库与状态仓库彻底分离：codeDir 只表示当前工作区，代码 Git 操作会自动
 * 向上寻找 .git 根目录；stateRepo 只用于 DSH 状态同步。
 *
 * Web API（前缀 /dsh-one-sync/api）：
 *   GET  /status   运行状态（侧栏按钮与设置页轮询）
 *   GET  /config   读取配置（token/passphrase 不回显）
 *   POST /config   保存配置（口令会先用远端 key.enc 校验）
 *   POST /publish  把当前代码目录发布为新的 GitHub 私密仓库
 *   POST /migrate  把旧工作区移入大仓并改写 session 目录与 header
 *   POST /sync     执行一次完整同步
 */
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findGitRoot, runGit } from './lib/git.js'
import {
  ConfigError,
  baselinePath,
  configPath,
  indexPath,
  keyCachePath,
  keyEncPath,
  loadConfig,
  normalizeCodeDir,
  normalizeConfig,
  publicConfig,
  readStatus,
  saveConfig,
  stateDir,
  validateForSync,
  writeStatus,
} from './lib/config.js'
import { DEFAULT_KDF, unwrapKey } from './lib/crypto.js'
import { publishNewRepo } from './lib/github-publisher.js'
import { GithubRest } from './lib/rest.js'
import { migrateToMonorepo } from './lib/migrator.js'
import { RELEASE_REPO, previewRelease, releasePlugin } from './lib/release.js'
import { RestTransport, SyncError, createTimings, describePaths, deviceName, pullState, pushState } from './lib/sync-core.js'

export const name = 'dsh-one-sync'
export const inject = []

const API_PREFIX = '/dsh-one-sync/api'
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 180_000

/** 运行期状态，只用于界面展示；持久化副本在 ~/.dsh/one-sync/status.json。 */
const runtime = {
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  lastReport: null,
}

// ── 小工具 ───────────────────────────────────────────────────────────────

function messageOf(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

/** 任何回给界面的错误都不得带上 token / 口令。 */
function redact(text, config) {
  let out = String(text == null ? '' : text)
  const token = config && config.token
  const passphrase = config && config.passphrase
  if (token) out = out.split(token).join('***')
  if (passphrase) out = out.split(passphrase).join('***')
  return out
}

function logInfo(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(`[dsh-one-sync] ${message}`)
    else console.log(`[dsh-one-sync] ${message}`)
  } catch { /* 日志失败不影响主流程 */ }
}

async function hasFile(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function readFileOrNull(file) {
  try {
    return await fs.readFile(file)
  } catch {
    return null
  }
}

// ── 代码同步（lib/git.js） ───────────────────────────────────────────────

async function gitIn(codeDir, config, args, timeoutMs = GIT_TIMEOUT_MS) {
  // 有 token 时禁用系统 credential helper，确保 git 真的去调用 lib/git.js
  // 生成的 askpass，而不是命中 Windows 凭据管理器里的另一个账号。
  const finalArgs = config.token ? ['-c', 'credential.helper=', ...args] : args
  try {
    const result = await runGit(finalArgs, {
      cwd: codeDir,
      token: config.token,
      timeoutMs,
    })
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', error: messageOf(error).trim() }
  }
}

function missingRemoteRef(text) {
  return /couldn't find remote ref|no such ref|remote ref does not exist/i.test(String(text || ''))
}

function isConflictError(text) {
  return /conflict|could not apply|non-fast-forward|\[rejected\]|behind/i.test(String(text || ''))
}

/** Windows 路径大小写不敏感，避免把同一个根目录误判成嵌套。 */
function samePath(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** 返回 child 相对 root 的路径；不在 root 下时返回 null。 */
function relativeToRoot(root, child) {
  if (!root || !child) return null
  const rel = relative(resolve(root), resolve(child))
  if (!rel) return ''
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) {
    return null
  }
  return rel
}

/**
 * 远端 workspace.json 合并后，把本机缺失的工作区目录从代码大仓恢复出来。
 *
 * 1. 目录已在 → 不动；
 * 2. 大仓里有该路径的已跟踪文件 → git checkout 恢复；
 * 3. 大仓里没有（例如只建了空工作区）→ 创建空目录，避免 DSH 打开失败。
 *
 * 只读 checkout，不覆盖本机已有文件；任何一步失败都只记录，不阻断状态同步。
 */
export async function restoreWorkspaceDirs(config, gitRoot, branch, workspaces, say) {
  const result = {
    ok: true,
    checked: 0,
    restored: 0,
    created: 0,
    skipped: [],
    failed: [],
  }
  if (!gitRoot) {
    result.ok = false
    result.skipped.push({ reason: '当前没有可用的 Git 根目录' })
    return result
  }

  const refs = [branch, branch ? `origin/${branch}` : '', 'HEAD'].filter(Boolean)
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    const rawPath = workspace && workspace.path
    if (typeof rawPath !== 'string' || !rawPath || !isAbsolute(rawPath)) continue
    const abs = resolve(rawPath)
    const rel = relativeToRoot(gitRoot, abs)
    if (rel === null) {
      result.skipped.push({ path: abs, reason: '工作区不在当前代码大仓内' })
      continue
    }
    result.checked += 1
    if (!rel) continue // gitRoot 本身

    let stat = null
    try {
      stat = await fs.stat(abs)
    } catch {
      /* 目录不存在，继续恢复 */
    }
    if (stat && stat.isDirectory()) continue
    if (stat) {
      result.failed.push({ path: abs, reason: '同名路径已存在但不是文件夹' })
      continue
    }

    let lastError = ''
    let checkedOut = false
    const pathspec = rel.replace(/\\/g, '/')
    for (const ref of refs) {
      const checkout = await gitIn(gitRoot, config, ['checkout', ref, '--', pathspec])
      if (checkout.ok) {
        checkedOut = true
        break
      }
      lastError = checkout.error || lastError
    }

    let madeDir = false
    if (!checkedOut) {
      // 空目录无法进入 Git；创建它让 DSH 至少能打开工作区。
      // 如果有未跟踪文件占用同名路径，stat 早就命中，不会走到这里。
      try {
        await fs.mkdir(abs, { recursive: true })
        madeDir = true
      } catch (error) {
        result.failed.push({ path: abs, reason: messageOf(error) || lastError })
        continue
      }
    }

    try {
      const after = await fs.stat(abs)
      if (!after.isDirectory()) throw new Error('恢复后的路径不是文件夹')
    } catch (error) {
      result.failed.push({ path: abs, reason: messageOf(error) || lastError })
      continue
    }

    if (checkedOut) {
      result.restored += 1
      say(`已从代码大仓恢复工作区：${rel}`)
    } else if (madeDir) {
      result.created += 1
      say(`已创建空工作区目录（大仓中暂无此路径）：${rel}`)
    }
  }

  result.ok = result.failed.length === 0
  return result
}

async function prepareCodeRepo(config, say, options = {}) {
  if (!config.codeDir) return null
  const workspaceDir = resolve(config.codeDir)
  let stat
  try {
    stat = await fs.stat(workspaceDir)
  } catch {
    throw new SyncError('code', `Workspace Root 不存在：${workspaceDir}`)
  }
  if (!stat.isDirectory()) throw new SyncError('code', `Workspace Root 不是文件夹：${workspaceDir}`)

  // 关键：从当前工作区向上寻找 .git 根目录；后续所有 Git 命令都在 gitRoot 执行。
  const rootResult = await findGitRoot(workspaceDir, { token: config.token })
  if (!rootResult.ok || !rootResult.root) {
    throw new SyncError(
      'code',
      `当前工作区不在 Git 仓库中：${workspaceDir}\n` +
      `${rootResult.error || ''}\n` +
      '请把 Workspace Root 指向一个 Git 仓库。',
    )
  }
  const gitRoot = resolve(rootResult.root)
  const nested = !samePath(workspaceDir, gitRoot)
  if (nested && options.notify !== false && typeof say === 'function') {
    say(`检测到嵌套子工作区，自动在根目录 ${gitRoot} 进行同步`)
  }

  const branch = config.branch || 'main'
  const symbolic = await gitIn(gitRoot, config, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const currentBranch = symbolic.ok ? symbolic.stdout.trim() : ''
  if (currentBranch && currentBranch !== branch) {
    const error = new SyncError(
      'code',
      `Git 根目录当前在分支 ${currentBranch}，与设置里的分支 ${branch} 不一致。\n` +
      `根目录：${gitRoot}\n` +
      '请先切换分支，或在设置页把「分支」改成当前分支。',
    )
    error.gitRoot = gitRoot
    error.nested = nested
    throw error
  }
  if (!currentBranch) {
    const head = await gitIn(gitRoot, config, ['rev-parse', '--verify', 'HEAD'])
    if (head.ok) {
      const error = new SyncError(
        'code',
        `Git 根目录处于 detached HEAD，无法安全地 pull/push：${gitRoot}\n` +
        '请先切换到一个分支。',
      )
      error.gitRoot = gitRoot
      error.nested = nested
      throw error
    }
  }
  return { workspaceDir, gitRoot, branch, nested }
}

async function workspaceGitRoot(config) {
  if (!config.codeDir) return ''
  try {
    const root = await findGitRoot(resolve(config.codeDir), { token: config.token })
    return root.ok && root.root ? resolve(root.root) : ''
  } catch {
    return ''
  }
}

async function commitDirtyWorktree(gitRoot, config, say) {
  const status = await gitIn(gitRoot, config, ['status', '--porcelain'])
  if (!status.ok) throw new SyncError('code', `读取 Git 状态失败：${status.error}`)
  await assertWorktreeReady(gitRoot, config, status.stdout)
  if (!status.stdout.trim()) return false

  say('检测到未提交改动，先自动提交…')
  const add = await gitIn(gitRoot, config, ['add', '-A'])
  if (!add.ok) throw new SyncError('code', `git add 失败：${add.error}`)

  const commit = await gitIn(gitRoot, config, [
    '-c', 'user.name=dsh-one-sync',
    '-c', 'user.email=dsh-one-sync@localhost',
    'commit',
    '-m', `Auto-sync: ${new Date().toISOString()}`,
  ])
  if (!commit.ok) {
    if (/nothing to commit|no changes added/i.test(commit.error)) return false
    throw new SyncError('code', `自动提交失败：${commit.error}`)
  }
  return true
}

/** 有未解决的合并冲突或未完成的 rebase/merge 时，绝不自动 add/commit。 */
async function assertWorktreeReady(gitRoot, config, statusText) {
  if (/^(UU|AA|DD|AU|UA|DU|UD) /m.test(String(statusText || ''))) {
    throw new SyncError('code', 'Git 根目录存在未解决的合并冲突，请先处理完再同步。')
  }
  const gitDirResult = await gitIn(gitRoot, config, ['rev-parse', '--git-dir'])
  if (!gitDirResult.ok) return
  const raw = gitDirResult.stdout.trim()
  const gitDir = raw ? resolve(gitRoot, raw) : join(gitRoot, '.git')
  const markers = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ]
  for (const [file, label] of markers) {
    if (await hasFile(join(gitDir, file))) {
      throw new SyncError('code', `Git 根目录有未完成的 ${label} 操作，请先处理完再同步。`)
    }
  }
}

async function pullCode(config, say) {
  const prepared = await prepareCodeRepo(config, say)
  if (!prepared) return { ok: true, skipped: true, reason: '未配置 Workspace Root' }
  const { workspaceDir, gitRoot, branch, nested } = prepared

  try {
    const committed = await commitDirtyWorktree(gitRoot, config, say)

    say(`拉取代码（${gitRoot}，origin/${branch}）…`)
    const fastForward = await gitIn(gitRoot, config, ['pull', '--ff-only', 'origin', branch])
    let pulled = fastForward.ok
    let note = ''
    if (!fastForward.ok) {
      const rebase = await gitIn(gitRoot, config, ['pull', '--rebase', 'origin', branch])
      if (rebase.ok) {
        pulled = true
      } else {
        await gitIn(gitRoot, config, ['rebase', '--abort'])
        const combined = `${fastForward.error || ''}\n${rebase.error || ''}`
        if (missingRemoteRef(combined)) {
          note = '远端还没有该分支，跳过拉取（推送时会创建）'
          say(note)
        } else if (isConflictError(combined)) {
          throw new SyncError(
            'code',
            '代码产生冲突，已中止合并保护本地代码，请手动解决冲突后再试',
          )
        } else {
          throw new SyncError('code', `拉取代码失败：\n${combined.trim()}`)
        }
      }
    }

    return { ok: true, codeDir: workspaceDir, gitRoot, branch, nested, committed, pulled, note }
  } catch (error) {
    if (error instanceof SyncError) {
      error.gitRoot = gitRoot
      error.nested = nested
    }
    throw error
  }
}

async function pushCode(config, say) {
  const prepared = await prepareCodeRepo(config, say, { notify: false })
  if (!prepared) return { ok: true, skipped: true, reason: '未配置 Workspace Root' }
  const { workspaceDir, gitRoot, branch, nested } = prepared

  try {
    // 拉取状态期间用户可能又改了代码：推送前再兜底提交一次，保证工作树干净。
    await commitDirtyWorktree(gitRoot, config, say)

    say(`推送代码（${gitRoot}，origin/${branch}）…`)
    let pushed = await gitIn(gitRoot, config, ['push', 'origin', branch])
    let recovered = false
    if (!pushed.ok && /non-fast-forward|fetch first|\[rejected\]|behind/i.test(pushed.error || '')) {
      say('远端代码领先，先 rebase 再重试推送…')
      const rebase = await gitIn(gitRoot, config, ['pull', '--rebase', 'origin', branch])
      if (!rebase.ok) {
        await gitIn(gitRoot, config, ['rebase', '--abort'])
        throw new SyncError(
          'code',
          '代码产生冲突，已中止合并保护本地代码，请手动解决冲突后再试',
        )
      }
      pushed = await gitIn(gitRoot, config, ['push', 'origin', branch])
      recovered = true
    }
    if (!pushed.ok) throw new SyncError('code', `推送代码失败：\n${pushed.error}`)

    return { ok: true, codeDir: workspaceDir, gitRoot, branch, nested, pushed: true, recovered }
  } catch (error) {
    if (error instanceof SyncError) {
      error.gitRoot = gitRoot
      error.nested = nested
    }
    throw error
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────

/**
 * 一键同步。ctx 只要求可选的 status/success/error 回调，方便命令、HTTP、
 * 测试共用。返回结构化报告，供 Web API 原样回给界面。
 */
export async function onSync(ctx = {}, options = {}) {
  const mode = options.mode === 'state-push' ? 'state-push' : 'full'
  const status = typeof ctx.status === 'function' ? ctx.status : () => {}
  const success = typeof ctx.success === 'function' ? ctx.success : () => {}
  const fail = typeof ctx.error === 'function' ? ctx.error : () => {}
  const messages = []
  const say = (message) => {
    const text = String(message)
    messages.push(text)
    status(text)
  }

  if (runtime.syncing) {
    const text = '同步正在进行中，请稍后再试。'
    return { ok: false, busy: true, error: text, text, errors: [text], messages, timings: {} }
  }

  runtime.syncing = true
  const timings = createTimings()
  const syncStartedAt = performance.now()
  const report = {
    ok: false,
    at: new Date().toISOString(),
    mode,
    code: {},
    state: {},
    errors: [],
    messages,
    timings: {},
  }
  let config = null

  const finalize = async () => {
    report.ok = report.errors.length === 0
    timings.record('Total', performance.now() - syncStartedAt)
    report.timings = timings.snapshot()
    report.text = describeReport(report)
    runtime.lastSyncAt = report.at
    runtime.lastError = report.ok ? null : report.errors.join('；')
    runtime.lastReport = summarizeReport(report)
    await writeStatus({
      lastSyncAt: runtime.lastSyncAt,
      lastError: runtime.lastError,
      lastReport: runtime.lastReport,
    }).catch(() => {})

    if (report.ok) success(report.text)
    else fail(report.text)
    return report
  }

  try {
    config = await loadConfig()
    const validation = validateForSync(config)
    if (validation.length) throw new SyncError('config', validation.join('；'))

    if (mode === 'state-push') {
      say('加密上传状态…')
      let gitRoot = ''
      try {
        gitRoot = await workspaceGitRoot(config)
      } catch { /* 没有 Git 根目录时仍可上传状态 */ }
      try {
        report.state.push = await timings.measure(
          'State push',
          () => pushState(config, { log: say, gitRoot, timings }),
        )
      } catch (error) {
        report.state.push = {
          ok: false,
          code: error && error.code ? error.code : 'state',
          error: redact(messageOf(error), config),
        }
        report.errors.push('状态上传：' + report.state.push.error)
      }
      return await finalize()
    }

    // 1. Git Pull
    say('1/4 拉取代码…')
    try {
      report.code.pull = await timings.measure('Git pull', () => pullCode(config, say))
    } catch (error) {
      report.code.pull = {
        ok: false,
        code: error && error.code ? error.code : 'code',
        error: redact(messageOf(error), config),
        gitRoot: error && error.gitRoot ? error.gitRoot : '',
        nested: Boolean(error && error.nested),
      }
      report.errors.push('代码拉取：' + report.code.pull.error)
    }

    // 2. 拉取状态、合并工作区，并从代码大仓补齐缺失目录
    const gitRoot = (report.code.pull && report.code.pull.gitRoot) || ''
    const branch = (report.code.pull && report.code.pull.branch) || config.branch || 'main'
    const codeUsable = !config.codeDir || Boolean(report.code.pull && report.code.pull.ok !== false)
    say('2/4 拉取 DSH 状态、合并工作区并补齐缺失目录…')
    try {
      report.state.pull = await timings.measure('State pull', () => pullState(config, {
        log: say,
        gitRoot,
        branch,
        timings,
        ensureWorkspaceDirs: async ({ workspaces }) => {
          if (!codeUsable || !gitRoot) {
            return {
              ok: true,
              skipped: true,
              reason: '代码拉取未成功或未配置 Workspace Root',
              checked: 0,
              restored: 0,
              created: 0,
              failed: [],
            }
          }
          return restoreWorkspaceDirs(config, gitRoot, branch, workspaces, say)
        },
      }))
      if (report.state.pull.skipped && report.state.pull.skipped.length) {
        say(`状态拉取：${report.state.pull.skipped.length} 个文件跳过（详见同步结果）`)
      }
    } catch (error) {
      report.state.pull = {
        ok: false,
        code: error && error.code ? error.code : 'state',
        error: redact(messageOf(error), config),
      }
      report.errors.push('状态拉取：' + report.state.pull.error)
    }

    // 3. Git Push
    if (report.code.pull && report.code.pull.ok === false) {
      report.code.push = { ok: true, skipped: true, reason: '代码拉取失败，已跳过推送' }
      say('代码拉取失败，跳过代码推送')
    } else if (!config.codeDir) {
      report.code.push = { ok: true, skipped: true, reason: '未配置 Workspace Root' }
      say('Workspace Root 为空，跳过代码推送')
    } else {
      say('3/4 提交并推送代码…')
      try {
        report.code.push = await timings.measure('Git push', () => pushCode(config, say))
      } catch (error) {
        report.code.push = {
          ok: false,
          code: error && error.code ? error.code : 'code',
          error: redact(messageOf(error), config),
          gitRoot: error && error.gitRoot ? error.gitRoot : '',
          nested: Boolean(error && error.nested),
        }
        report.errors.push('代码推送：' + report.code.push.error)
      }
    }

    // 4. 只有拉取成功才上传：否则本机版本可能覆盖远端刚创建、尚未拉下来的
    // 会话/工作区，违背「绝对并集、互不覆盖」。
    const stateBlocked = report.state.pull && report.state.pull.ok === false
    if (stateBlocked) {
      report.state.push = {
        ok: true,
        skipped: true,
        reason: '状态拉取失败，已跳过上传以保护远端数据',
      }
      say('状态拉取失败，跳过状态上传')
    } else {
      say('4/4 加密并上传 DSH 状态…')
      try {
        report.state.push = await timings.measure(
          'State push',
          () => pushState(config, { log: say, gitRoot, timings }),
        )
      } catch (error) {
        report.state.push = {
          ok: false,
          code: error && error.code ? error.code : 'state',
          error: redact(messageOf(error), config),
        }
        report.errors.push('状态上传：' + report.state.push.error)
      }
    }

    return await finalize()
  } catch (error) {
    const text = redact(messageOf(error), config)
    report.ok = false
    report.error = text
    timings.record('Total', performance.now() - syncStartedAt)
    report.timings = timings.snapshot()
    const timingText = formatTimings(report.timings)
    report.text = `同步失败：${text}${timingText ? `；耗时：${timingText}` : ''}`
    report.errors.push(text)
    runtime.lastSyncAt = report.at
    runtime.lastError = text
    runtime.lastReport = summarizeReport(report)
    await writeStatus({
      lastSyncAt: runtime.lastSyncAt,
      lastError: runtime.lastError,
      lastReport: runtime.lastReport,
    }).catch(() => {})
    fail(report.text)
    return report
  } finally {
    runtime.syncing = false
  }
}

const TIMING_ORDER = [
  'Git pull',
  'State pull',
  'Git push',
  'State push',
  'State scan',
  'State prepare',
  'State encrypt',
  'Upload',
  'Pull snapshot',
  'Pull prepare',
  'Prefetch',
  'Total',
]

function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) return ''
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  return `${seconds.toFixed(seconds >= 10 || Number.isInteger(seconds) ? 0 : 1)}s`
}

function formatTimings(timings) {
  if (!timings || typeof timings !== 'object') return ''
  const names = TIMING_ORDER.filter((name) => Object.prototype.hasOwnProperty.call(timings, name))
  for (const name of Object.keys(timings)) {
    if (!names.includes(name)) names.push(name)
  }
  return names
    .map((name) => `${name}: ${formatDuration(timings[name])}`)
    .filter((text) => !text.endsWith(': '))
    .join(' / ')
}

function describeReport(report) {
  const parts = []

  if (report.mode !== 'state-push') {
    const codePull = report.code && report.code.pull
    const codePush = report.code && report.code.push
    if (codePull && codePull.nested && codePull.gitRoot) {
      parts.push(`检测到嵌套子工作区，自动在根目录 ${codePull.gitRoot} 进行同步`)
    }
    if (codePull && codePull.skipped) {
      parts.push('代码：未配置')
    } else if (codePull && codePull.ok === false) {
      parts.push('代码：拉取失败')
    } else {
      const bits = []
      if (codePull && codePull.committed) bits.push('已提交本地改动')
      if (codePull && codePull.pulled) bits.push('已拉取')
      if (codePush && codePush.pushed) bits.push('已推送')
      if (codePush && codePush.skipped) bits.push(codePush.reason || '跳过推送')
      if (codePush && codePush.ok === false) bits.push('推送失败')
      parts.push('代码：' + (bits.join(' / ') || '无变化'))
    }
  }

  const statePull = report.state && report.state.pull
  const statePush = report.state && report.state.push
  const stateBits = []
  if (statePull && statePull.ok === false) {
    stateBits.push('拉取失败')
  } else if (statePull) {
    stateBits.push(`拉取 ${statePull.applied || 0} 文件`)
    if (statePull.workspaces) stateBits.push(`工作区并集 ${statePull.workspaces}`)
    const restore = statePull.workspaceRestore
    if (restore) {
      if (restore.restored) stateBits.push(`恢复目录 ${restore.restored}`)
      if (restore.created) stateBits.push(`新建空目录 ${restore.created}`)
      if (restore.failed && restore.failed.length) stateBits.push(`目录失败 ${restore.failed.length}`)
    }
    if (statePull.conflicts && statePull.conflicts.length) {
      const first = statePull.conflicts[0]
      const detail = first && (first.reason || first.remoteCopy || first.backup)
      stateBits.push(`冲突 ${statePull.conflicts.length}${detail ? '（' + detail + '）' : ''}`)
    }
    if (statePull.keptLocal && statePull.keptLocal.length) stateBits.push(`保留本机 ${statePull.keptLocal.length}`)
  }
  if (statePush && statePush.ok === false) {
    stateBits.push('上传失败')
  } else if (statePush) {
    if (statePush.pushed) {
      stateBits.push(`上传 ${statePush.uploaded || 0} 个变更`)
      if (statePush.preservedRemote) stateBits.push(`保留远端独有 ${statePush.preservedRemote}`)
      if (Array.isArray(statePush.skipped) && statePush.skipped.length) {
        stateBits.push(`跳过 ${statePush.skipped.length} 个文件`)
      }
    } else if (statePush.skipped === true) {
      stateBits.push(statePush.reason || '跳过上传')
    } else {
      stateBits.push('已是最新')
      if (statePush.preservedRemote) stateBits.push(`保留远端独有 ${statePush.preservedRemote}`)
      if (Array.isArray(statePush.skipped) && statePush.skipped.length) {
        stateBits.push(`跳过 ${statePush.skipped.length} 个文件`)
      }
    }
    if (statePush.migrated) stateBits.push(`迁移旧会话目录 ${statePush.migrated}`)
    if (statePush.deleted) stateBits.push(`删除 ${statePush.deleted}`)
  }
  if (stateBits.length) parts.push('状态：' + stateBits.join('，'))

  const timingText = formatTimings(report.timings)
  if (timingText) parts.push('耗时：' + timingText)

  if (report.errors && report.errors.length) parts.push('错误：' + report.errors[0])
  return (report.ok ? '同步完成：' : '同步未完全成功：') + parts.join('；')
}

function summarizeReport(report) {
  const pull = report.state && report.state.pull
  const push = report.state && report.state.push
  return {
    at: report.at,
    ok: report.ok,
    mode: report.mode || 'full',
    timings: report.timings || {},
    code: {
      pull: report.code && report.code.pull
        ? {
          ok: report.code.pull.ok,
          skipped: Boolean(report.code.pull.skipped),
          committed: Boolean(report.code.pull.committed),
          pulled: Boolean(report.code.pull.pulled),
          branch: report.code.pull.branch || '',
          gitRoot: report.code.pull.gitRoot || '',
          nested: Boolean(report.code.pull.nested),
        }
        : null,
      push: report.code && report.code.push
        ? {
          ok: report.code.push.ok,
          skipped: Boolean(report.code.push.skipped),
          pushed: Boolean(report.code.push.pushed),
          branch: report.code.push.branch || '',
          gitRoot: report.code.push.gitRoot || '',
          nested: Boolean(report.code.push.nested),
        }
        : null,
    },
    state: {
      pull: pull
        ? {
          ok: pull.ok !== false,
          applied: pull.applied || 0,
          unchanged: pull.unchanged || 0,
          workspaces: pull.workspaces || 0,
          workspaceRestore: pull.workspaceRestore
            ? {
              ok: pull.workspaceRestore.ok !== false,
              skipped: Boolean(pull.workspaceRestore.skipped),
              restored: pull.workspaceRestore.restored || 0,
              created: pull.workspaceRestore.created || 0,
              failed: Array.isArray(pull.workspaceRestore.failed) ? pull.workspaceRestore.failed.length : 0,
            }
            : null,
          conflicts: Array.isArray(pull.conflicts) ? pull.conflicts.length : 0,
          keptLocal: Array.isArray(pull.keptLocal) ? pull.keptLocal.length : 0,
          skipped: Array.isArray(pull.skipped) ? pull.skipped.length : 0,
        }
        : null,
      push: push
        ? {
          ok: push.ok !== false,
          skipped: Array.isArray(push.skipped) ? push.skipped.length : (push.skipped === true ? 1 : 0),
          pushed: Boolean(push.pushed),
          uploaded: push.uploaded || 0,
          deleted: push.deleted || 0,
          migrated: push.migrated || 0,
          preservedRemote: push.preservedRemote || 0,
          files: push.files || 0,
          unchanged: Boolean(push.unchanged),
        }
        : null,
    },
    errors: Array.isArray(report.errors) ? report.errors.slice(0, 20) : [],
  }
}

// ── 状态快照 ─────────────────────────────────────────────────────────────

export async function statusSnapshot() {
  let config = null
  let configError = ''
  try {
    config = await loadConfig()
  } catch (error) {
    configError = redact(messageOf(error), null)
  }

  const persisted = await readStatus()
  const paths = describePaths()
  const cachedKey = await readFileOrNull(keyCachePath())
  const hasKeyCache = Boolean(cachedKey && cachedKey.length === 32)
  const hasKeyEnc = await hasFile(keyEncPath())

  return {
    ok: true,
    plugin: name,
    configured: Boolean(config && config.stateRepo && config.token),
    busy: runtime.syncing,
    configError: configError || null,
    config: config ? publicConfig(config) : null,
    configPath: configPath(),
    stateDir: stateDir(),
    ...paths,
    hasKey: hasKeyCache || hasKeyEnc,
    hasKeyCache,
    hasKeyEnc,
    device: config ? deviceName(config) : '',
    branch: config ? config.branch : 'main',
    lastSyncAt: runtime.lastSyncAt || persisted.lastSyncAt || null,
    lastError: runtime.lastError || persisted.lastError || null,
    lastReport: runtime.lastReport || persisted.lastReport || null,
    timings: (runtime.lastReport && runtime.lastReport.timings)
      || (persisted.lastReport && persisted.lastReport.timings)
      || null,
    api: {
      status: `${API_PREFIX}/status`,
      config: `${API_PREFIX}/config`,
      sync: `${API_PREFIX}/sync`,
      migrate: `${API_PREFIX}/migrate`,
    },
  }
}

// ── 配置保存（含口令校验） ───────────────────────────────────────────────

async function localKeyEnc() {
  return readFileOrNull(keyEncPath())
}

/**
 * 保存前校验口令：
 *   - 优先用远端 key.enc（新仓库/另一台电脑）；
 *   - 远端不可达或远端还没有 key.enc 时，按 allowLocalFallback 决定是否退回本机 key.enc；
 *   - 两处都没有 key.enc → 视为首次设置，直接接受。
 */
async function verifyPassphrase(config, passphrase, options = {}) {
  const allowLocalFallback = options.allowLocalFallback !== false
  let keyEncBuffer = null
  let warning = ''

  if (config.stateRepo && config.token) {
    try {
      const transport = new RestTransport(config, () => {})
      await transport.ensureRepo()
      const snapshot = await transport.snapshot()
      if (snapshot.files.has('key.enc')) {
        keyEncBuffer = await transport.read('key.enc')
      }
    } catch (error) {
      warning = '暂时无法连接远端校验口令（' + redact(messageOf(error), config) + '），' +
        (allowLocalFallback ? '已用本机密钥校验。' : '已跳过校验，首次同步会再次校验。')
    }
  }
  if (!keyEncBuffer && allowLocalFallback) keyEncBuffer = await localKeyEnc()
  if (!keyEncBuffer) return { status: 'no-key', warning }

  try {
    unwrapKey(keyEncBuffer, passphrase, { ...DEFAULT_KDF, ...(config.kdf || {}) })
    return { status: 'ok', warning }
  } catch {
    return { status: 'bad', warning }
  }
}

/** 切换状态仓库后，旧仓库的 key.enc / 主密钥缓存 / 基线都不再适用。 */
async function resetLocalState() {
  await Promise.all([
    fs.rm(keyCachePath(), { force: true }).catch(() => {}),
    fs.rm(keyEncPath(), { force: true }).catch(() => {}),
    fs.rm(baselinePath(), { force: true }).catch(() => {}),
    fs.rm(indexPath(), { force: true }).catch(() => {}),
  ])
}

export async function initializeFromBody(body = {}) {
  const src = body && typeof body === 'object' ? body : {}
  const current = await loadConfig().catch(() => null)
  const token = String(src.token || (current && current.token) || '').trim()
  if (!token) return { ok: false, error: '请先填写 GitHub Token' }

  const passphrase = typeof src.passphrase === 'string' && src.passphrase !== ''
    ? src.passphrase
    : String((current && current.passphrase) || '')
  if (!passphrase) return { ok: false, error: '请填写加密口令' }

  const branch = String(src.branch || (current && current.branch) || 'main').trim() || 'main'
  let stateRepo = String(src.stateRepo || '').trim()
  const codeInput = String(src.codeDir || '').trim()
  let codeDir = codeInput || join(homedir(), 'Documents', 'DSH_Workspace')

  try {
    codeDir = normalizeCodeDir(codeDir)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }

  try {
    const userRest = new GithubRest({
      remote: stateRepo || 'https://github.com/unknown/unknown.git',
      token,
      branch,
    }, () => {})
    const user = await userRest.request('GET', '/user')
    const login = user && user.login
    if (!login) return { ok: false, error: '无法获取 GitHub 用户名' }
    if (!stateRepo) stateRepo = `https://github.com/${login}/dsh-state.git`

    await fs.mkdir(codeDir, { recursive: true })
    const stat = await fs.stat(codeDir)
    if (!stat.isDirectory()) return { ok: false, error: '工作区路径不是文件夹' }

    const repoRest = new GithubRest({ remote: stateRepo, token, branch }, () => {})
    let createdRepo = false
    if (!(await repoRest.repoExists())) {
      await repoRest.createRepo()
      createdRepo = true
    }

    const result = await saveConfigFromBody({
      ...src,
      codeDir,
      stateRepo,
      token,
      passphrase,
      branch,
      autoSync: true,
      autoSyncDelaySec: src.autoSyncDelaySec === undefined
        ? (current && current.autoSyncDelaySec)
        : src.autoSyncDelaySec,
    })
    if (!result.ok) return result
    return {
      ...result,
      initialized: true,
      login,
      createdRepo,
      defaults: { stateRepo, codeDir },
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

async function saveConfigFromBody(body) {
  const src = body && typeof body === 'object' ? body : {}
  const current = await loadConfig()

  const candidateRaw = { ...current }
  for (const key of ['codeDir', 'stateRepo', 'branch', 'deviceName', 'maxFileMb', 'rememberKey', 'autoSync', 'autoSyncDelaySec']) {
    if (src[key] !== undefined) candidateRaw[key] = src[key]
  }
  // 兼容旧设置页/旧脚本仍提交 remote 的情况。
  if (src.stateRepo === undefined && src.remote !== undefined) candidateRaw.stateRepo = src.remote
  if (src.clearToken === true) candidateRaw.token = ''
  else if (typeof src.token === 'string' && src.token.trim()) candidateRaw.token = src.token.trim()
  const passphrase = typeof src.passphrase === 'string' && src.passphrase !== ''
    ? src.passphrase
    : null
  if (passphrase !== null) candidateRaw.passphrase = passphrase

  let candidate
  try {
    candidate = normalizeConfig(candidateRaw)
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, error: error.message }
    throw error
  }

  const stateRepoChanged = candidate.stateRepo !== current.stateRepo
  let warning = ''
  if (passphrase !== null) {
    const verdict = await verifyPassphrase(candidate, passphrase, { allowLocalFallback: !stateRepoChanged })
    if (verdict.status === 'bad') {
      return {
        ok: false,
        error: '这个口令无法解密备份。请确认两台电脑使用同一口令；' +
          '如果忘记口令，需要两台电脑一起重置密钥。',
      }
    }
    if (verdict.warning) warning = verdict.warning
  }

  const saved = await saveConfig({
    codeDir: candidate.codeDir,
    stateRepo: candidate.stateRepo,
    token: candidate.token,
    passphrase: candidate.passphrase,
    branch: candidate.branch,
    deviceName: candidate.deviceName,
    maxFileMb: candidate.maxFileMb,
    rememberKey: candidate.rememberKey,
    autoSync: candidate.autoSync,
    autoSyncDelaySec: candidate.autoSyncDelaySec,
    kdf: candidate.kdf,
  })

  if (stateRepoChanged) {
    await resetLocalState()
    warning = [
      warning,
      'Encrypted Backup 已变更：已清除本机旧密钥缓存与同步基线，下次同步会重新解锁。',
    ].filter(Boolean).join(' ')
  }

  return {
    ok: true,
    config: publicConfig(saved),
    warning: warning || null,
    stateRepoChanged,
    passphraseStatus: passphrase === null ? 'unchanged' : 'saved',
  }
}

// ── HTTP 路由 ────────────────────────────────────────────────────────────

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body == null ? null : body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new SyncError('request', '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SyncError('request', '请求体不是合法 JSON')
  }
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/**
 * 拒绝跨站请求：带 Origin 的请求必须与 Host 同源。
 * 同源页面/Electron（Origin: null）放行，避免影响正常 GUI。
 */
function requestTrusted(req) {
  const headers = req && req.headers ? req.headers : {}
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    const host = String(headers.host || '').toLowerCase()
    return Boolean(host) && parsed.host.toLowerCase() === host
  } catch {
    return false
  }
}

function installRoutes(webCtx) {
  const disposers = []

  // DSH webserver 的 exact 路由表按 path 建键：同一路径只能注册一次。
  // 因此每个 path 只注册一个 handler，在 handler 内按 HTTP method 分发。
  const install = (path, methods) => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (!requestTrusted(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return undefined
        }
        const actual = String(req.method || 'GET').toUpperCase()
        const handler = methods[actual] || (actual === 'HEAD' ? methods.GET : undefined)
        if (typeof handler !== 'function') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return undefined
        }
        return Promise.resolve()
          .then(() => handler(req, res))
          .catch((error) => {
            try {
              sendJson(res, 400, { ok: false, error: redact(messageOf(error), null) })
            } catch { /* 响应已结束 */ }
          })
      },
    })
    disposers.push(dispose)
  }

  install(`${API_PREFIX}/status`, {
    GET: async (_req, res) => {
      sendJson(res, 200, await statusSnapshot())
    },
  })

  install(`${API_PREFIX}/config`, {
    GET: async (_req, res) => {
      try {
        const config = await loadConfig()
        sendJson(res, 200, {
          ok: true,
          config: publicConfig(config),
          status: await statusSnapshot(),
        })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          config: null,
          error: redact(messageOf(error), null),
          status: await statusSnapshot().catch(() => null),
        })
      }
    },
    POST: async (req, res) => {
      const body = await readJsonBody(req)
      const result = await saveConfigFromBody(body)
      sendJson(res, result.ok ? 200 : 400, result)
    },
  })

  install(`${API_PREFIX}/init`, {
    POST: async (req, res) => {
      const body = await readJsonBody(req)
      const result = await initializeFromBody(body)
      sendJson(res, result.ok ? 200 : 400, result)
    },
  })

  // 只把 codeDir 发布为一个全新的 GitHub 私密代码仓库；
  // 不修改 stateRepo（DSH 状态仓库与代码仓库彻底分离）。
  install(`${API_PREFIX}/publish`, {
    POST: async (req, res) => {
      const body = await readJsonBody(req)
      const repoName = typeof body.repoName === 'string' ? body.repoName.trim() : ''

      let config
      try {
        config = await loadConfig()
      } catch (error) {
        sendJson(res, 400, { ok: false, error: redact(messageOf(error), null) })
        return
      }
      if (!config.codeDir) {
        sendJson(res, 400, { ok: false, error: '请先在设置中填写 Workspace Root。' })
        return
      }
      if (!config.token) {
        sendJson(res, 400, { ok: false, error: '请先在设置中填写 GitHub Token。' })
        return
      }
      if (!repoName) {
        sendJson(res, 400, { ok: false, error: '请输入新仓库名称。' })
        return
      }

      try {
        const result = await publishNewRepo({
          dir: config.codeDir,
          repoName,
          token: config.token,
          private: true,
          branch: config.branch,
          log: (message) => logInfo(null, message),
        })
        sendJson(res, 200, {
          ...result,
          ok: true,
          text: `已发布到 ${result.htmlUrl}；代码仓库与 Encrypted Backup 已分离，备份配置未修改。`,
        })
      } catch (error) {
        const message = redact(messageOf(error), config)
        sendJson(res, 400, {
          ok: false,
          error: message,
          code: error && error.code ? error.code : 'publish',
          owner: error && error.owner ? error.owner : undefined,
          repo: error && error.repo ? error.repo : undefined,
          repoUrl: error && error.repoUrl ? error.repoUrl : undefined,
          htmlUrl: error && error.htmlUrl ? error.htmlUrl : undefined,
          commit: error && error.commit ? error.commit : undefined,
          pushed: false,
        })
      }
    },
  })

  // 把旧工作区收编进大仓：移动目录 + 重映射 sessions key + 改写 header.cwd。
  install(`${API_PREFIX}/migrate`, {
    POST: async (req, res) => {
      const body = await readJsonBody(req)
      const targetRoot = typeof body.targetRoot === 'string' ? body.targetRoot.trim() : ''
      const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : ''
      const bodyToken = typeof body.token === 'string' ? body.token.trim() : ''

      let config = null
      try {
        config = await loadConfig()
      } catch {
        /* 配置读不到时仍允许使用请求体里的 token 做 clone */
      }
      const token = bodyToken || (config && config.token) || ''

      if (!targetRoot) {
        sendJson(res, 400, { ok: false, error: '请填写目标代码大仓根目录（targetRoot）。' })
        return
      }

      try {
        const report = await migrateToMonorepo({
          targetRoot,
          token,
          repoUrl,
          log: (message) => logInfo(null, message),
        })
        if (!report.ok) {
          sendJson(res, 400, {
            ...report,
            error: report.text || '迁移未完成',
            text: report.text || '迁移未完成',
          })
          return
        }
        sendJson(res, 200, {
          ...report,
          ok: true,
          text: report.moved.length > 0
            ? '迁移完成，建议立即执行一键同步并重启 DSH'
            : (report.text || '没有需要收编的旧工作区。'),
        })
      } catch (error) {
        const message = redact(messageOf(error), { token })
        sendJson(res, 400, {
          ok: false,
          error: message,
          text: `迁移失败：${message}`,
          code: error && error.code ? error.code : 'migrate',
        })
      }
    },
  })

  install(`${API_PREFIX}/release/preview`, {
    POST: async (req, res) => {
      const body = await readJsonBody(req)
      let config
      try {
        config = await loadConfig()
      } catch (error) {
        sendJson(res, 400, { ok: false, error: redact(messageOf(error), null) })
        return
      }
      try {
        const result = await previewRelease({
          sourceDir: PLUGIN_DIR,
          repo: RELEASE_REPO,
          bump: body.bump,
          token: config.token,
          notes: body.notes,
        })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: redact(messageOf(error), config),
          code: error && error.code ? error.code : 'release',
        })
      }
    },
  })

  install(`${API_PREFIX}/release/run`, {
    POST: async (req, res) => {
      const body = await readJsonBody(req)
      let config
      try {
        config = await loadConfig()
      } catch (error) {
        sendJson(res, 400, { ok: false, error: redact(messageOf(error), null) })
        return
      }
      try {
        const result = await releasePlugin({
          sourceDir: PLUGIN_DIR,
          repo: RELEASE_REPO,
          bump: body.bump,
          token: config.token,
          notes: body.notes,
          confirm: body.confirm === true,
        })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: redact(messageOf(error), config),
          code: error && error.code ? error.code : 'release',
        })
      }
    },
  })

  install(`${API_PREFIX}/sync`, {
    POST: async (req, res) => {
      // 主动读完请求体：body 很小，但留着不读会让部分 HTTP 客户端复用连接时出问题。
      await readJsonBody(req).catch(() => {})
      const result = await onSync({
        status: () => {},
        success: () => {},
        error: () => {},
      })
      sendJson(res, 200, result)
    },
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* 已卸载 */ }
    }
  }
}

// ── 插件入口 ─────────────────────────────────────────────────────────────

export function apply(ctx) {
  const mount = (webCtx) => {
    webCtx.effect(
      () => installRoutes(webCtx),
      'dsh-one-sync: http routes',
    )
    logInfo(ctx, `HTTP API 已挂载：${API_PREFIX}（配置 ${configPath()}）`)
  }

  let autoTimer = null
  let autoMaxTimer = null
  let autoQueued = false
  let autoRunning = false
  let autoFailures = 0
  let autoBackoffUntil = 0
  let autoScheduleSeq = 0

  function clearAutoTimers() {
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    if (autoMaxTimer) {
      clearTimeout(autoMaxTimer)
      autoMaxTimer = null
    }
  }

  function setAutoTimer(delay) {
    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      autoTimer = null
      runAutoSync()
    }, Math.max(50, delay))
  }

  async function queueAutoSync() {
    const seq = ++autoScheduleSeq
    let config
    try {
      config = await loadConfig()
    } catch {
      return
    }
    if (seq !== autoScheduleSeq || !config.autoSync) return
    if (runtime.syncing || autoRunning) {
      autoQueued = true
      setAutoTimer(1000)
      return
    }
    const now = Date.now()
    if (now < autoBackoffUntil) {
      setAutoTimer(Math.min(600000, autoBackoffUntil - now))
      return
    }
    const delay = Math.max(2, Math.min(60, Number(config.autoSyncDelaySec) || 5)) * 1000
    setAutoTimer(delay)
    if (!autoMaxTimer) {
      autoMaxTimer = setTimeout(() => {
        autoMaxTimer = null
        runAutoSync()
      }, 30000)
    }
  }

  async function runAutoSync() {
    if (autoRunning) {
      autoQueued = true
      return
    }
    if (runtime.syncing) {
      autoQueued = true
      setAutoTimer(1000)
      return
    }
    clearAutoTimers()
    let config
    try {
      config = await loadConfig()
    } catch {
      return
    }
    if (!config.autoSync) return
    const now = Date.now()
    if (now < autoBackoffUntil) {
      setAutoTimer(Math.min(600000, autoBackoffUntil - now))
      return
    }

    autoQueued = false
    autoRunning = true
    try {
      const report = await onSync({
        status: (message) => logInfo(ctx, message),
        success: (message) => logInfo(ctx, message),
        error: (message) => logInfo(ctx, message),
      }, { mode: 'state-push' })
      if (report && report.busy) {
        autoQueued = true
        setAutoTimer(1000)
      } else if (report && report.ok) {
        autoFailures = 0
        autoBackoffUntil = 0
      } else {
        autoFailures += 1
        const waits = [30000, 120000, 600000]
        autoBackoffUntil = Date.now() + waits[Math.min(autoFailures - 1, waits.length - 1)]
      }
    } catch {
      autoFailures += 1
      const waits = [30000, 120000, 600000]
      autoBackoffUntil = Date.now() + waits[Math.min(autoFailures - 1, waits.length - 1)]
    } finally {
      autoRunning = false
    }
    if (autoQueued) {
      autoQueued = false
      queueAutoSync()
    }
  }

  ctx.effect(function () {
    if (typeof ctx.on !== 'function') return function () {}
    const off = ctx.on('session/event', (_session, event) => {
      if (event && event.type === 'turn/end') {
        queueAutoSync().catch(() => {})
      }
    })
    return function () {
      autoScheduleSeq += 1
      if (typeof off === 'function') off()
      clearAutoTimers()
    }
  }, 'dsh-one-sync: auto sync')

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      mount(webCtx)
    })
  } else if (typeof ctx.get === 'function') {
    const webServer = ctx.get('webServer')
    if (webServer) mount(ctx)
  }

  logInfo(
    ctx,
    `已启用；状态目录 ${stateDir()}，配置 ${configPath()}。` +
    ' 左侧栏按钮与设置页由 client.js 提供。',
  )
}
