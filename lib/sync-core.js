/**
 * 状态同步核心。
 *
 * 职责边界：
 *   - 扫描 $DSH_HOME 下的 sessions / storages / memories；
 *   - 用 lib/crypto.js 的 encryptFile（确定性 IV）逐文件加密；
 *   - 用 lib/rest.js 的 Git Data API（commitFiles 等）做增量上传；
 *   - 拉取时用 decryptFile 解密，并按三方基线做保守合并；
 *   - 远端传输通过 RestTransport 适配，不需要 refer/sync-mh.js 里的
 *     client.getBranchHead / createBlob 等旧接口。
 *
 * 仓库布局（单仓库，状态与代码互不干扰）：
 *   key.enc                          passphrase 包装后的主密钥
 *   state/manifest.json              加密文件的清单（明文 JSON，只含路径/哈希/尺寸）
 *   state/sessions/<rel>.dshx        会话文件密文
 *   state/storages/<rel>.dshx
 *   state/memories/<rel>.dshx
 *
 * 本机状态目录（不入库）：
 *   ~/.dsh/one-sync/key              主密钥缓存
 *   ~/.dsh/one-sync/key.enc          远端 key.enc 的本机副本
 *   ~/.dsh/one-sync/state.json       上次拉取/推送后的基线清单
 *   ~/.dsh/one-sync/conflicts/       覆盖本机文件前的备份
 *
 * 合并规则（pull 时逐文件）：
 *   base = state.json 里该文件的 sha256；local = 本机现状；remote = 远端清单
 *   - local == remote                 → 不变
 *   - local == base                    → 采用远端（本机没改）
 *   - remote == base                   → 保留本机（对方没改）
 *   - 两边都改                         → 修改时间新者胜；本机较新则保留本机
 *   - 没有 base（首次拉取）            → 远端时间戳比本机新才覆盖，且先备份本机
 *
 * 安全：
 *   - 所有上传的 DSH 状态文件都先 encryptFile 再入库；
 *   - 拉取时先 decryptFile，GCM 校验失败即跳过，绝不写入半解密内容；
 *   - 会话日志只接受 zstd 魔数，避免把坏文件写回去导致 DSH 无法启动；
 *   - 清单里的路径经过 .. / 盘符 / Windows 非法字符校验，防止路径穿越。
 */
import fs from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GithubRest, RestError, blobSha } from './rest.js'
import {
  DEFAULT_KDF,
  decryptFile,
  encryptFile,
  newMasterKey,
  sha256,
  unwrapKey,
  wrapKey,
} from './crypto.js'
import {
  baselinePath,
  conflictsDir,
  keyCachePath,
  keyEncPath,
  mkdirp,
  resolveHome,
  stateDir,
  writeFileAtomic,
} from './config.js'

export const MANIFEST_PATH = 'state/manifest.json'
export const KEY_PATH = 'key.enc'
export const ENC_SUFFIX = '.dshx'
export const STATE_GROUPS = Object.freeze(['sessions', 'storages', 'memories', 'configs'])

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MAX_CONFLICT_NAME = 140
const MTIME_TOLERANCE_MS = 2000

const SESSION_EXCLUDE_NAMES = new Set(['session.lock', 'session_projcache.json'])
const GENERIC_EXCLUDE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  ...SESSION_EXCLUDE_NAMES,
])
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '__pycache__'])

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** 同步层可识别的错误，便于界面给出可执行提示。 */
export class SyncError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'SyncError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

function messageOf(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

function asSyncError(error, config) {
  if (error instanceof SyncError) return error
  if (error instanceof RestError) {
    if (error.fatal === 'auth') {
      return new SyncError(
        'auth',
        'GitHub Token 无效或权限不足（需要该仓库 Contents: read/write）：' + error.message,
        error,
      )
    }
    if (error.fatal === 'missing') {
      return new SyncError(
        'repo',
        `仓库不存在或当前 Token 无权访问：${(config && (config.stateRepo || config.remote)) || ''}`,
        error,
      )
    }
    if (error.status === 0) {
      return new SyncError('network', '无法连接 GitHub API：' + error.message, error)
    }
    return new SyncError('rest', error.message, error)
  }
  return new SyncError('state', messageOf(error), error)
}

// ── 路径与扫描 ───────────────────────────────────────────────────────────

function statePrefix(group) {
  return `state/${group}`
}

function isExcludedName(name) {
  if (GENERIC_EXCLUDE_NAMES.has(name)) return true
  if (name.endsWith('.tmp')) return true
  if (name.startsWith('.dsh-mkdir')) return true
  // 双机冲突时远端会话副本只留在本机，绝不再上传。
  if (/\.remote\.jsonl\.zstd$/i.test(name)) return true
  return false
}

/** 递归收集文件；返回 { files:[{abs,rel}], errors:[...] }。symbolic link 一律跳过。 */
async function walkFiles(root, options = {}) {
  const files = []
  const errors = []
  const excludeDirs = options.excludeDirs || EXCLUDE_DIRS

  async function visit(dir, prefix) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      errors.push({ dir, error: messageOf(error) })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (isExcludedName(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue
        await visit(abs, rel)
      } else if (entry.isFile()) {
        files.push({ abs, rel })
      }
    }
  }

  await visit(root, '')
  return { files, errors }
}

function isSafeSegment(segment) {
  if (!segment || segment === '.' || segment === '..') return false
  if (segment.includes('\\')) return false
  if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return false
  if (/[ .]$/.test(segment)) return false
  const stem = segment.split('.')[0].toUpperCase()
  if (WINDOWS_RESERVED.has(stem)) return false
  return true
}

function safeRelPath(rel) {
  const text = String(rel == null ? '' : rel).replace(/\\/g, '/')
  if (!text || text.startsWith('/')) return null
  const segments = text.split('/')
  if (!segments.length) return null
  if (segments.some((segment) => !isSafeSegment(segment))) return null
  return segments.join('/')
}

