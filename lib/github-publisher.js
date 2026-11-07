/**
 * 把当前目录发布为一个全新的 GitHub 仓库。
 *
 * 逻辑来自 refer/dsh-github-aide-main/lib/publish.js 的建仓 + 初始化 Git +
 * 生成 .gitignore + 首次提交链路，但只保留本插件需要的部分：
 *   - 复用本项目的 lib/rest.js 创建 GitHub 仓库（不另造 HTTP 客户端）；
 *   - 复用本项目的 lib/git.js 执行 git（token askpass / GitHub extraHeader）；
 *   - 不触碰已有的同步/加密逻辑。
 *
 * 安全/可重试约定：
 *   - 当前目录已有 .git（或位于其他 Git 工作树内）时直接拒绝；
 *   - 本地 init/commit 失败、或远端建仓失败时，回滚本次创建的 .git / .gitignore，
 *     让用户修正后可以重新点击发布；
 *   - 建仓成功但首次 push 失败时保留本地仓库，并在错误里给出远端 URL 和手动
 *     push 指令（远端已经存在，回滚本地只会让重试更困难）。
 */
import fs from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { GithubRest, RestError } from './rest.js'
import { runGit } from './git.js'

const LOCAL_TIMEOUT_MS = 60_000
const NETWORK_TIMEOUT_MS = 180_000
const MAX_FILES = 8000
const MAX_REPO_NAME = 100
const FALLBACK_REPO_NAME = 'project'

/** 发布过程中可预期的失败；details 会附带给 HTTP 路由/界面。 */
export class PublisherError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PublisherError'
    this.code = code
    Object.assign(this, details)
  }
}

// ── 项目识别 / .gitignore ────────────────────────────────────────────────

const COMMON_IGNORES = [
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.tmp',
  '.idea/',
  '.vscode/',
  '*.swp',
]

const SECRET_IGNORES = [
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '.ssh/',
  '.aws/',
  '.gnupg/',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials*.json',
  '*service-account*.json',
  '*.tfstate*',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
]

const STACKS = [
  {
    id: 'node',
    label: 'Node.js',
    markers: ['package.json'],
    dirs: ['node_modules'],
    ignore: ['node_modules/', 'dist/', 'build/', 'coverage/', '.npm/', '.pnpm-store/', '*.tsbuildinfo', '.env', '.env.local', '.env.*.local'],
  },
  {
    id: 'python',
    label: 'Python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock'],
    dirs: ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
    ignore: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'build/', 'dist/', '*.egg-info/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/'],
  },
  {
    id: 'rust',
    label: 'Rust',
    markers: ['Cargo.toml'],
    dirs: ['target'],
    ignore: ['target/', '**/*.rs.bk'],
  },
  {
    id: 'go',
    label: 'Go',
    markers: ['go.mod'],
    dirs: [],
    ignore: ['bin/', '*.test', '*.out'],
  },
  {
    id: 'java',
    label: 'Java/JVM',
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    dirs: ['target', 'build', '.gradle'],
    ignore: ['target/', 'build/', '.gradle/', '*.class', '*.jar'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    markers: ['*.sln', '*.csproj'],
    dirs: ['bin', 'obj'],
    ignore: ['bin/', 'obj/', '*.user', '*.suo'],
  },
  {
    id: 'unity',
    label: 'Unity',
    markers: ['ProjectSettings', 'Assets'],
    dirs: ['Library', 'Temp', 'Logs'],
    ignore: ['Library/', 'Temp/', 'Obj/', 'Logs/', 'UserSettings/', '*.csproj', '*.sln', '*.unityproj'],
  },
  {
    id: 'godot',
    label: 'Godot',
    markers: ['project.godot'],
    dirs: ['.godot'],
    ignore: ['.godot/', '.import/', 'export_presets.cfg'],
  },
  {
    id: 'cpp',
    label: 'C/C++',
    markers: ['CMakeLists.txt', 'Makefile', 'meson.build'],
    dirs: ['build', 'cmake-build-debug'],
    ignore: ['build/', 'cmake-build-*/', '*.o', '*.obj', '*.a', '*.so', '*.dll', '*.exe'],
  },
  {
    id: 'web-static',
    label: 'Static site',
    markers: ['index.html'],
    dirs: [],
    ignore: [],
  },
]

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build',
  '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vscode', 'Library', 'Temp', 'obj',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'coverage', '.pnpm-store', '.npm',
  'bin', 'out', '.godot', '.import', 'cmake-build-debug', 'vendor', 'Pods',
])

