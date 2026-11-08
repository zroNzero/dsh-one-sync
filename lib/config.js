/**
 * 配置与本地状态路径。
 *
 * 设计约束（来自需求）：
 *   - 唯一的人类可编辑配置是 ~/.dsh/one-sync.json，字段为
 *     codeDir / stateRepo / token / passphrase（另带少量可选字段）。
 *   - 加密密钥缓存、同步基线、冲突备份都放在 ~/.dsh/one-sync/ 下，
 *     与配置文件分开：这些文件是插件内部状态，不需要用户手改。
 *
 * 本模块不访问网络，也不做任何同步动作；它只负责「可靠地读写配置」。
 */
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseRepo } from './rest.js'

export const CONFIG_FILE = 'one-sync.json'
export const STATE_DIR_NAME = 'one-sync'
export const BASELINE_FILE = 'state.json'
export const INDEX_FILE = 'index.json'
export const STATUS_FILE = 'status.json'
export const KEY_ENC_FILE = 'key.enc'
export const KEY_CACHE_FILE = 'key'
export const CONFLICTS_DIR_NAME = 'conflicts'

export const DEFAULT_CONFIG = Object.freeze({
  /** 需要随 Git 一起拉取/推送的代码目录；留空则只同步 DSH 状态。 */
  codeDir: '',
  /** 新设备尚无 .git 时用于初始化的代码仓库地址。 */
  codeRemote: '',
  /** 全局 DSH 状态仓库（只存 sessions/storages/memories，与代码仓库彻底分离）。 */
  stateRepo: '',
  /** fine-grained PAT（该仓库 Contents: read/write）或 classic PAT（repo）。 */
  token: '',
  /** 用于解开远端 key.enc 的同步口令；两台电脑必须一致。 */
  passphrase: '',
  /** 仓库分支；状态同步与代码同步共用。 */
  branch: 'main',
  /** 设备名，写入清单和提交信息；留空使用主机名。 */
  deviceName: '',
  /** 单文件上限（MB），避免把超大日志塞进 GitHub。 */
  maxFileMb: 45,
  /** 是否把主密钥缓存到本机（口令仍保存在配置里；默认开启）。 */
  rememberKey: true,
  /** 每轮对话结束后只推送加密状态；默认关闭。 */
  autoSync: false,
  /** 自动同步 debounce 秒数（2–60）。 */
  autoSyncDelaySec: 5,
  /** 自动同步模式；当前固定为 state-push。 */
  autoSyncMode: 'state-push',
  /** 预留：scrypt 参数，正常用户不需要改。 */
  kdf: null,
})

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
    this.code = 'config'
  }
}

/** $DSH_HOME，默认 ~/.dsh。DSH 本身也用这个环境变量。 */
export function resolveHome(explicitHome) {
  if (explicitHome) return resolve(String(explicitHome))
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

export function configPath(home) {
  return join(resolveHome(home), CONFIG_FILE)
}

/** 插件内部状态目录：~/.dsh/one-sync/ */
export function stateDir(home) {
  return join(resolveHome(home), STATE_DIR_NAME)
}

export function baselinePath(home) {
  return join(stateDir(home), BASELINE_FILE)
}

export function indexPath(home) {
  return join(stateDir(home), INDEX_FILE)
}

export function statusPath(home) {
  return join(stateDir(home), STATUS_FILE)
}

export function keyEncPath(home) {
  return join(stateDir(home), KEY_ENC_FILE)
}

export function keyCachePath(home) {
  return join(stateDir(home), KEY_CACHE_FILE)
}

export function conflictsDir(home) {
  return join(stateDir(home), CONFLICTS_DIR_NAME)
}

/**
 * 展开 ~ / ~\，但绝不把相对路径悄悄解析到进程 cwd。
 * 代码目录必须是绝对路径，否则换一个启动目录就会同步错项目。
 */
export function expandUserPath(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return join(homedir(), text.slice(2))
  }
  return text
}

export function normalizeCodeDir(value) {
  const expanded = expandUserPath(value)
  if (!expanded) return ''
  if (!isAbsolute(expanded)) {
    throw new ConfigError(`Workspace Root 必须是绝对路径（收到：${expanded}）`)
  }
  return resolve(expanded)
}

function normalizeBranch(value) {
  const branch = String(value == null ? '' : value).trim() || 'main'
  if (branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new ConfigError(`分支名不合法：${branch}`)
  }
  return branch
}

function normalizeMaxFileMb(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONFIG.maxFileMb
  return Math.max(1, Math.min(200, Math.round(n)))
}

function normalizeAutoSyncDelay(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.autoSyncDelaySec
  return Math.max(2, Math.min(60, Math.round(n)))
}

/** 把任意来源的对象收敛成合法配置；非法字段抛 ConfigError。 */
export function normalizeConfig(raw) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new ConfigError('配置文件内容必须是一个 JSON 对象')
  }
  const src = raw || {}
  // 兼容旧配置：历史版本把状态仓库叫 remote。
  const stateRepo = String(
    src.stateRepo != null ? src.stateRepo : (src.remote != null ? src.remote : ''),
  ).trim()
  const codeRemote = String(
    src.codeRemote != null
      ? src.codeRemote
      : (src.stateRepo != null && src.remote != null ? src.remote : ''),
  ).trim()
  if (stateRepo && !parseRepo(stateRepo)) {
    throw new ConfigError(
      `Encrypted Backup 不是可识别的 GitHub 仓库地址：${stateRepo}\n` +
      '示例：https://github.com/<用户名>/dsh-state.git 或 git@github.com:<用户名>/dsh-state.git',
    )
  }

  return {
    codeDir: normalizeCodeDir(src.codeDir),
    codeRemote,
    stateRepo,
    token: String(src.token == null ? '' : src.token).trim(),
    // 口令允许包含空格，只把 null/undefined 变成空串。
    passphrase: src.passphrase == null ? '' : String(src.passphrase),
    branch: normalizeBranch(src.branch),
    deviceName: String(src.deviceName == null ? '' : src.deviceName).trim(),
    maxFileMb: normalizeMaxFileMb(src.maxFileMb),
    rememberKey: src.rememberKey !== false,
    autoSync: src.autoSync === true,
    autoSyncDelaySec: normalizeAutoSyncDelay(src.autoSyncDelaySec),
    autoSyncMode: 'state-push',
    kdf: src.kdf && typeof src.kdf === 'object' ? src.kdf : null,
  }
}