/** 仓库路径 → { group, rel }；非法路径返回 null。 */
export function parseStateRepoPath(repoPath) {
  const text = String(repoPath == null ? '' : repoPath)
  if (!text.startsWith('state/')) return null
  const rest = text.slice('state/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const group = rest.slice(0, slash)
  if (!STATE_GROUPS.includes(group)) return null
  let rel = rest.slice(slash + 1)
  if (!rel.endsWith(ENC_SUFFIX)) return null
  rel = rel.slice(0, -ENC_SUFFIX.length)
  const safe = safeRelPath(rel)
  if (!safe) return null
  return { group, rel: safe, repoPath: `${statePrefix(group)}/${safe}${ENC_SUFFIX}` }
}

/** 仓库路径 → 本机绝对路径；非法路径返回 null。 */
export function mapRepoPathToLive(repoPath, home) {
  const parsed = parseStateRepoPath(repoPath)
  if (!parsed) return null
  const base = resolveHome(home)

  // configs 不是 $DSH_HOME/configs/ 目录，而是分散在 profile 和根目录。
  if (parsed.group === 'configs') {
    if (parsed.rel === 'settings.yaml') {
      return { abs: join(base, 'settings.yaml'), group: 'configs', rel: parsed.rel }
    }
    const parts = parsed.rel.split('/')
    if (
      parts.length === 3
      && parts[0] === 'profiles'
      && (parts[2] === 'package.json' || parts[2] === 'cordis.patch.yml')
    ) {
      return {
        abs: join(base, 'profiles', parts[1], parts[2]),
        group: 'configs',
        rel: parsed.rel,
      }
    }
    return null
  }

  const root = join(base, parsed.group)
  const abs = resolve(root, ...parsed.rel.split('/'))
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return { abs, group: parsed.group, rel: parsed.rel }
}

function currentProfileName() {
  const fromEnv = String(process.env.DSH_PROFILE || '').trim()
  return fromEnv || 'desktop'
}

function configSources(home) {
  const profile = currentProfileName()
  const profileDir = join(home, 'profiles', profile)
  return {
    profile,
    profileDir,
    sources: [
      { rel: `profiles/${profile}/package.json`, abs: join(profileDir, 'package.json') },
      { rel: `profiles/${profile}/cordis.patch.yml`, abs: join(profileDir, 'cordis.patch.yml') },
      { rel: 'settings.yaml', abs: join(home, 'settings.yaml') },
    ],
  }
}

function isWorkspaceStore(parsed) {
  return parsed.group === 'storages' && parsed.rel === 'workspace.json'
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/')
}

/** child 在 parent 之下时返回相对路径；parent 本身返回 '.'；否则 null。 */
function relativeUnder(parent, child) {
  if (!parent || !child) return null
  const rel = relative(resolve(parent), resolve(child))
  if (!rel) return '.'
  if (
    isAbsolute(rel)
    || rel === '..'
    || rel.startsWith(`..${sep}`)
    || rel.startsWith('../')
    || rel.startsWith('..\\')
  ) {
    return null
  }
  return rel
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Push 前把 workspace.json 中位于 gitRoot 下的绝对路径改成 ./相对路径。
 * 返回用于加密的新 Buffer；不修改本机文件。
 */
function remapWorkspaceStoreForPush(buffer, gitRoot) {
  if (!gitRoot) return buffer
  const json = parseJsonBuffer(buffer)
  if (!json || !json.tables || !json.tables.workspaces || typeof json.tables.workspaces !== 'object') {
    return buffer
  }
  let changed = false
  for (const entry of Object.values(json.tables.workspaces)) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue
    if (!isAbsolute(entry.path)) continue
    const rel = relativeUnder(gitRoot, entry.path)
    if (rel === null) continue
    entry.path = rel === '.' ? './' : `./${toPosixPath(rel)}`
    changed = true
  }
  return changed
    ? Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8')
    : buffer
}

/**
 * Pull 后把 workspace.json 中的 ./ 相对路径还原为当前 gitRoot 下的绝对路径。
 * unresolved > 0 表示远端含相对路径但本机没有 gitRoot，不能安全写入。
 */
function remapWorkspaceStoreForPull(buffer, gitRoot) {
  const json = parseJsonBuffer(buffer)
  if (!json) return { buffer, unresolved: 0, invalid: true }
  if (!json.tables || !json.tables.workspaces || typeof json.tables.workspaces !== 'object') {
    return { buffer, unresolved: 0, invalid: false }
  }
  let changed = false
  let unresolved = 0
  const root = gitRoot ? resolve(gitRoot) : ''
  for (const entry of Object.values(json.tables.workspaces)) {
    if (!entry || typeof entry.path !== 'string') continue
    const value = entry.path
    if (!(value.startsWith('./') || value.startsWith('.\\'))) continue
    if (!root) {
      unresolved += 1
      continue
    }
    const rel = value.slice(2).replace(/^[\\/]+/, '')
    const abs = rel ? resolve(root, ...rel.split(/[\\/]+/)) : root
    if (abs !== root && !abs.startsWith(root + sep)) {
      unresolved += 1
      continue
    }
    entry.path = abs
    changed = true
  }
  return {
    buffer: changed ? Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8') : buffer,
    unresolved,
    invalid: false,
  }
}

/** 双机冲突时远端会话副本的本地文件名。 */
function remoteSessionCopyPath(abs) {
  return /\.jsonl\.zstd$/i.test(abs)
    ? abs.replace(/\.jsonl\.zstd$/i, '.remote.jsonl.zstd')
    : `${abs}.remote`
}

/**
 * 扫描本机状态，生成上传计划。
 *
 * @returns {Promise<{
 *   home:string, groups:string[], prunable:string[],
 *   files:Array<{key:string,group:string,rel:string,abs:string,size:number,mtimeMs:number,repoPath:string}>,
 *   skipped:Array<{group:string,rel:string,size:number,reason:string,repoPath?:string}>,
 *   totals:Record<string, number>
 * }>}
 */
export async function buildStatePlan(options = {}) {
  const home = resolveHome(options.home)
  const wantedGroups = Array.isArray(options.groups) && options.groups.length
    ? options.groups
    : STATE_GROUPS
  const maxFileMb = Number(options.maxFileMb) || 45
  const maxBytes = Math.max(1, maxFileMb) * 1024 * 1024
  const log = typeof options.log === 'function' ? options.log : () => {}

  const files = []
  const skipped = []
  const groups = []
  const prunable = []

  for (const group of STATE_GROUPS) {
    if (!wantedGroups.includes(group)) continue

    // configs 分散在 profile 目录和 $DSH_HOME 根目录，不能按 state/<group>/ 目录扫描。
    if (group === 'configs') {
      const { profileDir, sources } = configSources(home)
      const profileStat = await fs.stat(profileDir).catch(() => null)
      let any = false
      for (const source of sources) {
        const fileStat = await fs.stat(source.abs).catch(() => null)
        if (!fileStat || !fileStat.isFile()) continue
        any = true
        const repoPath = `${statePrefix(group)}/${source.rel}${ENC_SUFFIX}`
        if (fileStat.size > maxBytes) {
          skipped.push({
            group,
            rel: source.rel,
            size: fileStat.size,
            repoPath,
            reason: `超过单文件上限 ${maxFileMb} MB（${(fileStat.size / 1048576).toFixed(1)} MB）`,
          })
          continue
        }
        files.push({
          key: `${group}/${source.rel}`,
          group,
          rel: source.rel,
          abs: source.abs,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          repoPath,
        })
      }
      if (any || (profileStat && profileStat.isDirectory())) groups.push(group)
      // 本地配置缺失时不要把远端配置当成删除；保留远端，pull 时可以恢复。
      continue
    }

    const root = join(home, group)
    let stat
    try {
      stat = await fs.stat(root)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    groups.push(group)

    const walked = await walkFiles(root)
    if (walked.errors.length) {
      // 目录树读不全时禁止清理远端，否则会把「暂时读不到」误判成「本地已删除」。
      for (const failure of walked.errors) {
        log(`扫描 ${group} 时跳过无法读取的目录：${failure.dir}（${failure.error}）`)
      }
    } else {
      prunable.push(group)
    }

    for (const item of walked.files) {
      let fileStat
      try {
        fileStat = await fs.stat(item.abs)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue
      const repoPath = `${statePrefix(group)}/${item.rel}${ENC_SUFFIX}`
      if (fileStat.size > maxBytes) {
        skipped.push({
          group,
          rel: item.rel,
          size: fileStat.size,
          repoPath,
          reason: `超过单文件上限 ${maxFileMb} MB（${(fileStat.size / 1048576).toFixed(1)} MB）`,
        })
        continue
      }
      files.push({
        key: `${group}/${item.rel}`,
        group,
        rel: item.rel,
        abs: item.abs,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        repoPath,
      })
    }
  }

  files.sort((a, b) => a.key.localeCompare(b.key))
  const totals = { files: files.length, bytes: files.reduce((n, file) => n + file.size, 0) }
  for (const group of STATE_GROUPS) {
    const inGroup = files.filter((file) => file.group === group)
    totals[group] = inGroup.length
    totals[`${group}Bytes`] = inGroup.reduce((n, file) => n + file.size, 0)
  }
  totals.skipped = skipped.length

  return { home, groups, prunable, files, skipped, totals }
}

/** 会话日志只有以 zstd 魔数开头才可能被 DSH 正常读取。 */
export function isCorruptSessionLog(plainPath, buffer) {
  if (!/\.jsonl\.zstd$/i.test(String(plainPath || ''))) return false
  if (!Buffer.isBuffer(buffer) || buffer.length < ZSTD_MAGIC.length) return true
  return !buffer.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
}

export function deviceName(config) {
  const configured = String((config && config.deviceName) || '').trim()
  if (configured) {
    return configured.replace(/[\r\n\t]+/g, ' ').slice(0, 60)
  }
  let name = hostname().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name) name = 'device-' + sha256(Buffer.from(hostname(), 'utf8')).slice(0, 8)
  return name.slice(0, 60)
}

// ── 远端传输适配器 ───────────────────────────────────────────────────────

/**
 * 把 lib/rest.js 的 GithubRest 适配成同步核心需要的最小传输面：
 *   snapshot() / read(path) / commit(changes, base, message)
 *
 * refer/sync-mh.js 的 pushSnapshot 依赖 getBranchHead / createBlob / createTree /
 * createCommit / setRef；这里统一折叠成 rest.remoteTree() + rest.blob() +
 * rest.commitFiles()，不再需要那套接口。
 */
export class RestTransport {
  constructor(config, log) {
    // GithubRest 仍使用 cfg.remote 这个字段名；对插件外部只暴露 stateRepo。
    const restConfig = {
      ...config,
      remote: config.stateRepo || config.remote || '',
    }
    this.config = restConfig
    this.log = typeof log === 'function' ? log : () => {}
    this.rest = new GithubRest(restConfig, this.log)
    this.snapshotCache = null
  }

  async ensureRepo() {
    let exists = false
    try {
      exists = await this.rest.repoExists()
    } catch (error) {
      throw asSyncError(error, this.config)
    }
    if (!exists) {
      throw new SyncError(
        'repo',
        `仓库不存在或当前 Token 无权访问：${this.config.remote || ''}\n` +
        '请先在 GitHub 创建这个私有仓库，并让 Token 拥有该仓库的 Contents 读写权限。',
      )
    }
  }

  async snapshot() {
    try {
      this.snapshotCache = await this.rest.remoteTree()
      return this.snapshotCache
    } catch (error) {
      throw asSyncError(error, this.config)
    }
  }

  /**
   * Git Data API 写空仓库会返回 409，因此首个提交通过 Contents API 的
   * README.md 建立。之后所有内容仍走 commitFiles 的原子提交。
   */
  async initializeIfEmpty(snapshot) {
    const current = snapshot || await this.snapshot()
    if (current.head) return current

    // Git Data API 无法直接写空仓库，所以空仓库要用 Contents API 建首个提交。
    // 但如果仓库已有其他分支、只是配置的分支不存在，绝不能拿默认分支去
    // 建一个「带代码的状态分支」——明确报错，让用户建分支或改配置。
    let branches
    try {
      branches = await this.rest.request(
        'GET',
        `/repos/${this.rest.owner}/${this.rest.repo}/branches?per_page=1`,
      )
    } catch (error) {
      throw asSyncError(error, this.config)
    }
    if (Array.isArray(branches) && branches.length > 0) {
      throw new SyncError(
        'repo',
        `状态仓库已有其他分支，但分支 ${this.rest.branch} 不存在。\n` +
        '请先在 GitHub 创建该分支，或在设置里把「分支」改成已存在的分支。',
      )
    }

    const body = [
      '# DSH one-sync 状态仓库',
      '',
      '这个私有仓库由 dsh-one-sync 插件维护，保存加密后的 DSH 会话/存储/记忆。',
      '除插件外请勿手工编辑；每个文件都是 AES-256-GCM 密文。',
      '',
    ].join('\n')
    try {
      await this.rest.request(
        'PUT',
        `/repos/${this.rest.owner}/${this.rest.repo}/contents/README.md`,
        {
          message: 'dsh-one-sync: initialize state repository',
          content: Buffer.from(body, 'utf8').toString('base64'),
          branch: this.rest.branch,
        },
      )
    } catch (error) {
      // 422/409：已经初始化过（并发或上一次请求已成功）——重新读快照即可。
      if (!(error instanceof RestError) || ![409, 422].includes(error.status)) {
        throw asSyncError(error, this.config)
      }
    }
    return this.snapshot()
  }

  async read(path) {
    const snapshot = this.snapshotCache || await this.snapshot()
    const entry = snapshot.files.get(path)
    if (!entry) throw new SyncError('state', `远端缺少文件：${path}`)
    try {
      return await this.rest.blob(entry.sha)
    } catch (error) {
      throw asSyncError(error, this.config)
    }
  }

  async commit(changes, base, message, parents) {
    try {
      return await this.rest.commitFiles(
        changes,
        base && base.treeSha ? base.treeSha : null,
        message,
        parents || (base && base.head ? [base.head] : []),
      )
    } catch (error) {
      throw asSyncError(error, this.config)
    }
  }
}

// ── 清单 ─────────────────────────────────────────────────────────────────

export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const files = {}
  for (const [rawKey, meta] of Object.entries(src.files || {})) {
    if (!meta || typeof meta !== 'object') continue
    let group = ''
    let rel = ''
    const parts = String(rawKey).split('/')
    if (parts.length >= 2 && STATE_GROUPS.includes(parts[0])) {
      group = parts[0]
      rel = parts.slice(1).join('/')
    } else if (meta.repoPath) {
      const parsed = parseStateRepoPath(meta.repoPath)
      if (parsed) {
        group = parsed.group
        rel = parsed.rel
      }
    }
    if (!group) continue
    const safe = safeRelPath(rel)
    if (!safe) continue
    const key = `${group}/${safe}`
    files[key] = {
      group,
      rel: safe,
      repoPath: `${statePrefix(group)}/${safe}${ENC_SUFFIX}`,
      sha256: typeof meta.sha256 === 'string' ? meta.sha256 : undefined,
      cipherSha: typeof meta.cipherSha === 'string' ? meta.cipherSha : undefined,
      size: Number(meta.size) || 0,
      mtime: Number(meta.mtime) || 0,
    }
  }
  return {
    version: Number(src.version) || 1,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : undefined,
    device: typeof src.device === 'string' ? src.device : undefined,
    groups: Array.isArray(src.groups) ? src.groups.filter((g) => STATE_GROUPS.includes(g)) : [],
    files,
  }
}

function manifestFromTree(snapshot) {
  const files = {}
  for (const [path, meta] of snapshot.files) {
    const parsed = parseStateRepoPath(path)
    if (!parsed) continue
    files[`${parsed.group}/${parsed.rel}`] = {
      group: parsed.group,
      rel: parsed.rel,
      repoPath: path,
      sha256: undefined,
      cipherSha: undefined,
      size: Number(meta && meta.size) || 0,
      mtime: 0,
    }
  }
  const groups = [...new Set(Object.values(files).map((entry) => entry.group))]
  return { version: 1, updatedAt: undefined, device: undefined, groups, files }
}

function manifestsEquivalent(a, b) {
  if (!a || !b) return false
  const groupsA = Array.isArray(a.groups) ? [...a.groups].sort().join(',') : ''
  const groupsB = Array.isArray(b.groups) ? [...b.groups].sort().join(',') : ''
  if (groupsA !== groupsB) return false
  const keysA = Object.keys(a.files || {}).sort()
  const keysB = Object.keys(b.files || {}).sort()
  if (keysA.length !== keysB.length) return false
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false
    const x = a.files[keysA[i]]
    const y = b.files[keysB[i]]
    if (!x || !y) return false
    if (x.repoPath !== y.repoPath) return false
    if (x.sha256 !== y.sha256) return false
    if (x.cipherSha !== y.cipherSha) return false
    if (Number(x.size) !== Number(y.size)) return false
  }
  return true
}