async function listTopLevel(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = []
  const dirs = []
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name)
    else if (entry.isFile()) files.push(entry.name)
  }
  return { files, dirs }
}

function detectStacks(listing) {
  const files = new Set((listing?.files ?? []).map((name) => String(name).toLowerCase()))
  const dirs = new Set(listing?.dirs ?? [])
  const found = []
  for (const stack of STACKS) {
    const hitMarker = stack.markers.some((marker) => {
      const lower = marker.toLowerCase()
      if (lower.includes('*')) {
        const suffix = lower.slice(lower.indexOf('*') + 1)
        return [...files].some((file) => file.endsWith(suffix))
      }
      return files.has(lower)
    })
    const hitDir = stack.dirs.some((dirName) => dirs.has(dirName))
    if (hitMarker || hitDir) found.push({ id: stack.id, label: stack.label, ignore: [...stack.ignore] })
  }
  return found
}

function buildGitignore(stacks = []) {
  const lines = []
  const seen = new Set()
  const push = (line) => {
    if (line === '' || seen.has(line)) return
    seen.add(line)
    lines.push(line)
  }
  for (const stack of stacks) {
    push(`# ${stack.label}`)
    for (const line of stack.ignore) push(line)
    lines.push('')
  }
  push('# Common')
  for (const line of COMMON_IGNORES) push(line)
  push('# Secrets')
  for (const line of SECRET_IGNORES) push(line)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

/**
 * 递归收集可发布文件；跳过依赖/构建目录，不跟随符号链接。
 * @returns {Promise<{ files: number, bytes: number, truncated: boolean }>}
 */
async function collectPublishableFiles(dir) {
  let files = 0
  let bytes = 0
  let truncated = false
  const queue = [{ dir, depth: 0 }]

  while (queue.length > 0) {
    if (files >= MAX_FILES) {
      truncated = true
      break
    }
    const current = queue.shift()
    if (current.depth > 12) {
      truncated = true
      continue
    }
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files >= MAX_FILES) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue
        queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const info = await fs.stat(join(current.dir, entry.name)).catch(() => undefined)
      files += 1
      if (info) bytes += info.size
    }
  }
  return { files, bytes, truncated }
}

// ── 名称 / Git 小工具 ────────────────────────────────────────────────────

function slugifyRepoName(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/[-._]{2,}/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
    .slice(0, MAX_REPO_NAME)
    .replace(/^[-._]+|[-._]+$/gu, '')
  return slug.length > 0 ? slug : FALLBACK_REPO_NAME
}

function suggestRepoName(dir) {
  const base = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  return slugifyRepoName(base)
}

async function pathExists(path) {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

async function gitTry(dir, args, token, timeoutMs = LOCAL_TIMEOUT_MS) {
  try {
    const result = await runGit(args, { cwd: dir, token, timeoutMs })
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', error: String((error && error.message) || error).trim() }
  }
}

async function gitMust(dir, args, token, timeoutMs = LOCAL_TIMEOUT_MS) {
  const result = await gitTry(dir, args, token, timeoutMs)
  if (!result.ok) {
    throw new PublisherError(
      'GIT_FAILED',
      `git ${args[0]} 失败：${result.error || '未知错误'}`,
    )
  }
  return result
}

async function initRepo(dir, branch, token) {
  const first = await gitTry(dir, ['init', '--initial-branch', branch], token, LOCAL_TIMEOUT_MS)
  if (first.ok) return
  await gitMust(dir, ['init'], token, LOCAL_TIMEOUT_MS)
  await gitMust(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], token, LOCAL_TIMEOUT_MS)
}

async function setOrigin(dir, url, token) {
  const existing = await gitTry(dir, ['remote', 'get-url', 'origin'], token, 10_000)
  if (existing.ok) {
    await gitMust(dir, ['remote', 'set-url', 'origin', url], token, 10_000)
  } else {
    await gitMust(dir, ['remote', 'add', 'origin', url], token, 10_000)
  }
}

function cleanCloneUrl(url, owner, repo) {
  const fallback = `https://github.com/${owner}/${repo}.git`
  if (!url) return fallback
  return String(url).trim().replace(/(:\/\/)[^/@\s]*:[^/@\s]*@/, '$1') || fallback
}

