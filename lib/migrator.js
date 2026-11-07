/**
 * 一键收编旧工作区。
 *
 * 旧工作区是 workspace.json 里登记、但不在代码大仓 gitRoot 下的目录。
 * 本模块会把目录移动进大仓，并把 sessions/<旧绝对路径 key>/ 下的会话
 * 目录重命名为 <新绝对路径 key>/，同时用 sync-core 的 header 重写能力
 * 把每个 zstd 会话的第一个 frame 的 cwd 改成新路径。
 */
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { findGitRoot, runGit } from './git.js'
import {
  conflictsDir,
  mkdirp,
  resolveHome,
  stateDir,
  writeFileAtomic,
} from './config.js'
import {
  encodeWorkspaceKey,
  readSessionLog,
  rewriteSessionLog,
} from './sync-core.js'

const SESSION_EXCLUDE = new Set(['session.lock', 'session_projcache.json'])

export class MigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

function messageOf(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

function samePath(a, b) {
  const left = resolve(String(a || ''))
  const right = resolve(String(b || ''))
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** child 在 parent 之下时返回相对路径；parent 本身返回 ''；否则 null。 */
function relativeUnder(parent, child) {
  if (!parent || !child) return null
  const rel = relative(resolve(parent), resolve(child))
  if (!rel) return ''
  if (
    isAbsolute(rel)
    || rel === '..'
    || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || rel.startsWith('../')
    || rel.startsWith('..\\')
  ) {
    return null
  }
  return rel
}

async function pathStat(path) {
  try {
    return await fs.lstat(path)
  } catch {
    return null
  }
}

async function pathExists(path) {
  return Boolean(await pathStat(path))
}

async function walkFiles(root, prefix = '', out = []) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return out
    throw error
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = join(root, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await walkFiles(abs, rel, out)
    } else if (entry.isFile()) {
      out.push({ abs, rel })
    }
  }
  return out
}

function isTransientSessionFile(name) {
  if (SESSION_EXCLUDE.has(name)) return true
  if (name.endsWith('.tmp')) return true
  if (name.startsWith('.dsh-mkdir')) return true
  return false
}

