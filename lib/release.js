/**
 * 插件自发布：只操作临时克隆，绝不在工作区执行 git init。
 *
 * 发布目标固定为公开仓，发布前先在临时目录比较最新 tag；
 * 版本、CHANGELOG、commit、annotated tag 和 atomic push 都在临时目录完成。
 */
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const RELEASE_REPO = 'zroNzero/dsh-one-sync'
const GIT_TIMEOUT_MS = 180_000
const MAX_BUFFER = 16 * 1024 * 1024
const PAYLOAD = [
  'index.js',
  'client.js',
  'lib',
  'scripts',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
  '.github/workflows/release.yml',
  '.github/scripts/release-notes.mjs',
]

export class ReleaseError extends Error {
  constructor(message, code = 'release') {
    super(message)
    this.name = 'ReleaseError'
    this.code = code
  }
}

function redact(text, token) {
  const value = String(text == null ? '' : text)
  if (!token) return value
  return value.split(token).join('***')
}

async function git(cwd, args, options = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(options.env || {}),
      },
    })
    return String(result.stdout || '').trim()
  } catch (error) {
    const detail = [error && error.message, error && error.stderr, error && error.stdout]
      .filter(Boolean)
      .join('\n')
    throw new ReleaseError(redact(detail || 'git 命令失败', options.token))
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

function parseRepo(value) {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    throw new ReleaseError('发布仓库名不合法')
  }
  return text
}

function normalizeBump(value) {
  return ['patch', 'minor', 'major'].includes(value) ? value : 'minor'
}