function asPublisherError(error, details = {}) {
  if (error instanceof PublisherError) return error
  if (error instanceof RestError) {
    if (error.status === 401 || error.status === 403) {
      return new PublisherError(
        'AUTH',
        'GitHub Token 无效，或没有创建仓库的权限。\n' +
        'classic PAT 需要 repo 权限；fine-grained PAT 需要账号级 Repository creation / Administration write。',
        details,
      )
    }
    if (error.status === 422) {
      return new PublisherError(
        'REPO_EXISTS',
        '仓库名已存在或不可用，请换一个名称后重试。',
        details,
      )
    }
    if (error.status === 404) {
      return new PublisherError('NOT_FOUND', 'GitHub 资源不存在，请检查 Token 权限。', details)
    }
    if (error.status === 0) {
      return new PublisherError('NETWORK', '无法连接 GitHub API：' + error.message, details)
    }
    return new PublisherError('GITHUB', error.message, details)
  }
  return new PublisherError('PUBLISH_FAILED', String((error && error.message) || error), details)
}

function createRest(token, repoName, branch) {
  return new GithubRest({
    // 这里只需要 parseRepo 的 owner/repo 形状；真正建仓走 POST /user/repos。
    remote: `https://github.com/dsh-publisher/${repoName}.git`,
    token,
    branch,
    timeoutMs: 30_000,
  }, () => {})
}

async function viewerLogin(rest) {
  let viewer
  try {
    viewer = await rest.request('GET', '/user')
  } catch (error) {
    throw asPublisherError(error)
  }
  const login = viewer && typeof viewer.login === 'string' ? viewer.login.trim() : ''
  if (!login) {
    throw new PublisherError('AUTH', '无法从 GitHub 读取当前账号，请检查 Token。')
  }
  return { login, id: Number(viewer.id) || 0 }
}

