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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
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

const WORKSPACE_SAFE = /^[A-Za-z0-9._-]$/

/**
 * DSH 的 projectKey()：把绝对工作区路径编码成 sessions/ 下的目录名。
 * 与 refer/important/paths-mh.js 的 encodeWorkspaceKey 保持一致。
 */
export function encodeWorkspaceKey(dir) {
  const raw = String(dir)
  let out = ''
  let separatorRun = false
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) out += '-'
      separatorRun = true
    } else if (ch !== '~' && WORKSPACE_SAFE.test(ch)) {
      out += ch
      separatorRun = false
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(out.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 会话目录名是 encodeSegment 的结果，这里做无损逆变换。 */
function decodeSessionSegment(raw) {
  return String(raw).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => (
    String.fromCharCode(parseInt(hex, 16))
  ))
}

/** 远端相对工作区路径，例如 ./projectA（POSIX 分隔符）。 */
function workspaceRelativePath(path, gitRoot) {
  if (!gitRoot) return ''
  const rel = relativeUnder(gitRoot, path)
  if (rel === null) return ''
  return rel === '.' ? './' : `./${toPosixPath(rel)}`
}

/** state/sessions/<rel> 的 rel → 工作区 key / 会话 id / 工作区之后的路径。 */
function parseSessionRel(rel) {
  const parts = String(rel || '').split('/')
  if (parts.length < 3) return null
  const workspaceKey = parts[0]
  if (!workspaceKey) return null
  let sessionId = ''
  try {
    sessionId = decodeSessionSegment(parts[1])
  } catch {
    return null
  }
  if (!sessionId) return null
  return {
    workspaceKey,
    sessionId,
    tail: parts.slice(1),
  }
}

function localSessionTarget(rel, maps, home, meta, gitRoot) {
  const info = parseSessionRel(rel)
  if (!info) return null
  let workspace = maps.bySession.get(info.sessionId)
    || maps.byRemoteKey.get(info.workspaceKey)
    || maps.byLocalKey.get(info.workspaceKey)

  // 清单里带了相对工作区路径时，即使 workspace.json 尚未建立 sessionIds，
  // 也能只靠当前 gitRoot 还原本机绝对路径。
  if (!workspace && meta && typeof meta.sessionWorkspaceRel === 'string' && gitRoot) {
    const relativePath = meta.sessionWorkspaceRel.replace(/\\/g, '/')
    if (relativePath.startsWith('./')) {
      const abs = resolve(gitRoot, ...relativePath.slice(2).split('/').filter(Boolean))
      if (relativeUnder(gitRoot, abs) !== null) {
        workspace = {
          path: abs,
          localKey: encodeWorkspaceKey(abs),
          remoteKey: encodeWorkspaceKey(relativePath),
          relativePath,
        }
      }
    }
  }
  if (!workspace) return null
  return {
    ...info,
    workspace,
    cwd: workspace.path,
    abs: join(home, 'sessions', workspace.localKey, ...info.tail),
  }
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

/** 把本机/远端工作区路径统一成可比较的绝对路径（有 gitRoot 时）。 */
function normalizeWorkspacePath(path, gitRoot) {
  const text = String(path == null ? '' : path).trim()
  if (!text) return ''
  if (isAbsolute(text)) return resolve(text)
  const rel = text.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (!gitRoot) return text
  return resolve(gitRoot, ...rel.split('/').filter(Boolean))
}

/** 工作区路径的稳定比较键：同一目录无论来自 A 还是 B，都必须落在同一组。 */
function workspacePathKey(path, gitRoot) {
  const text = normalizeWorkspacePath(path, gitRoot)
  if (!text) return ''
  if (isAbsolute(text)) {
    return process.platform === 'win32' ? text.toLowerCase() : text
  }
  return `rel:${text}`
}

function workspaceTable(json) {
  const tables = json && json.tables && typeof json.tables === 'object' ? json.tables : {}
  const workspaces = tables.workspaces && typeof tables.workspaces === 'object'
    ? tables.workspaces : {}
  return { tables, workspaces }
}

/** 从 workspace.json 取出工作区列表，供 pull 后自动 checkout 缺失目录。 */
export function workspaceEntries(buffer) {
  const json = parseJsonBuffer(buffer)
  if (!json) return []
  const { workspaces } = workspaceTable(json)
  return Object.entries(workspaces)
    .filter(([, entry]) => entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path)
    .map(([id, entry]) => ({
      id,
      path: entry.path,
      title: typeof entry.title === 'string' ? entry.title : '',
      sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds : [],
    }))
}

/**
 * 工作区注册表 → 三张映射：
 *   localKey  → { path, remoteKey }   本机绝对路径编码 → 远端相对路径编码
 *   remoteKey → { path, localKey }    远端编码 → 本机真实路径
 *   sessionId → { path, localKey }    会话 id → 所属本机工作区
 */
async function readWorkspaceEntries(home) {
  const buffer = await readFileOrNull(join(home, 'storages', 'workspace.json'))
  return buffer ? workspaceEntries(buffer) : []
}

/**
 * 把刚恢复的 sessionId 写回 workspace.json。DSH 的工作区会话列表依赖
 * sessionIds；只把文件放进 sessions/ 目录还不够。
 */
async function addSessionIdsToWorkspaceStore(home, additions, log) {
  if (!additions || additions.size === 0) return false
  const file = join(home, 'storages', 'workspace.json')
  const buffer = await readFileOrNull(file)
  const json = buffer ? parseJsonBuffer(buffer) : null
  const table = json && json.tables && json.tables.workspaces
  if (!table || typeof table !== 'object') return false

  let changed = false
  for (const entry of Object.values(table)) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue
    const ids = additions.get(workspacePathKey(entry.path))
    if (!ids || ids.size === 0) continue
    const next = unionStrings(entry.sessionIds, [...ids])
    if (next.length !== (Array.isArray(entry.sessionIds) ? entry.sessionIds.length : 0)) {
      entry.sessionIds = next
      changed = true
    }
  }
  if (!changed) return false

  try {
    await backupConflict(home, 'storages', 'workspace.json.sessionids', buffer)
    await writeLocalFile(file, Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8'), 0)
    log('workspace.json 已补入远端会话 id')
    return true
  } catch (error) {
    log('workspace.json 补会话 id 失败：' + messageOf(error))
    return false
  }
}

function buildWorkspaceSessionMaps(entries, gitRoot) {
  const byLocalKey = new Map()
  const byRemoteKey = new Map()
  const bySession = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.path !== 'string' || !isAbsolute(entry.path)) continue
    const path = resolve(entry.path)
    const localKey = encodeWorkspaceKey(path)
    const relativePath = gitRoot ? workspaceRelativePath(path, gitRoot) : ''
    const remoteKey = relativePath ? encodeWorkspaceKey(relativePath) : ''
    const value = {
      ...entry,
      path,
      localKey,
      remoteKey,
      relativePath,
    }
    byLocalKey.set(localKey, value)
    if (remoteKey) byRemoteKey.set(remoteKey, value)
    for (const sessionId of entry.sessionIds || []) {
      if (typeof sessionId === 'string' && sessionId) bySession.set(sessionId, value)
    }
  }
  return { byLocalKey, byRemoteKey, bySession }
}