function serializeManifest(manifest) {
  const files = {}
  for (const key of Object.keys(manifest.files || {}).sort()) {
    files[key] = manifest.files[key]
  }
  return JSON.stringify({
    version: manifest.version || 1,
    generator: 'dsh-one-sync',
    device: manifest.device || '',
    updatedAt: manifest.updatedAt || new Date().toISOString(),
    groups: Array.isArray(manifest.groups) ? manifest.groups : [],
    files,
  }, null, 2) + '\n'
}

function buildManifest({ plan, encrypted, config, groups }) {
  const files = {}
  for (const file of plan.files) {
    const stored = encrypted.get(file.key)
    if (!stored) continue
    files[file.key] = {
      group: file.group,
      rel: file.rel,
      repoPath: file.repoPath,
      sha256: stored.plainSha,
      cipherSha: stored.cipherSha,
      size: stored.size,
      mtime: Math.round(file.mtimeMs),
    }
  }
  return {
    version: 1,
    generator: 'dsh-one-sync',
    device: deviceName(config),
    updatedAt: new Date().toISOString(),
    groups: Array.isArray(groups) ? groups : [],
    files,
  }
}

async function readRemoteManifest(transport, snapshot, log) {
  const entry = snapshot.files.get(MANIFEST_PATH)
  if (!entry) return { manifest: null, buffer: null }
  let buffer
  try {
    buffer = await transport.read(MANIFEST_PATH)
  } catch (error) {
    log('读取远端清单失败：' + messageOf(error))
    return { manifest: null, buffer: null }
  }
  try {
    return { manifest: normalizeManifest(JSON.parse(buffer.toString('utf8'))), buffer }
  } catch {
    log('远端清单不是合法 JSON，将按目录树恢复（只补缺失文件，不覆盖本机）')
    return { manifest: null, buffer: null }
  }
}