async function repoAlreadyExists(rest, owner, repo) {
  try {
    await rest.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
    return true
  } catch (error) {
    if (error instanceof RestError && error.status === 404) return false
    throw asPublisherError(error)
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────

/**
 * 发布一个目录为全新的 GitHub 仓库。
 *
 * @param {object} options
 * @param {string} options.dir          项目目录（绝对路径）
 * @param {string} options.repoName     新仓库名称；空则用目录名
 * @param {string} options.token        GitHub PAT
 * @param {boolean} [options.private]   默认 true
 * @param {string} [options.branch]     默认 main
 * @param {string} [options.description]
 * @returns {Promise<object>} 发布结果
 * @throws {PublisherError}
 */
export async function publishNewRepo(options = {}) {
  const rawDir = String(options.dir == null ? '' : options.dir).trim()
  if (!rawDir) throw new PublisherError('BAD_REQUEST', '缺少要发布的目录（codeDir）。')
  const dir = resolve(rawDir)
  const token = String(options.token == null ? '' : options.token).trim()
  if (!token) {
    throw new PublisherError('NO_TOKEN', '未配置 GitHub Token，无法创建仓库。')
  }
  const branch = String(options.branch == null ? '' : options.branch).trim() || 'main'
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new PublisherError('BAD_REQUEST', `分支名不合法：${branch}`)
  }
  const isPrivate = options.private !== false
  const log = typeof options.log === 'function' ? options.log : () => {}

  const info = await fs.stat(dir).catch(() => undefined)
  if (!info || !info.isDirectory()) {
    throw new PublisherError('NOT_A_DIRECTORY', `目录不存在或不是文件夹：${dir}`)
  }

  // Step 5：已有 .git（包括 worktree 的 .git 文件）直接拒绝，不触网。
  if (await pathExists(join(dir, '.git'))) {
    throw new PublisherError('HAS_GIT', '已有 Git 仓库，请直接使用一键同步')
  }

  const gitVersion = await gitTry(dir, ['--version'], token, 10_000)
  if (!gitVersion.ok) {
    throw new PublisherError(
      'GIT_MISSING',
      '未找到 git 可执行文件，无法初始化仓库。请安装 Git 并重启 DSH。',
    )
  }
  const inside = await gitTry(dir, ['rev-parse', '--is-inside-work-tree'], token, 10_000)
  if (inside.ok && inside.stdout.trim() === 'true') {
    throw new PublisherError('HAS_GIT', '已有 Git 仓库，请直接使用一键同步')
  }

  const listing = await listTopLevel(dir)
  const stacks = detectStacks(listing)
  const collected = await collectPublishableFiles(dir)
  if (collected.files === 0) {
    throw new PublisherError('NO_FILES', '目录中没有可发布的文件。')
  }

  const repo = slugifyRepoName(
    typeof options.repoName === 'string' && options.repoName.trim()
      ? options.repoName
      : suggestRepoName(dir),
  )
  const rest = createRest(token, repo, branch)
  const viewer = await viewerLogin(rest)
  log(`准备发布 ${dir} → ${viewer.login}/${repo}（${isPrivate ? 'private' : 'public'}）`)
  if (await repoAlreadyExists(rest, viewer.login, repo)) {
    throw new PublisherError(
      'REPO_EXISTS',
      `仓库已存在：${viewer.login}/${repo}，请换一个名称后重试。`,
    )
  }

  let createdGit = false
  let createdGitignore = false
  let commit = ''

  try {
    createdGit = true
    await initRepo(dir, branch, token)
    await gitMust(dir, ['config', '--local', 'core.autocrlf', 'false'], token, 10_000)

    if (!(await pathExists(join(dir, '.gitignore')))) {
      createdGitignore = true
      await fs.writeFile(join(dir, '.gitignore'), buildGitignore(stacks), 'utf8')
    }

    const configName = await gitTry(dir, ['config', '--get', 'user.name'], token, 10_000)
    const configEmail = await gitTry(dir, ['config', '--get', 'user.email'], token, 10_000)
    if (!configName.ok || !configName.stdout.trim()) {
      await gitMust(dir, ['config', '--local', 'user.name', viewer.login], token, 10_000)
    }
    if (!configEmail.ok || !configEmail.stdout.trim()) {
      await gitMust(
        dir,
        ['config', '--local', 'user.email', `${viewer.login}@users.noreply.github.com`],
        token,
        10_000,
      )
    }

    await gitMust(dir, ['add', '--all'], token, LOCAL_TIMEOUT_MS)
    const status = await gitMust(dir, ['status', '--porcelain'], token, LOCAL_TIMEOUT_MS)
    if (!status.stdout.trim()) {
      throw new PublisherError(
        'NO_FILES',
        '没有可提交的文件（可能都被 .gitignore 忽略了）。',
      )
    }
    await gitMust(dir, ['commit', '--no-gpg-sign', '--message', 'Initial commit'], token, LOCAL_TIMEOUT_MS)
    const head = await gitMust(dir, ['rev-parse', 'HEAD'], token, 10_000)
    commit = head.stdout.trim()
    log(`本地 Initial commit 完成：${commit.slice(0, 7)}`)
  } catch (error) {
    if (createdGit) {
      await fs.rm(join(dir, '.git'), { recursive: true, force: true }).catch(() => {})
    }
    if (createdGitignore) {
      await fs.rm(join(dir, '.gitignore'), { force: true }).catch(() => {})
    }
    throw asPublisherError(error)
  }

  let createdRepo
  try {
    createdRepo = await rest.request('POST', '/user/repos', {
      name: repo,
      private: isPrivate,
      auto_init: false,
      description: String(options.description || '').trim() || `DSH one-sync: ${repo}`,
    })
  } catch (error) {
    // 远端没建起来：回滚本地，保持目录可重新发布。
    await fs.rm(join(dir, '.git'), { recursive: true, force: true }).catch(() => {})
    if (createdGitignore) {
      await fs.rm(join(dir, '.gitignore'), { force: true }).catch(() => {})
    }
    throw asPublisherError(error)
  }

  const owner = (createdRepo && createdRepo.owner && createdRepo.owner.login)
    ? String(createdRepo.owner.login)
    : viewer.login
  const cloneUrl = cleanCloneUrl(createdRepo && createdRepo.clone_url, owner, repo)
  const htmlUrl = (createdRepo && typeof createdRepo.html_url === 'string' && createdRepo.html_url)
    ? createdRepo.html_url
    : `https://github.com/${owner}/${repo}`
  log(`已创建 GitHub 仓库：${htmlUrl}`)

  try {
    await setOrigin(dir, cloneUrl, token)
    await gitMust(
      dir,
      ['push', '--set-upstream', 'origin', branch],
      token,
      NETWORK_TIMEOUT_MS,
    )
    log(`首推完成：origin/${branch}`)
  } catch (error) {
    throw new PublisherError(
      'PUSH_FAILED',
      `仓库已创建：${htmlUrl}\n但首次推送失败：${(error && error.message) || error}\n` +
      `请在该目录手动执行 git push -u origin ${branch}，或删除远端仓库后重试。`,
      {
        owner,
        repo,
        repoUrl: cloneUrl,
        htmlUrl,
        commit,
        pushed: false,
      },
    )
  }

  return {
    ok: true,
    owner,
    repo,
    repoUrl: cloneUrl,
    cloneUrl,
    htmlUrl,
    branch,
    commit,
    files: collected.files,
    bytes: collected.bytes,
    stacks: stacks.map((stack) => stack.id),
    gitignoreCreated: createdGitignore,
    private: isPrivate,
  }
}

export { buildGitignore, detectStacks, slugifyRepoName, suggestRepoName }