/**
 * 把远端 workspace.json 合并进本机：保留本机工作区，并追加远端工作区。
 *
 * 合并键是「路径」而不是 workspaceId：两台电脑可能各自为同一个目录生成了
 * 不同的 UUID，如果只按 id 合并就会出现两个指向同一目录的重复工作区。
 * 同一路径的条目只保留一个 id（优先本机 id），把双方的 sessionIds 并集写回。
 */
export function mergeWorkspaceStore(localBuffer, remoteBuffer, gitRoot) {
  const remoteMapped = remapWorkspaceStoreForPull(remoteBuffer, gitRoot)
  if (remoteMapped.invalid || remoteMapped.unresolved > 0) {
    return {
      buffer: localBuffer,
      invalid: remoteMapped.invalid,
      unresolved: remoteMapped.unresolved,
      workspaces: localBuffer ? workspaceEntries(localBuffer) : [],
      duplicatesMerged: 0,
      remoteOnly: 0,
    }
  }

  const local = localBuffer ? parseJsonBuffer(localBuffer) : null
  const remote = parseJsonBuffer(remoteMapped.buffer)
  if (localBuffer && !local) {
    return {
      buffer: remoteMapped.buffer,
      invalid: false,
      unresolved: 0,
      workspaces: workspaceEntries(remoteMapped.buffer),
      duplicatesMerged: 0,
      remoteOnly: 0,
    }
  }
  if (!remote) {
    return {
      buffer: localBuffer,
      invalid: true,
      unresolved: 0,
      workspaces: localBuffer ? workspaceEntries(localBuffer) : [],
      duplicatesMerged: 0,
      remoteOnly: 0,
    }
  }

  const localTables = local && local.tables && typeof local.tables === 'object' ? local.tables : {}
  const remoteTables = remote.tables && typeof remote.tables === 'object' ? remote.tables : {}
  const localWorkspaces = workspaceTable(local).workspaces
  const remoteWorkspaces = workspaceTable(remote).workspaces

  // 先按路径分组。本机条目优先，保证本机打开的目录路径/标题尽量不变；
  // 远端独有路径追加在后面。
  const groups = new Map()
  const groupFor = (path) => {
    const normalized = normalizeWorkspacePath(path, gitRoot)
    const key = workspacePathKey(normalized, gitRoot)
    if (!key) return null
    let group = groups.get(key)
    if (!group) {
      group = { key, path: normalized, local: [], remote: [] }
      groups.set(key, group)
    }
    return group
  }

  // 收编迁移后，本地路径已经在大仓内，但远端 workspace.json 仍可能是旧绝对
  // 路径（大仓外）。如果它与某个本地工作区共享 sessionId，就把远端条目
  // 归到本地路径，避免下次同步把旧工作区又加回来。
  const localSessionOwners = new Map()
  for (const [id, entry] of Object.entries(localWorkspaces)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.sessionIds)) continue
    for (const sessionId of entry.sessionIds) {
      if (typeof sessionId !== 'string' || !sessionId) continue
      const owners = localSessionOwners.get(sessionId) || []
      owners.push({ id, entry })
      localSessionOwners.set(sessionId, owners)
    }
  }
  const remapRemoteWorkspacePath = (entry) => {
    if (!gitRoot || !entry || typeof entry.path !== 'string') return entry?.path
    if (relativeUnder(gitRoot, entry.path) !== null) return entry.path

    if (Array.isArray(entry.sessionIds) && entry.sessionIds.length > 0) {
      const candidates = new Map()
      for (const sessionId of entry.sessionIds) {
        for (const owner of localSessionOwners.get(sessionId) || []) {
          candidates.set(owner.id, owner.entry)
        }
      }
      if (candidates.size === 1) {
        const only = [...candidates.values()][0]
        if (only && typeof only.path === 'string') return only.path
      }
      return entry.path
    }

    // 没有 sessionId 的空工作区：按目录名唯一匹配，兼容刚收编但还没有会话的目录。
    const name = basename(entry.path).toLowerCase()
    const sameName = Object.entries(localWorkspaces).filter(([, localEntry]) => (
      localEntry
      && typeof localEntry.path === 'string'
      && basename(localEntry.path).toLowerCase() === name
    ))
    return sameName.length === 1 ? sameName[0][1].path : entry.path
  }
  for (const [id, entry] of Object.entries(localWorkspaces)) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) continue
    const group = groupFor(entry.path)
    if (group) group.local.push({ id, entry: { ...entry, path: group.path } })
  }
  for (const [id, entry] of Object.entries(remoteWorkspaces)) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) continue
    const remotePath = remapRemoteWorkspacePath(entry)
    const group = groupFor(remotePath)
    if (group) group.remote.push({ id, entry: { ...entry, path: group.path } })
  }

  const mergedWorkspaces = {}
  const canonicalByOriginalId = new Map()
  const canonicalIds = []
  const workspaces = []
  let remoteOnly = 0
  let duplicatesMerged = 0

  for (const group of groups.values()) {
    const all = [...group.local, ...group.remote]
    if (!all.length) continue
    if (!group.local.length) remoteOnly += 1
    if (all.length > 1) duplicatesMerged += all.length - 1

    // 最新条目提供标题和扩展字段；路径始终采用本机路径（远端路径已重映射）。
    const sorted = all.slice().sort((a, b) => {
      const left = Date.parse(a.entry.updatedAt) || 0
      const right = Date.parse(b.entry.updatedAt) || 0
      return left - right
    })
    let base = {}
    for (const item of sorted) base = { ...base, ...item.entry }
    const primary = group.local[0] || sorted[sorted.length - 1]
    const path = group.local[0]?.entry.path || primary.entry.path || ''
    const sessionIds = unionStrings(...all.map((item) => item.entry.sessionIds))
    const createdAt = all
      .map((item) => item.entry.createdAt)
      .filter((value) => typeof value === 'string' && value)
      .sort((a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0))[0]
    const updatedAt = latestIso(
      ...all.map((item) => item.entry.updatedAt).filter((value) => typeof value === 'string' && value),
    )
    const title = sorted
      .map((item) => item.entry.title)
      .filter((value) => typeof value === 'string' && value.trim())
      .pop()

    let canonicalId = primary.id
    if (mergedWorkspaces[canonicalId]) {
      // 极端的 id 冲突：保留先出现的条目，换一个稳定后缀，避免丢数据。
      let suffix = 2
      while (mergedWorkspaces[`${canonicalId}-${suffix}`]) suffix += 1
      canonicalId = `${canonicalId}-${suffix}`
    }
    mergedWorkspaces[canonicalId] = {
      ...base,
      path,
      sessionIds,
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(title ? { title } : {}),
    }
    for (const item of all) {
      if (!canonicalByOriginalId.has(item.id)) canonicalByOriginalId.set(item.id, canonicalId)
    }
    canonicalIds.push(canonicalId)
    workspaces.push({
      id: canonicalId,
      path,
      title: mergedWorkspaces[canonicalId].title || '',
      sessionIds,
    })
  }

  const localGlobal = local && local.global && typeof local.global === 'object' ? local.global : {}
  const remoteGlobal = remote.global && typeof remote.global === 'object' ? remote.global : {}
  const mapId = (id) => canonicalByOriginalId.get(id) || id
  const workspaceIds = []
  const addId = (raw) => {
    const id = mapId(raw)
    if (!id || !mergedWorkspaces[id] || workspaceIds.includes(id)) return
    workspaceIds.push(id)
  }
  for (const id of localGlobal.workspaceIds || []) addId(id)
  for (const id of remoteGlobal.workspaceIds || []) addId(id)
  for (const id of canonicalIds) addId(id)

  const localDefault = mapId(localGlobal.defaultWorkspaceId)
  const remoteDefault = mapId(remoteGlobal.defaultWorkspaceId)
  const defaultWorkspaceId = workspaceIds.includes(localDefault)
    ? localDefault
    : (workspaceIds.includes(remoteDefault) ? remoteDefault : (workspaceIds[0] || ''))
  const mergedGlobal = {
    ...remoteGlobal,
    ...localGlobal,
    workspaceIds,
    archivedSessionIds: unionStrings(localGlobal.archivedSessionIds, remoteGlobal.archivedSessionIds),
    pinnedSessionIds: unionStrings(localGlobal.pinnedSessionIds, remoteGlobal.pinnedSessionIds),
    defaultWorkspaceId,
  }

  return {
    buffer: Buffer.from(JSON.stringify({
      ...remote,
      ...local,
      unit: (local && local.unit) || remote.unit,
      global: mergedGlobal,
      tables: {
        ...remoteTables,
        ...localTables,
        workspaces: mergedWorkspaces,
      },
    }, null, 2) + '\n', 'utf8'),
    invalid: false,
    unresolved: 0,
    workspaces,
    duplicatesMerged,
    remoteOnly,
  }
}