async function readBaseline(home) {
  try {
    const text = await fs.readFile(baselinePath(home), 'utf8')
    return normalizeManifest(JSON.parse(text))
  } catch {
    return { version: 1, files: {} }
  }
}

async function writeBaseline(home, manifest) {
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    groups: Array.isArray(manifest.groups) ? manifest.groups : [],
    files: manifest.files || {},
  }
  await writeFileAtomic(baselinePath(home), Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8'))
}

// ── 主密钥 ───────────────────────────────────────────────────────────────

async function readFileOrNull(file) {
  try {
    return await fs.readFile(file)
  } catch {
    return null
  }
}

async function syncRemoteKey(transport, snapshot, home, log) {
  const localFile = keyEncPath(home)
  const local = await readFileOrNull(localFile)
  const entry = snapshot.files.get(KEY_PATH)
  if (!entry) return { buffer: local, changed: false }
  let remote
  try {
    remote = await transport.read(KEY_PATH)
  } catch (error) {
    throw asSyncError(error, transport.config)
  }
  if (!local || !local.equals(remote)) {
    await writeFileAtomic(localFile, remote)
    // key.enc 变了，旧的主密钥缓存很可能对不上；立刻失效，
    // 强制用口令重新解锁，避免拿旧缓存去解密/加密新仓库的数据。
    await fs.rm(keyCachePath(home), { force: true }).catch(() => {})
    log('已从远端同步 key.enc（旧主密钥缓存已清除）')
    return { buffer: remote, changed: true }
  }
  return { buffer: local, changed: false }
}