/** 读取 ~/.dsh/one-sync.json；不存在时返回安全默认值。 */
export async function loadConfig(options = {}) {
  const file = configPath(options.home)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw new ConfigError(`读取配置失败：${file}：${(error && error.message) || error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(`配置文件不是合法 JSON：${file}`)
  }
  return normalizeConfig(parsed)
}

/**
 * 合并保存配置。
 *
 * 约定：
 *   - patch.token 省略或空串 => 保留已有 token（设置页无法回显明文，留空表示不改）；
 *     显式“清除”用 clearToken: true。
 *   - patch.passphrase 省略或空串 => 保留已有口令；首次设置时由设置页填写。
 */
export async function saveConfig(patch, options = {}) {
  const current = await loadConfig(options)
  const src = patch && typeof patch === 'object' ? patch : {}
  const next = { ...current }

  if (src.clearToken === true) next.token = ''
  for (const key of ['codeDir', 'codeRemote', 'stateRepo', 'branch', 'deviceName', 'maxFileMb', 'rememberKey', 'autoSync', 'autoSyncDelaySec', 'kdf']) {
    if (src[key] !== undefined) next[key] = src[key]
  }
  // 兼容旧调用/旧配置：remote 作为 stateRepo 的别名。
  if (src.stateRepo === undefined && src.remote !== undefined) next.stateRepo = src.remote
  // token 显式传入（包括空串）才覆盖；调用方要「留空不改」就不要把 token 放进 patch。
  if (typeof src.token === 'string') next.token = src.token.trim()
  if (typeof src.passphrase === 'string' && src.passphrase !== '') next.passphrase = src.passphrase

  const normalized = normalizeConfig(next)
  const file = configPath(options.home)
  await mkdirp(dirname(file))
  await writeFileAtomic(file, Buffer.from(JSON.stringify(normalized, null, 2) + '\n', 'utf8'))
  try { await fs.chmod(file, 0o600) } catch { /* Windows 上 chmod 基本无效 */ }
  return normalized
}

/** 同步前的硬性检查；返回中文错误列表（空数组表示通过）。 */
export function validateForSync(config) {
  const errors = []
  if (!config.stateRepo) {
    errors.push('未配置 Encrypted Backup')
  } else if (!parseRepo(config.stateRepo)) {
    errors.push(`Encrypted Backup 不是可识别的 GitHub 仓库地址：${config.stateRepo}`)
  }
  if (!config.token) {
    errors.push('未配置 GitHub Token（状态同步走 REST，必须有 Contents 读写权限）')
  }
  if (config.codeDir && !isAbsolute(config.codeDir)) {
    errors.push(`Workspace Root 必须是绝对路径：${config.codeDir}`)
  }
  return errors
}

/** 界面可见的配置：绝不返回 token / passphrase 明文。 */
export function publicConfig(config, options = {}) {
  return {
    codeDir: config.codeDir,
    codeRemote: config.codeRemote,
    stateRepo: config.stateRepo,
    hasStateRepo: Boolean(config.stateRepo),
    branch: config.branch,
    deviceName: config.deviceName,
    maxFileMb: config.maxFileMb,
    rememberKey: config.rememberKey,
    autoSync: config.autoSync,
    autoSyncDelaySec: config.autoSyncDelaySec,
    autoSyncMode: config.autoSyncMode,
    hasToken: Boolean(config.token),
    tokenMasked: maskToken(config.token),
    hasPassphrase: Boolean(config.passphrase),
    configPath: configPath(options.home),
    stateDir: stateDir(options.home),
  }
}

/** 便于人眼确认的 token 指纹；空 token 返回空串。 */
export function maskToken(token) {
  const text = String(token || '')
  if (!text) return ''
  if (text.length <= 10) return '••••••'
  return `${text.slice(0, 7)}…${text.slice(-4)}`
}

// ── 同步状态（界面展示用，非同步依据） ────────────────────────────────────

export async function readStatus(options = {}) {
  try {
    const text = await fs.readFile(statusPath(options.home), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeStatus(status, options = {}) {
  const file = statusPath(options.home)
  const body = {
    ...status,
    updatedAt: new Date().toISOString(),
  }
  await mkdirp(dirname(file))
  await writeFileAtomic(file, Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8'))
  return body
}

// ── 小工具 ───────────────────────────────────────────────────────────────

export async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/** 先写同目录临时文件再 rename；Windows 文件被占用时重试 5 次。 */
export async function writeFileAtomic(file, buffer) {
  await mkdirp(dirname(file))
  let current = null
  try {
    current = await fs.readFile(file)
  } catch {
    /* 目标不存在 */
  }
  if (current && Buffer.compare(current, buffer) === 0) return false

  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${attempt}.tmp`
    try {
      await fs.writeFile(tmp, buffer)
      await fs.rename(tmp, file)
      return true
    } catch (error) {
      lastError = error
      await fs.rm(tmp, { force: true }).catch(() => {})
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError
}