function semverOf(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new ReleaseError(`无法识别版本号：${value}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function bumpVersion(current, bump) {
  const version = semverOf(current)
  if (bump === 'major') return `${version.major + 1}.0.0`
  if (bump === 'minor') return `${version.major}.${version.minor + 1}.0`
  return `${version.major}.${version.minor}.${version.patch + 1}`
}

function tagVersion(tag) {
  return String(tag || '').replace(/^v/, '')
}

function newerVersion(left, right) {
  if (!right) return left
  const a = semverOf(left)
  const b = semverOf(right)
  if (a.major !== b.major) return a.major > b.major ? left : right
  if (a.minor !== b.minor) return a.minor > b.minor ? left : right
  return a.patch >= b.patch ? left : right
}

async function latestTag(cwd) {
  const tags = await git(cwd, ['tag', '--list', 'v*', '--sort=-v:refname'])
  return tags.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
}

async function removePayload(cwd) {
  for (const item of PAYLOAD) {
    await fs.rm(join(cwd, item), { recursive: true, force: true })
  }
}

async function copyPayload(sourceDir, cwd) {
  for (const item of PAYLOAD) {
    const from = join(sourceDir, item)
    let stat
    try {
      stat = await fs.stat(from)
    } catch {
      continue
    }
    const to = join(cwd, item)
    await fs.mkdir(dirname(to), { recursive: true })
    if (stat.isDirectory()) {
      await fs.cp(from, to, { recursive: true })
    } else {
      await fs.copyFile(from, to)
    }
  }
}

async function refreshMain(cwd) {
  await git(cwd, ['checkout', '-q', '-f', 'main'])
  await git(cwd, ['reset', '--hard', '-q', 'origin/main'])
}

async function compareWithTag(cwd, sourceDir, tag) {
  if (tag) await git(cwd, ['checkout', '-q', '-f', tag])
  await removePayload(cwd)
  await copyPayload(sourceDir, cwd)
  await git(cwd, ['add', '-A'])
  const status = await git(cwd, ['status', '--porcelain'])
  return status.length > 0
}

function versionSection(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`## \\[${escaped}\\][\\s\\S]*?(?=\\n## \\[|$)`)
}

function unreleasedSection(text) {
  const match = String(text || '').match(/## \[Unreleased\][^\n]*\n([\s\S]*?)(?=\n## \[|$)/)
  return match ? match[1].trim() : ''
}

function conventionalNotes(subjects) {
  const groups = { Added: [], Fixed: [], Performance: [], Changed: [] }
  for (const subject of subjects) {
    const match = String(subject).match(
      /^(feat|fix|perf|refactor|docs|chore|build|ci|test)(?:\([^)]*\))?(!)?:\s*(.+)$/i,
    )
    if (!match) continue
    const kind = match[1].toLowerCase()
    const text = match[3].trim()
    if (kind === 'feat') groups.Added.push(text)
    else if (kind === 'fix') groups.Fixed.push(text)
    else if (kind === 'perf') groups.Performance.push(text)
    else if (kind === 'refactor') groups.Changed.push(text)
    if (match[2]) groups.Changed.push(`Breaking: ${text}`)
  }
  return groups
}

function formatGroups(groups) {
  const lines = []
  for (const [title, items] of Object.entries(groups)) {
    if (!items.length) continue
    lines.push(`### ${title}`)
    for (const item of items) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

async function sourceNotes(sourceDir) {
  try {
    const subjects = await git(sourceDir, ['log', '-30', '--pretty=format:%s', '--', '.'])
    return subjects.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function buildChangelog(sourceDir, version, options, token) {
  const existing = await readText(join(sourceDir, 'CHANGELOG.md'))
  if (versionSection(existing, version).test(existing)) {
    throw new ReleaseError(`CHANGELOG 已包含 ${version}`)
  }

  let body = unreleasedSection(existing)
  if (!body) {
    const custom = Array.isArray(options.notes)
      ? options.notes
      : String(options.notes || '').split(/\r?\n/)
    const provided = custom.map((line) => line.trim()).filter(Boolean)
    if (provided.length) {
      body = provided.map((line) => `- ${line}`).join('\n')
    } else {
      const notes = formatGroups(conventionalNotes(await sourceNotes(sourceDir)))
      body = notes || '- Maintenance release.'
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const section = `## [${version}] - ${date}\n\n${body}\n`
  let base = existing.replace(/## \[Unreleased\][^\n]*\n[\s\S]*?(?=\n## \[|$)/, '').trim()
  if (!base) {
    base = '# Changelog\n\nAll notable changes to this project are documented here.'
  }
  const firstRelease = base.search(/\n## \[/)
  if (firstRelease < 0) return `${base.trimEnd()}\n\n${section}`
  return `${base.slice(0, firstRelease).trimEnd()}\n\n${section}\n${base.slice(firstRelease + 1).trimEnd()}\n`
}

async function bumpPackage(cwd, version) {
  const packageFile = join(cwd, 'package.json')
  const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'))
  pkg.version = version
  await fs.writeFile(packageFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  const lockFile = join(cwd, 'package-lock.json')
  try {
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'))
    lock.version = version
    if (lock.packages && lock.packages['']) lock.packages[''].version = version
    await fs.writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  } catch {
    /* 没有 lockfile 也可以发布 */
  }
}

async function prepareClone(sourceDir, repo, token, originUrl) {
  const configured = originUrl || process.env.DSH_ONE_SYNC_RELEASE_ORIGIN || ''
  const candidates = configured
    ? [configured]
    : [
      `https://github.com/${repo}.git`,
      `ssh://git@ssh.github.com:443/${repo}.git`,
    ]
  let lastError = null

  for (const origin of candidates) {
    const temp = await fs.mkdtemp(join(tmpdir(), 'dsh-one-sync-release-'))
    try {
      await git(null, ['clone', '--quiet', origin, temp], { token })
      const tag = await latestTag(temp)
      const pkgText = await readText(join(sourceDir, 'package.json'))
      const pkg = JSON.parse(pkgText)
      const currentVersion = newerVersion(pkg.version, tagVersion(tag))
      return { temp, tag, currentVersion, pkg, origin }
    } catch (error) {
      lastError = error
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  }
  throw lastError || new ReleaseError('无法连接发布仓库')
}

/** 预览：不写工作区、不推送。 */
export async function previewRelease(options = {}) {
  const sourceDir = resolve(options.sourceDir || process.cwd())
  const repo = parseRepo(options.repo || RELEASE_REPO)
  const bump = normalizeBump(options.bump)
  const token = String(options.token || '')
  let temp = ''
  try {
    const clone = await prepareClone(sourceDir, repo, token, options.originUrl)
    temp = clone.temp
    const currentVersion = clone.currentVersion
    const nextVersion = bumpVersion(currentVersion, bump)
    const tag = `v${nextVersion}`
    const changed = await compareWithTag(temp, sourceDir, clone.tag)
    let changelog = ''
    if (changed) changelog = await buildChangelog(sourceDir, nextVersion, options, token)
    return {
      ok: true,
      changed,
      repo,
      bump,
      currentVersion,
      nextVersion,
      tag,
      changelog,
    }
  } catch (error) {
    if (error instanceof ReleaseError) throw error
    throw new ReleaseError(redact(error && error.message ? error.message : error, token))
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}

/** 执行发布：只在临时克隆中提交、打 tag、atomic push。 */
export async function releasePlugin(options = {}) {
  if (options.confirm !== true) throw new ReleaseError('需要二次确认才能发布', 'confirm')
  const sourceDir = resolve(options.sourceDir || process.cwd())
  const repo = parseRepo(options.repo || RELEASE_REPO)
  const bump = normalizeBump(options.bump)
  const token = String(options.token || '')

  let temp = ''
  try {
    const clone = await prepareClone(sourceDir, repo, token, options.originUrl)
    temp = clone.temp
    const pushUrl = options.pushUrl
      || (clone.origin.startsWith('https://github.com/') && token
        ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`
        : clone.origin)
    if (!pushUrl) throw new ReleaseError('缺少 GitHub Token', 'token')
    if (!token && clone.origin.startsWith('https://github.com/') && !options.pushUrl) {
      throw new ReleaseError('缺少 GitHub Token', 'token')
    }
    const currentVersion = clone.currentVersion
    const nextVersion = bumpVersion(currentVersion, bump)
    const tag = `v${nextVersion}`
    const changed = await compareWithTag(temp, sourceDir, clone.tag)
    if (!changed) {
      return { ok: true, changed: false, noChanges: true, version: currentVersion, tag: clone.tag }
    }

    const existingTag = await git(temp, ['tag', '--list', tag])
    if (existingTag.trim()) throw new ReleaseError(`Tag 已存在：${tag}`, 'tag')

    await refreshMain(temp)
    await removePayload(temp)
    await copyPayload(sourceDir, temp)
    await bumpPackage(temp, nextVersion)
    const changelog = await buildChangelog(sourceDir, nextVersion, options, token)
    await fs.writeFile(join(temp, 'CHANGELOG.md'), changelog, 'utf8')
    await git(temp, ['add', '-A'])
    await git(temp, [
      '-c', 'user.name=dsh-one-sync',
      '-c', 'user.email=dsh-one-sync@localhost',
      'commit', '-m', `chore(release): ${tag}`,
    ], { token })
    const commit = await git(temp, ['rev-parse', 'HEAD'])
    await git(temp, ['tag', '-a', tag, '-m', `dsh-one-sync ${tag}`], { token })
    await git(temp, ['remote', 'set-url', 'origin', pushUrl])
    await git(temp, ['push', '--atomic', 'origin', 'main', '--tags'], { token })

    let sourceUpdated = false
    if (options.updateSource !== false) {
      try {
        await bumpPackage(sourceDir, nextVersion)
        await fs.writeFile(join(sourceDir, 'CHANGELOG.md'), changelog, 'utf8')
        sourceUpdated = true
      } catch {
        /* 发布已经成功；源目录版本同步失败不应回滚远端 */
      }
    }

    return {
      ok: true,
      changed: true,
      version: nextVersion,
      tag,
      commit,
      sourceUpdated,
      htmlUrl: `https://github.com/${repo}/releases/tag/${tag}`,
    }
  } catch (error) {
    if (error instanceof ReleaseError) throw error
    throw new ReleaseError(redact(error && error.message ? error.message : error, token))
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}