/**
 * 取得可用的主密钥。
 *
 * @param {object} config
 * @param {object} options { home, transport, snapshot, allowCreate, log }
 * @returns {Promise<Buffer>} 32 字节主密钥
 */
export async function ensureMasterKey(config, options = {}) {
  const home = resolveHome(options.home)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const transport = options.transport
  if (!transport) throw new SyncError('state', '缺少传输层，无法读取 key.enc')
  const snapshot = options.snapshot || await transport.snapshot()
  const sync = await syncRemoteKey(transport, snapshot, home, log)
  const localKeyEnc = sync.buffer
  const cachePath = keyCachePath(home)
  const cached = await readFileOrNull(cachePath)
  const cachedKey = cached && cached.length === 32 ? cached : null
  const passphrase = String(config.passphrase || '')
  const kdf = { ...DEFAULT_KDF, ...(config.kdf || {}) }

  let key = null
  if (localKeyEnc) {
    if (passphrase) {
      try {
        key = unwrapKey(localKeyEnc, passphrase, kdf)
      } catch {
        // 不退回缓存：缓存可能属于另一个 key.enc。口令错就明确报错，
        // 让用户修正口令，而不是拿可能不匹配的密钥继续写入。
        throw new SyncError(
          'bad-passphrase',
          '口令无法解开远端的 key.enc。请确认两台电脑使用同一个口令；如果确实忘记，需要两台电脑一起重置密钥。',
        )
      }
    } else if (cachedKey && !sync.changed) {
      key = cachedKey
    } else {
      throw new SyncError(
        'need-passphrase',
        sync.changed
          ? '远端 key.enc 已更新，必须提供同步口令才能解锁。'
          : '需要同步口令才能解开 key.enc（请在设置页填写 passphrase）。',
      )
    }
  } else {
    // 仓库里还没有 key.enc。
    if (!options.allowCreate) {
      throw new SyncError('state', '远端存在加密状态但缺少 key.enc，无法解密。')
    }
    if (!passphrase) {
      throw new SyncError(
        'need-passphrase',
        '首次同步需要设置同步口令：它会用来生成并保护仓库里的 key.enc。',
      )
    }
    key = cachedKey || newMasterKey()
    await mkdirp(dirname(keyEncPath(home)))
    await writeFileAtomic(keyEncPath(home), wrapKey(key, passphrase, kdf))
    log('已生成新的主密钥并写入 key.enc（请记住同一个口令，另一台电脑要用它解锁）')
  }

  if (config.rememberKey !== false) {
    await writeFileAtomic(cachePath, key)
    try { await fs.chmod(cachePath, 0o600) } catch { /* Windows 上基本无效 */ }
  } else {
    await fs.rm(cachePath, { force: true }).catch(() => {})
  }
  return key
}