async function backupFile(home, label, buffer) {
  const dir = join(conflictsDir(home), 'migrate')
  await mkdirp(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = String(label).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  const target = join(dir, `${safe}.${stamp}-${randomBytes(3).toString('hex')}.bak`)
  await fs.writeFile(target, buffer)
  return target
}

async function movePath(source, target) {
  await mkdirp(dirname(target))
  try {
    await fs.rename(source, target)
    return
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error
  }

  try {
    await fs.cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
    await fs.rm(source, { recursive: true, force: true })
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function uniqueDestination(root, source) {
  const name = basename(resolve(source))
  if (!name) throw new MigrationError('path', `无法从路径得到目录名：${source}`)
  let candidate = join(root, name)
  let suffix = 2
  while (await pathExists(candidate)) {
    candidate = join(root, `${name}-${suffix}`)
    suffix += 1
  }
  return candidate
}

/** 新目录不存在时直接 rename；已存在时逐文件合并，不覆盖已有会话。 */
async function mergeStaging(staging, targetDir, home, report) {
  const files = await walkFiles(staging)
  let conflicts = 0
  for (const file of files) {
    const target = join(targetDir, ...file.rel.split('/'))
    if (await pathExists(target)) {
      const [incoming, existing] = await Promise.all([
        fs.readFile(file.abs),
        fs.readFile(target).catch(() => null),
      ])
      if (existing && incoming.equals(existing)) {
        await fs.rm(file.abs, { force: true })
        continue
      }
      const backup = await backupFile(home, `session-${file.rel}`, incoming)
      report.warnings.push(`会话文件冲突，已备份新版本：${backup}`)
      conflicts += 1
      await fs.rm(file.abs, { force: true })
      continue
    }
    await mkdirp(dirname(target))
    await fs.rename(file.abs, target)
  }
  await fs.rm(staging, { recursive: true, force: true })
  return conflicts
}

async function rewriteInPlace({ home, oldDir, oldPath, newPath, report }) {
  const files = await walkFiles(oldDir)
  const pending = []
  for (const file of files) {
    if (!/\.jsonl\.zstd$/i.test(file.rel)) continue
    const buffer = await fs.readFile(file.abs)
    const info = readSessionLog(buffer)
    if (!info) {
      report.warnings.push(`跳过无法解析的会话：${file.abs}`)
      continue
    }
    if (!samePath(info.header.cwd, oldPath)) {
      report.warnings.push(`会话 header 不属于旧工作区，跳过：${file.abs}`)
      continue
    }
    const rewritten = rewriteSessionLog(buffer, newPath)
    if (!rewritten.ok) {
      report.warnings.push(`会话 header 改写失败，跳过：${file.abs}（${rewritten.reason}）`)
      continue
    }
    const st = await fs.stat(file.abs)
    pending.push({ abs: file.abs, buffer: rewritten.buffer, mtimeMs: st.mtimeMs })
  }

  for (const item of pending) {
    await writeFileAtomic(item.abs, item.buffer)
    const date = new Date(item.mtimeMs)
    try {
      await fs.utimes(item.abs, date, date)
    } catch {
      /* 某些文件系统不允许改时间 */
    }
  }
  return pending.length
}

/**
 * 迁移一个工作区的 sessions/<key> 目录。
 *
 * 先写到 one-sync 下的 staging，全部 header 改写成功后才提交到新 key；
 * 中途失败会删掉 staging，旧目录保持不动。
 */
async function migrateSessionDir({ home, oldPath, newPath, oldKey, newKey, report, log }) {
  const oldDir = join(home, 'sessions', oldKey)
  const newDir = join(home, 'sessions', newKey)
  const oldStat = await pathStat(oldDir)
  if (!oldStat) {
    return { ok: true, skipped: true, reason: '没有对应 session 目录' }
  }
  if (!oldStat.isDirectory()) {
    return { ok: false, error: `session 路径不是目录：${oldDir}` }
  }

  if (oldKey === newKey) {
    try {
      const rewritten = await rewriteInPlace({ home, oldDir, oldPath, newPath, report })
      return { ok: true, rewritten, inPlace: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  const staging = join(
    stateDir(home),
    `migrate-stage-${Date.now()}-${randomBytes(4).toString('hex')}`,
  )
  try {
    await mkdirp(staging)
    const files = await walkFiles(oldDir)
    for (const file of files) {
      if (isTransientSessionFile(basename(file.rel))) continue
      let buffer = await fs.readFile(file.abs)
      if (/\.jsonl\.zstd$/i.test(file.rel)) {
        const info = readSessionLog(buffer)
        if (!info) {
          throw new Error(`无法解析旧会话 header：${file.abs}`)
        }
        if (!samePath(info.header.cwd, oldPath)) {
          throw new Error(`旧会话 header 不属于该工作区：${file.abs}`)
        }
        const rewritten = rewriteSessionLog(buffer, newPath)
        if (!rewritten.ok) throw new Error(`会话 header 改写失败：${file.abs}（${rewritten.reason}）`)
        buffer = rewritten.buffer
      }
      const dest = join(staging, ...file.rel.split('/'))
      await mkdirp(dirname(dest))
      await fs.writeFile(dest, buffer)
      try {
        const st = await fs.stat(file.abs)
        const date = new Date(st.mtimeMs)
        await fs.utimes(dest, date, date)
      } catch {
        /* 时间戳失败不影响内容 */
      }
    }

    let conflicts = 0
    const newStat = await pathStat(newDir)
    if (!newStat) {
      await movePath(staging, newDir)
    } else if (newStat.isDirectory()) {
      conflicts = await mergeStaging(staging, newDir, home, report)
    } else {
      throw new Error(`目标 session 路径已存在且不是目录：${newDir}`)
    }

    await fs.rm(oldDir, { recursive: true, force: true })
    log(`会话目录已重映射：${oldKey} -> ${newKey}`)
    return {
      ok: true,
      rewritten: files.filter((file) => /\.jsonl\.zstd$/i.test(file.rel)).length,
      conflicts,
      from: oldKey,
      to: newKey,
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: messageOf(error) }
  }
}

async function cloneRoot({ targetRoot, token, repoUrl, log }) {
  if (!repoUrl) {
    throw new MigrationError(
      'clone',
      `目标目录不存在：${targetRoot}\n请同时填写代码大仓地址（repoUrl），或先手动 clone 到该目录。`,
    )
  }
  await mkdirp(dirname(targetRoot))
  log('目标目录不存在，正在 clone 代码大仓…')
  try {
    await runGit(['clone', repoUrl, targetRoot], {
      cwd: dirname(targetRoot),
      token,
      timeoutMs: 300000,
    })
  } catch (error) {
    throw new MigrationError('clone', `clone 代码大仓失败：${messageOf(error)}`)
  }
}

async function openRoot({ targetRoot, token, repoUrl, log }) {
  let cloned = false
  let stat = await pathStat(targetRoot)
  if (!stat) {
    await cloneRoot({ targetRoot, token, repoUrl, log })
    cloned = true
    stat = await pathStat(targetRoot)
  } else if (stat.isDirectory() && repoUrl) {
    const entries = await fs.readdir(targetRoot).catch(() => [])
    if (entries.length === 0) {
      await cloneRoot({ targetRoot, token, repoUrl, log })
      cloned = true
      stat = await pathStat(targetRoot)
    }
  }

  if (!stat || !stat.isDirectory()) {
    throw new MigrationError('path', `目标根目录不存在或不是文件夹：${targetRoot}`)
  }

  const found = await findGitRoot(targetRoot, { token })
  if (!found.ok || !found.root) {
    throw new MigrationError(
      'git',
      `目标目录不在 Git 仓库中：${targetRoot}\n${found.error || ''}\n` +
      '请先在目标目录执行 git init / git clone，或把代码大仓地址填上。',
    )
  }
  const root = resolve(found.root)
  if (!samePath(root, targetRoot)) {
    log(`目标目录是 Git 子目录，使用仓库根目录：${root}`)
  }
  return { root, cloned }
}

function isUnsafeWorkspacePath(path, root, home) {
  const driveRoot = parse(resolve(path)).root
  if (samePath(path, driveRoot)) return '不能迁移磁盘根目录'
  if (samePath(path, root)) return '目标根目录本身不能迁移'
  if (relativeUnder(path, root) !== null) return '目标根目录位于该旧工作区内'
  if (relativeUnder(home, path) !== null) return '不能迁移 DSH 状态目录'
  if (relativeUnder(path, home) !== null) return '该旧工作区包含 DSH 状态目录'
  return ''
}

/**
 * 把 workspace.json 中位于 targetRoot 外的旧工作区收编进大仓。
 *
 * @param {object} options
 * @param {string} options.targetRoot 代码大仓根目录（不存在时可 clone）
 * @param {string} [options.token] GitHub token，用于 clone 私有仓库
 * @param {string} [options.repoUrl] targetRoot 不存在时的 clone 地址
 * @param {string} [options.home] 测试用 $DSH_HOME
 * @param {function} [options.log] 进度日志
 */
export async function migrateToMonorepo(options = {}) {
  const home = resolveHome(options.home)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const rawTarget = String(options.targetRoot || '').trim()
  if (!rawTarget) throw new MigrationError('config', '请填写目标代码大仓根目录（targetRoot）。')
  if (!isAbsolute(rawTarget)) {
    throw new MigrationError('config', `目标根目录必须是绝对路径：${rawTarget}`)
  }

  const opened = await openRoot({
    targetRoot: resolve(rawTarget),
    token: String(options.token || '').trim(),
    repoUrl: String(options.repoUrl || '').trim(),
    log,
  })
  const root = opened.root
  const workspaceFile = join(home, 'storages', 'workspace.json')
  let raw
  try {
    raw = await fs.readFile(workspaceFile)
  } catch {
    throw new MigrationError('workspace', `找不到工作区注册表：${workspaceFile}`)
  }
  let doc
  try {
    doc = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new MigrationError('workspace', `workspace.json 不是合法 JSON：${workspaceFile}`)
  }
  const table = doc && doc.tables && doc.tables.workspaces
  if (!table || typeof table !== 'object') {
    throw new MigrationError('workspace', `workspace.json 缺少 tables.workspaces：${workspaceFile}`)
  }

  const backup = await backupFile(home, 'workspace.json', raw)
  const report = {
    ok: true,
    targetRoot: root,
    cloned: opened.cloned,
    workspaceFile,
    backup,
    moved: [],
    skipped: [],
    warnings: [],
    errors: [],
  }

  const writeWorkspace = async () => {
    await writeFileAtomic(
      workspaceFile,
      Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8'),
    )
  }

  const items = []
  for (const [id, entry] of Object.entries(table)) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue
    if (!isAbsolute(entry.path)) {
      report.skipped.push({ id, path: entry.path, reason: '不是绝对路径' })
      continue
    }
    const oldPath = resolve(entry.path)
    if (relativeUnder(root, oldPath) !== null) continue // 已在大仓内

    const unsafe = isUnsafeWorkspacePath(oldPath, root, home)
    if (unsafe) {
      report.skipped.push({ id, path: oldPath, reason: unsafe })
      continue
    }

    const stat = await pathStat(oldPath)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      report.skipped.push({ id, path: oldPath, reason: '旧工作区不存在或不是普通文件夹' })
      continue
    }
    if (await pathExists(join(oldPath, '.git'))) {
      report.warnings.push(`旧工作区自带 .git，移动后会成为嵌套仓库：${oldPath}`)
    }
    items.push({ id, entry, oldPath })
  }

  // 嵌套工作区先处理更深的目录，避免父目录移动后子目录路径失效。
  items.sort((left, right) => right.oldPath.length - left.oldPath.length)

  for (const item of items) {
    const { id, entry, oldPath } = item
    let dest
    try {
      dest = await uniqueDestination(root, oldPath)
    } catch (error) {
      report.errors.push(`目标路径生成失败：${oldPath}：${messageOf(error)}`)
      continue
    }

    log(`收编工作区：${oldPath} -> ${dest}`)
    try {
      await movePath(oldPath, dest)
    } catch (error) {
      report.errors.push(`移动失败：${oldPath} -> ${dest}：${messageOf(error)}`)
      continue
    }

    const oldKey = encodeWorkspaceKey(oldPath)
    const newKey = encodeWorkspaceKey(dest)
    const sessionResult = await migrateSessionDir({
      home,
      oldPath,
      newPath: dest,
      oldKey,
      newKey,
      report,
      log,
    })
    if (!sessionResult.ok) {
      report.errors.push(`会话迁移失败：${oldPath}：${sessionResult.error}`)
    }

    entry.path = dest
    try {
      await writeWorkspace()
    } catch (error) {
      report.errors.push(`workspace.json 写入失败：${messageOf(error)}`)
      break
    }
    report.moved.push({
      id,
      from: oldPath,
      to: dest,
      sessions: sessionResult,
    })
  }

  report.ok = report.errors.length === 0
  if (!report.ok) {
    report.text = `迁移未完全完成：${report.errors[0]}`
  } else if (report.moved.length === 0) {
    report.text = '没有需要收编的旧工作区。'
  } else {
    report.text = '迁移完成，建议立即执行一键同步并重启 DSH'
  }
  return report
}