function unionStrings(a, b) {
  const out = []
  const seen = new Set()
  for (const value of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function latestIso(...values) {
  let out = ''
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    if (!out || (Date.parse(value) || 0) > (Date.parse(out) || 0)) out = value
  }
  return out
}

async function cleanupSessionCopy(abs, home, log) {
  if (!abs) return
  try {
    await fs.rm(abs, { force: true })
  } catch (error) {
    log('旧格式会话副本删除失败：' + messageOf(error))
    return
  }
  const sessionDir = dirname(abs)
  const workspaceDir = dirname(sessionDir)
  for (const dir of [sessionDir, workspaceDir]) {
    if (!dir || dir === join(home, 'sessions')) break
    try {
      await fs.rmdir(dir)
    } catch {
      break
    }
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

/**
 * 计算一个 zstd frame 的结束偏移。DSH 的会话日志是「每批追加一个 frame」，
 * 一个文件可能有几千个 frame；Node 的 zstdDecompressSync 只解第一个 frame，
 * 所以绝不能整文件解压再压缩，否则会把后面的对话全部丢掉。
 */
function zstdFrameEnd(buffer, start = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < start + 5) return -1
  if (buffer.readUInt32LE(start) !== 0xFD2FB528) return -1
  let pos = start + 4
  const descriptor = buffer[pos]
  pos += 1
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictFlag = descriptor & 3
  if (!singleSegment) pos += 1
  pos += [0, 1, 2, 4][dictFlag]
  pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  while (pos + 3 <= buffer.length) {
    const header = buffer[pos] | (buffer[pos + 1] << 8) | (buffer[pos + 2] << 16)
    pos += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 3) return -1
    pos += type === 1 ? 1 : size
    if (last) {
      if (checksum) pos += 4
      return pos <= buffer.length ? pos : -1
    }
  }
  return -1
}

/**
 * 只解压第一个 frame 拿 header；正文用「第一个 frame 之后的原始密文字节」
 * 计算哈希。这样 A/B 路径不同、只改 header.cwd 时，正文哈希完全不变。
 */
export function readSessionLog(buffer) {
  try {
    const firstEnd = zstdFrameEnd(buffer)
    if (firstEnd <= 0) return null
    const firstText = zstdDecompressSync(buffer.subarray(0, firstEnd)).toString('utf8')
    const newline = firstText.indexOf('\n')
    const hadNewline = newline !== -1
    const headerText = hadNewline ? firstText.slice(0, newline) : firstText
    const header = JSON.parse(headerText)
    if (!header || header.type !== 'session' || typeof header.id !== 'string') return null
    const firstBody = hadNewline ? firstText.slice(newline + 1) : ''
    const bodyBuffer = Buffer.concat([
      Buffer.from(firstBody, 'utf8'),
      buffer.subarray(firstEnd),
    ])
    return {
      header,
      firstEnd,
      firstBody,
      hadNewline,
      bodySha: sha256(bodyBuffer),
    }
  } catch {
    return null
  }
}

/** 只重写第一个 frame 的 header.cwd；后续所有 frame 逐字节保留。 */
export function rewriteSessionLog(buffer, cwd) {
  const info = readSessionLog(buffer)
  if (!info) return { ok: false, reason: '无法解析会话 header' }
  if (info.header.cwd === cwd) {
    return { ok: true, buffer, bodySha: info.bodySha, header: info.header, changed: false }
  }
  const next = {
    ...info.header,
    cwd,
  }
  const firstText = JSON.stringify(next)
    + (info.hadNewline ? '\n' : '')
    + info.firstBody
  const first = zstdCompressSync(Buffer.from(firstText, 'utf8'))
  const bodyBuffer = Buffer.concat([
    Buffer.from(info.firstBody, 'utf8'),
    buffer.subarray(info.firstEnd),
  ])
  return {
    ok: true,
    buffer: Buffer.concat([first, buffer.subarray(info.firstEnd)]),
    bodySha: sha256(bodyBuffer),
    header: next,
    changed: true,
  }
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
      sessionBodySha: typeof meta.sessionBodySha === 'string' ? meta.sessionBodySha : undefined,
      sessionCwd: typeof meta.sessionCwd === 'string' ? meta.sessionCwd : undefined,
      sessionWorkspaceRel: typeof meta.sessionWorkspaceRel === 'string' ? meta.sessionWorkspaceRel : undefined,
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

/**
 * 清单可能落后于实际目录树（例如上一次清单上传失败）。
 * 以目录树补齐缺失条目，但绝不覆盖清单里已有的哈希/时间戳。
 */
function manifestWithTree(manifest, snapshot) {
  const fromTree = manifestFromTree(snapshot)
  const merged = {
    ...(manifest || fromTree),
    files: { ...((manifest && manifest.files) || {}) },
    groups: Array.isArray(manifest && manifest.groups) ? [...manifest.groups] : [],
  }
  for (const [key, meta] of Object.entries(fromTree.files)) {
    if (merged.files[key]) continue
    merged.files[key] = meta
  }
  for (const meta of Object.values(merged.files)) {
    if (meta && meta.group && !merged.groups.includes(meta.group)) merged.groups.push(meta.group)
  }
  return merged
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
    if ((x.sessionBodySha || '') !== (y.sessionBodySha || '')) return false
    if ((x.sessionCwd || '') !== (y.sessionCwd || '')) return false
    if ((x.sessionWorkspaceRel || '') !== (y.sessionWorkspaceRel || '')) return false
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
      ...(stored.sessionBodySha ? { sessionBodySha: stored.sessionBodySha } : {}),
      ...(stored.sessionCwd ? { sessionCwd: stored.sessionCwd } : {}),
      ...(stored.sessionWorkspaceRel ? { sessionWorkspaceRel: stored.sessionWorkspaceRel } : {}),
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

/**
 * Push 前把本地 sessions/ 目录名换成远端标准 key，并把会话 header.cwd
 * 统一成远端已有的 cwd。远端标准 key 是工作区相对路径编码（./projectA），
 * 本地目录名仍然是本机绝对路径编码，DSH 不需要改任何配置。
 */
async function prepareSessionPlanForPush({ plan, home, gitRoot, remoteAll, transport, key, log }) {
  const maps = buildWorkspaceSessionMaps(await readWorkspaceEntries(home), gitRoot)
  const remoteIndex = new Map()
  const remotePathsBySession = new Map()
  for (const meta of Object.values(remoteAll.files || {})) {
    if (!meta || meta.group !== 'sessions') continue
    const parsed = parseStateRepoPath(meta.repoPath) || (
      meta.rel ? parseStateRepoPath(`${statePrefix('sessions')}/${meta.rel}${ENC_SUFFIX}`) : null
    )
    if (!parsed) continue
    const info = parseSessionRel(parsed.rel)
    if (!info) continue
    const paths = remotePathsBySession.get(info.sessionId) || []
    paths.push({ path: parsed.repoPath, tail: info.tail.join('/') })
    remotePathsBySession.set(info.sessionId, paths)
    if (!remoteIndex.has(info.sessionId)) remoteIndex.set(info.sessionId, { meta, parsed, info })
  }

  const selected = new Map()
  for (const file of plan.files) {
    if (file.group !== 'sessions') continue
    const info = parseSessionRel(file.rel)
    if (!info) continue
    const workspace = maps.byLocalKey.get(info.workspaceKey) || maps.bySession.get(info.sessionId)
    const canonicalLocal = workspace && info.workspaceKey === workspace.localKey
    const previous = selected.get(info.sessionId)
    if (previous) {
      const previousCanonical = previous.workspace
        && previous.info.workspaceKey === previous.workspace.localKey
      if (!canonicalLocal || previousCanonical) continue
    }
    selected.set(info.sessionId, { file, info, workspace })
  }

  const canonicalCwd = new Map()
  const removePaths = new Set()
  for (const item of selected.values()) {
    const { file, info, workspace } = item
    const remote = remoteIndex.get(info.sessionId)
    const targetRel = workspace?.remoteKey
      ? [workspace.remoteKey, ...info.tail].join('/')
      : (remote ? remote.parsed.rel : file.rel)

    file.key = `sessions/${targetRel}`
    file.rel = targetRel
    file.repoPath = `${statePrefix('sessions')}/${targetRel}${ENC_SUFFIX}`
    file.sessionId = info.sessionId
    file.workspaceRel = workspace?.relativePath || ''

    try {
      file.localSessionInfo = readSessionLog(await fs.readFile(file.abs))
    } catch {
      file.localSessionInfo = null
    }

    let cwd = remote && typeof remote.meta.sessionCwd === 'string' ? remote.meta.sessionCwd : ''
    if (!cwd && remote) {
      const loaded = await loadRemotePlain(transport, remote.parsed.repoPath, remote.meta, key)
      if (loaded.ok) cwd = readSessionLog(loaded.plain)?.header?.cwd || ''
      else log(`读取远端会话 header 失败，保留本机会话：${remote.parsed.repoPath}`)
    }
    if (cwd) canonicalCwd.set(file.key, cwd)

    const tailKey = info.tail.join('/')
    for (const entry of remotePathsBySession.get(info.sessionId) || []) {
      if (entry.tail === tailKey && entry.path !== file.repoPath) removePaths.add(entry.path)
    }
  }

  plan.files = [
    ...plan.files.filter((file) => file.group !== 'sessions'),
    ...selected.values().map((item) => item.file),
  ]
  return { canonicalCwd, removePaths }
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
    const remoteAll = manifestWithTree(remoteManifest, snapshot)

    // 上传 workspace.json 前再和远端做一次路径并集，防止 pull 之后 DSH 又
    // 写回本机版本，或 pull 因冲突保留了本机旧版时把对方新工作区覆盖掉。
    let remoteWorkspacePlain = null
    const remoteWorkspacePath = 'state/storages/workspace.json.dshx'
    if (snapshot.files.has(remoteWorkspacePath) && remoteAll.files['storages/workspace.json']) {
      const loaded = await loadRemotePlain(
        transport,
        remoteWorkspacePath,
        remoteAll.files['storages/workspace.json'],
        key,
      )
      if (!loaded.ok) {
        throw new SyncError(
          'state',
          '无法读取远端 workspace.json，已停止上传以保护远端工作区：' + loaded.reason,
        )
      }
      remoteWorkspacePlain = loaded.plain
    }

    const sessionPlan = await prepareSessionPlanForPush({
      plan,
      home,
      gitRoot: options.gitRoot,
      remoteAll,
      transport,
      key,
      log,
    })

    const maxBytes = Math.max(1, Number(config.maxFileMb) || 45) * 1024 * 1024
    const encrypted = new Map()

    for (const file of plan.files) {
      let plain
      try {
        plain = await fs.readFile(file.abs)
      } catch (error) {
        plan.skipped.push({
          group: file.group,
          rel: file.rel,
          size: file.size,
          repoPath: file.repoPath,
          reason: '读取失败：' + messageOf(error),
        })
        continue
      }

      if (isWorkspaceStore(file)) {
        // 本机绝对路径 + 远端 ./相对路径 → 按工作区路径并集，再转成 ./ 后上传。
        if (remoteWorkspacePlain) {
          const mergedWorkspace = mergeWorkspaceStore(plain, remoteWorkspacePlain, options.gitRoot)
          if (mergedWorkspace.invalid) {
            throw new SyncError('state', '无法合并远端 workspace.json，已停止上传以保护工作区')
          }
          if (mergedWorkspace.unresolved > 0) {
            throw new SyncError('state', '远端 workspace.json 含 ./ 路径但当前没有 gitRoot，已停止上传')
          }
          plain = mergedWorkspace.buffer
        }
        plain = remapWorkspaceStoreForPush(plain, options.gitRoot)
      }

      let sessionInfo = file.localSessionInfo || null
      if (file.group === 'sessions') {
        const canonical = sessionPlan.canonicalCwd.get(file.key)
        if (canonical) {
          const rewritten = rewriteSessionLog(plain, canonical)
          if (rewritten.ok) {
            plain = rewritten.buffer
            sessionInfo = {
              header: rewritten.header,
              bodySha: rewritten.bodySha,
            }
          } else {
            log(`会话 header 无法解析，保留本机 cwd 上传：${file.rel}`)
          }
        }
        if (!sessionInfo) sessionInfo = readSessionLog(plain)
      }

      if (plain.length > maxBytes) {
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
        ...(sessionInfo?.bodySha ? { sessionBodySha: sessionInfo.bodySha } : {}),
        ...(sessionInfo?.header?.cwd ? { sessionCwd: sessionInfo.header.cwd } : {}),
        ...(file.workspaceRel ? { sessionWorkspaceRel: file.workspaceRel } : {}),
      })
    }

    const usableFiles = plan.files.filter((file) => encrypted.has(file.key))
    let manifest = buildManifest({
      plan: { ...plan, files: usableFiles },
      encrypted,
      config,
      groups: plan.groups,
    })
    // 双向并集的关键：远端有、本机这次没扫描到的文件，全部保留在清单里。
    // 绝不因为「本机没有」就删除远端会话；删除不是同步目标，防覆盖才是。
    let preservedRemote = 0
    for (const [keyName, meta] of Object.entries(remoteAll.files || {})) {
      if (manifest.files[keyName]) continue
      const parsed = parseStateRepoPath(meta.repoPath) || (
        meta.group && meta.rel ? parseStateRepoPath(`${statePrefix(meta.group)}/${meta.rel}${ENC_SUFFIX}`) : null
      )
      if (!parsed || !snapshot.files.has(parsed.repoPath)) continue
      if (sessionPlan.removePaths.has(parsed.repoPath)) continue
      manifest.files[keyName] = {
        ...meta,
        repoPath: parsed.repoPath,
      }
      if (!manifest.groups.includes(parsed.group)) manifest.groups.push(parsed.group)
      preservedRemote += 1
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

    // 旧格式的绝对路径会话已迁移到标准 key，旧的远端副本要在同一个原子
    // 提交里删除；否则下次 pull 会看到同 id 的两份会话。
    let migrated = 0
    for (const path of sessionPlan.removePaths) {
      if (!snapshot.files.has(path) || want.has(path)) continue
      changes.push({ path, buffer: null })
      migrated += 1
    }

    // 不做其它自动远端删除：本机暂时没有扫描到的会话可能只是另一台电脑
    // 刚建的。远端旧文件保持不动；清单始终是本地 + 远端的并集。
    if (!changes.length) {
      await writeBaseline(home, remoteManifest || manifest)
      return {
        ok: true,
        pushed: false,
        unchanged: true,
        files: usableFiles.length,
        uploaded: 0,
        deleted: 0,
        migrated,
        preservedRemote,
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
      deleted: migrated,
      migrated,
      preservedRemote,
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
        workspaces: 0,
        workspaceRestore: null,
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
    // 清单可能漏掉目录树里的会话（例如上次只上传了 blob 没更新清单），
    // pull 时按目录树补齐，保证远端已有的会话都能下载。
    const manifest = manifestWithTree(remoteManifest || manifestFromTree(snapshot), snapshot)
    const entries = Object.entries(manifest.files || {})
    // workspace.json 必须先处理：会话目录重映射依赖合并后的工作区注册表。
    entries.sort(([, left], [, right]) => {
      const rank = (meta) => (meta && meta.group === 'storages' && meta.rel === 'workspace.json' ? 0 : 1)
      return rank(left) - rank(right)
    })

    if (!entries.length) {
      return {
        ok: true,
        empty: true,
        applied: 0,
        unchanged: 0,
        files: 0,
        workspaces: 0,
        workspaceRestore: null,
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
    let mergedWorkspaceEntries = await readWorkspaceEntries(home)
    let sessionMaps = buildWorkspaceSessionMaps(mergedWorkspaceEntries, options.gitRoot)
    let workspaceRestore = null
    const sessionWorkspaceAdds = new Map()

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
      let target = mapRepoPathToLive(repoPath, home)
      let sessionTarget = null
      let sessionOriginal = null
      if (parsed.group === 'sessions') {
        sessionTarget = localSessionTarget(parsed.rel, sessionMaps, home, meta, options.gitRoot)
        if (sessionTarget) {
          if (target && resolve(target.abs) !== resolve(sessionTarget.abs)) {
            sessionOriginal = target
          }
          target = { abs: sessionTarget.abs, group: 'sessions', rel: parsed.rel }
        }
      }
      if (!target) {
        skipped.push({ key: keyName, reason: '无法映射到本机路径' })
        continue
      }

      let localBuffer = null
      let localMtime = 0
      let migratedFrom = ''
      try {
        localBuffer = await fs.readFile(target.abs)
        localMtime = (await fs.stat(target.abs)).mtimeMs
      } catch {
        // 本地旧格式目录名（绝对路径编码）里可能已有同一会话，先当成 local
        // 参与合并；写入新目录后再删旧副本。
        if (sessionOriginal) {
          try {
            localBuffer = await fs.readFile(sessionOriginal.abs)
            localMtime = (await fs.stat(sessionOriginal.abs)).mtimeMs
            migratedFrom = sessionOriginal.abs
          } catch {
            /* 新旧目录都没有 */
          }
        }
      }

      const isConfig = parsed.group === 'configs'
      const isWorkspace = isWorkspaceStore(parsed)
      const localCompare = localBuffer && isWorkspace
        ? remapWorkspaceStoreForPush(localBuffer, options.gitRoot)
        : localBuffer

      // workspace.json 必须按工作区合并，不能整文件覆盖。
      if (isWorkspace) {
        if (localBuffer && meta.sha256 && sha256(localCompare) === meta.sha256) {
          unchanged.push(keyName)
          mergedWorkspaceEntries = workspaceEntries(localBuffer)
          sessionMaps = buildWorkspaceSessionMaps(mergedWorkspaceEntries, options.gitRoot)
          continue
        }
        const workspaceLoaded = await loadRemotePlain(transport, repoPath, meta, key)
        if (!workspaceLoaded.ok) {
          skipped.push({ key: keyName, reason: workspaceLoaded.reason })
          continue
        }
        const merged = mergeWorkspaceStore(localBuffer, workspaceLoaded.plain, options.gitRoot)
        if (merged.invalid) {
          skipped.push({ key: keyName, reason: '远端 workspace.json 不是合法 JSON，未覆盖本机' })
          continue
        }
        if (merged.unresolved > 0) {
          skipped.push({
            key: keyName,
            reason: '远端 workspace.json 含 ./ 路径，但当前没有 gitRoot，无法重映射；保留本机',
          })
          continue
        }
        mergedWorkspaceEntries = merged.workspaces || workspaceEntries(merged.buffer)
        sessionMaps = buildWorkspaceSessionMaps(mergedWorkspaceEntries, options.gitRoot)
        if (localBuffer && merged.buffer.equals(localBuffer)) {
          unchanged.push(keyName)
          continue
        }
        const backup = localBuffer
          ? await backupConflict(home, parsed.group, parsed.rel, localBuffer)
          : null
        try {
          await writeLocalFile(target.abs, merged.buffer, meta.mtime)
        } catch (error) {
          skipped.push({ key: keyName, reason: '写入失败：' + messageOf(error) })
          continue
        }
        applied.push({ key: keyName, backup })
        const detail = merged.duplicatesMerged > 0
          ? `，按路径合并 ${merged.duplicatesMerged} 个重复项`
          : ''
        log('workspace.json 已合并远端工作区' + detail + '，本机旧版已备份到 ' + (backup || '（无）'))
        continue
      }

      let sessionPreparedPlain = null
      const oldSessionCopy = migratedFrom || (sessionOriginal ? sessionOriginal.abs : '')
      const writeSessionTarget = async (buffer, mtime) => {
        let output = buffer
        if (sessionTarget?.cwd && /\.jsonl\.zstd$/i.test(target.abs)) {
          const rewritten = rewriteSessionLog(output, sessionTarget.cwd)
          if (!rewritten.ok) return { ok: false, reason: rewritten.reason }
          output = rewritten.buffer
        }
        try {
          await writeLocalFile(target.abs, output, mtime)
          return { ok: true, buffer: output }
        } catch (error) {
          return { ok: false, reason: '写入失败：' + messageOf(error) }
        }
      }

      // 会话先看 body：只有 cwd 不同（header 的绝对路径不同）时，
      // 绝不能当成内容冲突。直接把本地文件改写成本机 cwd 即可。
      if (parsed.group === 'sessions' && sessionTarget) {
        const localInfo = localBuffer ? readSessionLog(localBuffer) : null
        const localHash = localBuffer ? sha256(localBuffer) : ''
        const remoteBody = typeof meta.sessionBodySha === 'string' ? meta.sessionBodySha : ''
        let remoteInfo = null
        let preparedPlain = null

        if (localInfo && remoteBody && localInfo.bodySha === remoteBody) {
          if (localInfo.header.cwd !== sessionTarget.cwd) {
            const written = await writeSessionTarget(localBuffer, localMtime)
            if (!written.ok) {
              skipped.push({ key: keyName, reason: written.reason })
              continue
            }
            applied.push({ key: keyName, backup: null })
            log('会话目录已迁移到本机工作区：' + parsed.rel)
          } else {
            unchanged.push(keyName)
          }
          await cleanupSessionCopy(oldSessionCopy, home, log)
          continue
        }

        if (localInfo && !remoteBody) {
          const loaded = await loadRemotePlain(transport, repoPath, meta, key)
          if (loaded.ok) {
            remoteInfo = readSessionLog(loaded.plain)
            if (remoteInfo && remoteInfo.bodySha === localInfo.bodySha) {
              const rewritten = rewriteSessionLog(loaded.plain, sessionTarget.cwd)
              if (!rewritten.ok) {
                skipped.push({ key: keyName, reason: rewritten.reason })
                continue
              }
              const written = await writeSessionTarget(rewritten.buffer, meta.mtime)
              if (!written.ok) {
                skipped.push({ key: keyName, reason: written.reason })
                continue
              }
              applied.push({ key: keyName, backup: null })
              await cleanupSessionCopy(oldSessionCopy, home, log)
              continue
            }
            if (remoteInfo) {
              const rewritten = rewriteSessionLog(loaded.plain, sessionTarget.cwd)
              if (rewritten.ok) preparedPlain = rewritten.buffer
            }
          }
        }

        if (!preparedPlain && localBuffer && meta.sha256 && localHash === meta.sha256) {
          unchanged.push(keyName)
          await cleanupSessionCopy(oldSessionCopy, home, log)
          continue
        }
        if (preparedPlain) {
          sessionPreparedPlain = preparedPlain
        }
      }

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
          const remoteMtime = Number(meta.mtime) || 0
          const bothChanged = Boolean(baseHash) && localHash !== baseHash && meta.sha256 !== baseHash
          const noBaseConflict = !baseHash && localHash !== meta.sha256
          const keepLocal = bothChanged
            ? localMtime > baseMtime
            : (noBaseConflict && remoteMtime <= localMtime + MTIME_TOLERANCE_MS)

          // 双机都改过同名会话，且本机不旧于远端：
          // 绝不覆盖本机，远端版本另存为 <name>.remote.jsonl.zstd。
          if (parsed.group === 'sessions' && keepLocal) {
            const loaded = sessionPreparedPlain
              ? { ok: true, plain: sessionPreparedPlain }
              : await loadRemotePlain(transport, repoPath, meta, key)
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
              reason: baseHash
                ? '双方都修改了该会话；已保留本地，远端版本另存为 ' + remoteCopy
                : '首次同步时双方都有同名会话；已保留本地，远端版本另存为 ' + remoteCopy,
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

      const loaded = sessionPreparedPlain
        ? { ok: true, plain: sessionPreparedPlain }
        : await loadRemotePlain(transport, repoPath, meta, key)
      if (!loaded.ok) {
        skipped.push({ key: keyName, reason: loaded.reason })
        continue
      }
      let plain = loaded.plain

      if (isCorruptSessionLog(parsed.rel, plain)) {
        skipped.push({
          key: keyName,
          reason: '不是合法的 zstd 会话日志；写入它会让 DSH 无法启动，已跳过',
        })
        continue
      }
      if (parsed.group === 'sessions' && sessionTarget) {
        const written = await writeSessionTarget(plain, meta.mtime)
        if (!written.ok) {
          skipped.push({ key: keyName, reason: written.reason })
          continue
        }
        await cleanupSessionCopy(oldSessionCopy, home, log)
      } else {
        try {
          await writeLocalFile(target.abs, plain, meta.mtime)
        } catch (error) {
          skipped.push({ key: keyName, reason: '写入失败：' + messageOf(error) })
          continue
        }
      }
      applied.push({ key: keyName, backup: backedUp })
    }

    const successfulSessionKeys = new Set()
    for (const item of applied) {
      if (typeof item.key === 'string' && item.key.startsWith('sessions/')) successfulSessionKeys.add(item.key)
    }
    for (const item of unchanged) {
      if (typeof item === 'string' && item.startsWith('sessions/')) successfulSessionKeys.add(item)
    }
    for (const item of keptLocal) {
      if (item && typeof item.key === 'string' && item.key.startsWith('sessions/')) successfulSessionKeys.add(item.key)
    }
    for (const item of conflicts) {
      if (item && typeof item.key === 'string' && item.key.startsWith('sessions/')) successfulSessionKeys.add(item.key)
    }
    for (const keyName of successfulSessionKeys) {
      const rel = keyName.slice('sessions/'.length)
      const sessionTarget = localSessionTarget(rel, sessionMaps, home, manifest.files[keyName], options.gitRoot)
      if (!sessionTarget?.workspace?.path) continue
      const pathKey = workspacePathKey(sessionTarget.workspace.path)
      const ids = sessionWorkspaceAdds.get(pathKey) || new Set()
      ids.add(sessionTarget.sessionId)
      sessionWorkspaceAdds.set(pathKey, ids)
    }

    if (sessionWorkspaceAdds.size > 0) {
      const added = await addSessionIdsToWorkspaceStore(home, sessionWorkspaceAdds, log)
      if (added) {
        mergedWorkspaceEntries = await readWorkspaceEntries(home)
        sessionMaps = buildWorkspaceSessionMaps(mergedWorkspaceEntries, options.gitRoot)
      }
    }

    // 远端工作区已经合并进本地 workspace.json。路径在本地不存在的，
    // 交给 Host 层从代码大仓 checkout（sync-core 不直接依赖 lib/git.js）。
    if (mergedWorkspaceEntries.length && typeof options.ensureWorkspaceDirs === 'function') {
      try {
        workspaceRestore = await options.ensureWorkspaceDirs({
          gitRoot: options.gitRoot || '',
          branch: options.branch || '',
          workspaces: mergedWorkspaceEntries,
        })
      } catch (error) {
        workspaceRestore = {
          ok: false,
          error: messageOf(error),
          restored: 0,
          created: 0,
          failed: 1,
        }
        log('自动补齐工作区目录失败：' + messageOf(error))
      }
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
      workspaces: mergedWorkspaceEntries.length,
      workspaceRestore,
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