// ── 本机写入 / 冲突备份 ─────────────────────────────────────────────────

async function writeLocalFile(abs, buffer, mtimeMs) {
  await mkdirp(dirname(abs))
  await writeFileAtomic(abs, buffer)
  const stamp = Number(mtimeMs) || 0
  if (stamp > 0) {
    const date = new Date(stamp)
    try {
      await fs.utimes(abs, date, date)
    } catch {
      /* 某些文件系统不允许设置时间，忽略 */
    }
  }
}

async function backupConflict(home, group, rel, buffer) {
  const dir = conflictsDir(home)
  await mkdirp(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeName = `${group}__${rel.replace(/[\\/]/g, '__')}`.slice(0, MAX_CONFLICT_NAME)
  const target = join(dir, `${safeName}.${stamp}.bak`)
  await fs.writeFile(target, buffer)
  return target
}

/** 下载并解密一个远端状态文件，校验清单哈希。 */
async function loadRemotePlain(transport, repoPath, meta, key) {
  let cipher
  try {
    cipher = await transport.read(repoPath)
  } catch (error) {
    return { ok: false, reason: '下载失败：' + messageOf(error) }
  }
  let plain
  try {
    plain = decryptFile(cipher, key)
  } catch (error) {
    return { ok: false, reason: '解密失败：' + messageOf(error) }
  }
  if (meta.sha256 && sha256(plain) !== meta.sha256) {
    return { ok: false, reason: '解密后的内容与清单哈希不符' }
  }
  return { ok: true, plain }
}

// ── 推送 ─────────────────────────────────────────────────────────────────

/**
 * 采集本机状态 → 加密 → 与远端树比对 → 一个原子提交。
 *
 * @returns {Promise<object>} 统计信息；不含文件内容，便于直接回给界面。
 */
export async function pushState(config, options = {}) {
  const home = resolveHome(options.home)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const transport = options.transport || new RestTransport(config, log)
  try {
    if (typeof transport.ensureRepo === 'function') await transport.ensureRepo()
    let snapshot = await transport.snapshot()
    if (!snapshot.head && typeof transport.initializeIfEmpty === 'function') {
      snapshot = await transport.initializeIfEmpty(snapshot)
    }
    if (snapshot.truncated) {
      log('远端目录树被 GitHub 截断：本次仍可上传/更新，但不会删除远端文件。')
    }

    const key = await ensureMasterKey(config, {
      home,
      transport,
      snapshot,
      allowCreate: true,
      log,
    })

    const plan = await buildStatePlan({
      home,
      groups: options.groups,
      maxFileMb: config.maxFileMb,
      log,
    })
    const { manifest: remoteManifest, buffer: remoteManifestBuf } = await readRemoteManifest(
      transport,
      snapshot,
      log,
    )

    const maxBytes = Math.max(1, Number(config.maxFileMb) || 45) * 1024 * 1024
    const encrypted = new Map()
    const protectedPaths = new Set()
    for (const skipped of plan.skipped) {
      if (skipped.repoPath) protectedPaths.add(skipped.repoPath)
    }

    for (const file of plan.files) {
      let plain
      try {
        plain = await fs.readFile(file.abs)
      } catch (error) {
        protectedPaths.add(file.repoPath)
        plan.skipped.push({
          group: file.group,
          rel: file.rel,
          size: file.size,
          repoPath: file.repoPath,
          reason: '读取失败：' + messageOf(error),
        })
        continue
      }

      // workspace.json 的 path 若位于当前 gitRoot 下，改为 ./相对路径后入库。
      if (isWorkspaceStore(file)) {
        plain = remapWorkspaceStoreForPush(plain, options.gitRoot)
      }

      if (plain.length > maxBytes) {
        protectedPaths.add(file.repoPath)
        plan.skipped.push({
          group: file.group,
          rel: file.rel,
          size: plain.length,
          repoPath: file.repoPath,
          reason: `超过单文件上限 ${config.maxFileMb} MB`,
        })
        continue
      }
      const cipher = encryptFile(plain, key)
      encrypted.set(file.key, {
        buffer: cipher,
        cipherSha: sha256(cipher),
        plainSha: sha256(plain),
        size: plain.length,
      })
    }

    const usableFiles = plan.files.filter((file) => encrypted.has(file.key))
    let manifest = buildManifest({
      plan: { ...plan, files: usableFiles },
      encrypted,
      config,
      groups: plan.groups,
    })
    // 本次因「超大 / 读失败」被跳过的文件，远端旧副本必须保留：
    // 既不能删除，也不能从清单里消失（否则另一台电脑就看不到它了）。
    if (remoteManifest) {
      for (const path of protectedPaths) {
        const parsed = parseStateRepoPath(path)
        if (!parsed) continue
        const keyName = `${parsed.group}/${parsed.rel}`
        if (!manifest.files[keyName] && remoteManifest.files[keyName]) {
          manifest.files[keyName] = remoteManifest.files[keyName]
        }
      }

      // configs 是「本机缺失时保留远端」的组：本地没有 package.json 等文件时，
      // 不把远端配置当成删除，下一次 pull 仍可恢复。
      for (const [keyName, meta] of Object.entries(remoteManifest.files || {})) {
        if (meta.group !== 'configs' || manifest.files[keyName]) continue
        manifest.files[keyName] = meta
        const parsed = parseStateRepoPath(meta.repoPath)
        if (parsed) protectedPaths.add(parsed.repoPath)
      }
      if (
        Object.keys(manifest.files).some((keyName) => keyName.startsWith('configs/'))
        && !manifest.groups.includes('configs')
      ) {
        manifest.groups = [...manifest.groups, 'configs']
      }
    }
    let manifestBuffer
    if (remoteManifest && remoteManifestBuf && manifestsEquivalent(remoteManifest, manifest)) {
      // 清单内容完全一致：沿用远端字节，避免 updatedAt 造成无意义提交。
      manifest = remoteManifest
      manifestBuffer = remoteManifestBuf
    } else {
      manifestBuffer = Buffer.from(serializeManifest(manifest), 'utf8')
    }

    const want = new Map()
    for (const file of usableFiles) {
      want.set(file.repoPath, encrypted.get(file.key).buffer)
    }
    want.set(MANIFEST_PATH, manifestBuffer)
    const localKeyEnc = await readFileOrNull(keyEncPath(home))
    if (!localKeyEnc) {
      throw new SyncError('state', '本机缺少 key.enc，无法完成状态推送。请重新设置同步口令。')
    }
    want.set(KEY_PATH, localKeyEnc)

    const changes = []
    for (const [path, buffer] of want) {
      const current = snapshot.files.get(path)
      if (!current || current.sha !== blobSha(buffer)) {
        changes.push({ path, buffer })
      }
    }

    // 远端有、本机已不存在、且属于本次可安全扫描的组 → 删除。
    // 扫描不完整（权限/IO 错误）的组不参与清理；跳过的大文件也受保护。
    const prunable = new Set(plan.prunable || [])
    let deleted = 0
    if (!snapshot.truncated) {
      for (const path of snapshot.files.keys()) {
        if (path === MANIFEST_PATH || path === KEY_PATH) continue
        if (!path.startsWith('state/')) continue
        if (want.has(path) || protectedPaths.has(path)) continue
        const parsed = parseStateRepoPath(path)
        if (!parsed || !prunable.has(parsed.group)) continue
        changes.push({ path, buffer: null })
        deleted += 1
      }
    }

    if (!changes.length) {
      await writeBaseline(home, remoteManifest || manifest)
      return {
        ok: true,
        pushed: false,
        unchanged: true,
        files: usableFiles.length,
        uploaded: 0,
        deleted: 0,
        skipped: plan.skipped,
        groups: plan.groups,
        totals: plan.totals,
      }
    }

    const message = `sync(${deviceName(config)}) ${new Date().toISOString()}`
    const commit = await transport.commit(changes, snapshot, message)
    await writeBaseline(home, manifest)
    return {
      ok: true,
      pushed: true,
      commit: typeof commit === 'string' ? commit : (commit && commit.sha) || '',
      files: usableFiles.length,
      uploaded: changes.filter((change) => change.buffer !== null).length,
      deleted,
      skipped: plan.skipped,
      groups: plan.groups,
      totals: plan.totals,
    }
  } catch (error) {
    throw asSyncError(error, config)
  }
}

// ── 拉取 ─────────────────────────────────────────────────────────────────

/**
 * 拉取远端状态 → 解密 → 按三方基线合并写入本机。
 *
 * @returns {Promise<object>} 统计信息；不返回文件内容。
 */
export async function pullState(config, options = {}) {
  const home = resolveHome(options.home)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const transport = options.transport || new RestTransport(config, log)
  try {
    if (typeof transport.ensureRepo === 'function') await transport.ensureRepo()
    const snapshot = await transport.snapshot()
    if (!snapshot.head) {
      return {
        ok: true,
        empty: true,
        applied: 0,
        unchanged: 0,
        files: 0,
        conflicts: [],
        keptLocal: [],
        skipped: [],
      }
    }
    if (snapshot.truncated) {
      log('远端目录树被 GitHub 截断：本次只恢复清单中能看到的部分。')
    }

    // 先下载 key.enc（不需要口令），再决定是否需要解锁。
    const keyInfo = await syncRemoteKey(transport, snapshot, home, log)
    const { manifest: remoteManifest } = await readRemoteManifest(transport, snapshot, log)
    const manifest = remoteManifest || manifestFromTree(snapshot)
    const entries = Object.entries(manifest.files || {})

    if (!entries.length) {
      return {
        ok: true,
        empty: true,
        applied: 0,
        unchanged: 0,
        files: 0,
        conflicts: [],
        keptLocal: [],
        skipped: [],
      }
    }
    if (!keyInfo.buffer) {
      throw new SyncError('state', '远端存在加密状态，但仓库里没有 key.enc，无法解密。')
    }

    const key = await ensureMasterKey(config, {
      home,
      transport,
      snapshot,
      allowCreate: false,
      log,
    })
    const baseline = await readBaseline(home)
    const baseFiles = baseline.files || {}

    const applied = []
    const unchanged = []
    const keptLocal = []
    const conflicts = []
    const skipped = []

    for (const [keyName, meta] of entries) {
      const parsed = parseStateRepoPath(meta.repoPath) || (
        meta.group && meta.rel ? parseStateRepoPath(`${statePrefix(meta.group)}/${meta.rel}${ENC_SUFFIX}`) : null
      )
      if (!parsed) {
        skipped.push({ key: keyName, reason: '清单中的路径不合法' })
        continue
      }
      const repoPath = parsed.repoPath
      const remoteEntry = snapshot.files.get(repoPath)
      if (!remoteEntry) {
        skipped.push({ key: keyName, reason: '远端文件不存在' })
        continue
      }
      const target = mapRepoPathToLive(repoPath, home)
      if (!target) {
        skipped.push({ key: keyName, reason: '无法映射到本机路径' })
        continue
      }

      let localBuffer = null
      let localMtime = 0
      try {
        localBuffer = await fs.readFile(target.abs)
        localMtime = (await fs.stat(target.abs)).mtimeMs
      } catch {
        /* 本机没有这个文件 */
      }

      const isConfig = parsed.group === 'configs'
      const isWorkspace = isWorkspaceStore(parsed)
      const localCompare = localBuffer && isWorkspace
        ? remapWorkspaceStoreForPush(localBuffer, options.gitRoot)
        : localBuffer

      let takeRemote = false
      let backedUp = null
      if (!localBuffer) {
        takeRemote = true
      } else {
        const localHash = sha256(localCompare)
        if (meta.sha256 && localHash === meta.sha256) {
          unchanged.push(keyName)
          continue
        }

        if (isConfig) {
          // Profile / settings 配置以远端为准；先备份本机旧版再覆盖。
          backedUp = await backupConflict(home, parsed.group, parsed.rel, localBuffer)
          takeRemote = true
        } else {
          const baseMeta = baseFiles[keyName]
          const baseHash = baseMeta && baseMeta.sha256
          const baseMtime = Number(baseMeta && baseMeta.mtime) || 0
          const bothChanged = Boolean(baseHash) && localHash !== baseHash && meta.sha256 !== baseHash

          // 双机都改过同名会话，且本机修改时间晚于基线：
          // 绝不覆盖本机，远端版本另存为 <name>.remote.jsonl.zstd。
          if (parsed.group === 'sessions' && bothChanged && localMtime > baseMtime) {
            const loaded = await loadRemotePlain(transport, repoPath, meta, key)
            if (!loaded.ok) {
              skipped.push({ key: keyName, reason: loaded.reason })
              continue
            }
            if (isCorruptSessionLog(parsed.rel, loaded.plain)) {
              skipped.push({
                key: keyName,
                reason: '远端会话不是合法 zstd；为保护本机未覆盖，也未另存',
              })
              continue
            }
            const remoteCopy = remoteSessionCopyPath(target.abs)
            try {
              await writeLocalFile(remoteCopy, loaded.plain, meta.mtime)
            } catch (error) {
              skipped.push({ key: keyName, reason: '远端会话另存失败：' + messageOf(error) })
              continue
            }
            conflicts.push({
              key: keyName,
              remoteCopy,
              reason: '双方都修改了该会话；本机较新，已保留本地，远端版本另存为 ' + remoteCopy,
            })
            log('会话冲突：已保留本地，远端版本另存为 ' + remoteCopy)
            continue
          }

          if (baseHash && localHash === baseHash) {
            takeRemote = true
          } else if (baseHash && meta.sha256 === baseHash) {
            // 对方没改、本机改了：保留本机，等下一次 push 上传。
            keptLocal.push({ key: keyName, reason: '本机较新' })
            continue
          } else if (!meta.sha256) {
            // 退化的远端清单（无明文哈希）：绝不用它覆盖已有本机文件。
            keptLocal.push({ key: keyName, reason: '远端清单缺少哈希，保留本机' })
            continue
          } else {
            const remoteMtime = Number(meta.mtime) || 0
            if (remoteMtime > localMtime + MTIME_TOLERANCE_MS) {
              takeRemote = true
              // 两边都改过（或首次拉取）：覆盖前备份本机。
              backedUp = await backupConflict(home, parsed.group, parsed.rel, localBuffer)
              conflicts.push({
                key: keyName,
                backup: backedUp,
                reason: baseHash
                  ? '双方都修改了该文件，按修改时间采用远端，本机旧版已备份'
                  : '首次拉取时远端较新，本机旧版已备份',
              })
              log('冲突：' + keyName + '，本机旧版已备份到 ' + backedUp)
            } else {
              keptLocal.push({ key: keyName, reason: '本机较新，保留本机' })
              continue
            }
          }
        }
      }

      const loaded = await loadRemotePlain(transport, repoPath, meta, key)
      if (!loaded.ok) {
        skipped.push({ key: keyName, reason: loaded.reason })
        continue
      }
      let plain = loaded.plain

      if (isWorkspace) {
        const remapped = remapWorkspaceStoreForPull(plain, options.gitRoot)
        if (remapped.invalid) {
          skipped.push({ key: keyName, reason: '远端 workspace.json 不是合法 JSON，未覆盖本机' })
          continue
        }
        if (remapped.unresolved > 0) {
          skipped.push({
            key: keyName,
            reason: '远端 workspace.json 含 ./ 路径，但当前没有 gitRoot，无法重映射；保留本机',
          })
          continue
        }
        plain = remapped.buffer
        if (localBuffer && localBuffer.equals(plain)) {
          unchanged.push(keyName)
          continue
        }
      }

      if (isCorruptSessionLog(parsed.rel, plain)) {
        skipped.push({
          key: keyName,
          reason: '不是合法的 zstd 会话日志；写入它会让 DSH 无法启动，已跳过',
        })
        continue
      }
      try {
        await writeLocalFile(target.abs, plain, meta.mtime)
      } catch (error) {
        skipped.push({ key: keyName, reason: '写入失败：' + messageOf(error) })
        continue
      }
      applied.push({ key: keyName, backup: backedUp })
    }

    // 写失败的条目不要进入基线：下次拉取仍把它当作「没有 base」，
    // 文件缺失时会重试，文件还在时也不会被误判成双方冲突。
    const baselineManifest = { ...manifest, files: { ...manifest.files } }
    for (const item of skipped) {
      if (item.key) delete baselineManifest.files[item.key]
    }
    await writeBaseline(home, baselineManifest)
    return {
      ok: true,
      applied: applied.length,
      unchanged: unchanged.length,
      files: entries.length,
      conflicts,
      keptLocal,
      skipped,
      groups: manifest.groups || [],
    }
  } catch (error) {
    throw asSyncError(error, config)
  }
}

/** 供界面显示的当前状态目录。 */
export function describePaths(home) {
  return {
    home: resolveHome(home),
    stateDir: stateDir(home),
    baseline: baselinePath(home),
    key: keyCachePath(home),
    keyEnc: keyEncPath(home),
    conflicts: conflictsDir(home),
  }
}
