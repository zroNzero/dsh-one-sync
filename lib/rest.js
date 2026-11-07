/**
 * GitHub REST 传输层 —— 不依赖 git 二进制、不需要 SSH 密钥。
 *
 * 为什么需要它（2026-10-17 复盘结论）：
 *   git 链路把「装插件 / 认证仓库 / 解析模块」绑在一起：家里没有 SSH 密钥就读不到私有仓库，
 *   github.com 的 HTTPS 在单位被重置，profile 又是 pnpm 的 link: 依赖……任何一环断掉就全不通。
 *   而 **api.github.com 在两个网络下都可达**（实测），且认证只需要一个 fine-grained PAT
 *   （Contents: read/write）——用户在设置页填一次即可，符合「初次登录只输一次凭证」。
 *
 * 仓库结构与 git 传输完全一致，因此两种传输可以混用/迁移：
 *   key.enc / manifest.json / data/**
 *
 * 推送语义：用 Git Data API 生成**一个原子提交**（blob → tree → commit → update ref），
 * 等价于一次 git push，但不需要本地仓库。
 *
 * 增量要点：git blob 的 sha 是内容寻址的（sha1("blob <len>\0" + content)），
 * 可以在本地算出来，和远端树里的 sha 比较——**内容没变的文件一个字节都不上传**。
 */
import { createHash } from 'node:crypto';
import { mapLimit } from './concurrency.js';

const API = 'https://api.github.com';

/** 计算 git blob sha（与 `git hash-object` 一致），用于增量判断。 */
export function blobSha(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(buf).digest('hex');
}

/** 从各种 GitHub 地址形态解析 owner/repo（含 ssh.github.com:443 这种带端口的形式）。 */
export function parseRepo(remote) {
  const s = String(remote || '').trim();
  const m = /(?:^|@|[/:])(?:ssh\.)?github\.com(?::\d+)?[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export class RestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'RestError';
    this.status = status;
    this.body = body;
  }
  /** 网络层（不可达/超时）→ 上层应入离线队列重试；4xx 认证类 → 明确报错。 */
  get fatal() {
    if (this.status === 401 || this.status === 403) return 'auth';
    if (this.status === 404) return 'missing';
    return undefined;
  }
}

/**
 * 极简 REST 客户端（只用到 Git Data API 的几个端点）。
 * @param {object} cfg 需要 cfg.token；可选 cfg.remote、cfg.branch、cfg.apiBaseURL
 * @param {function} log 日志
 */
export class GithubRest {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    const g = parseRepo(cfg.remote);
    if (!g) throw new RestError('remote 不是 GitHub 仓库地址', 0, null);
    this.owner = g.owner;
    this.repo = g.repo;
    this.branch = cfg.branch || 'main';
    this.base = (cfg.apiBaseURL || API).replace(/\/+$/, '');
    this.token = cfg.token || process.env.GITHUB_TOKEN || process.env.DSH_SYNC_TOKEN || '';
  }

  get repoUrl() { return `${this.base}/repos/${this.owner}/${this.repo}`; }

  async request(method, path, body, { retries = 3 } = {}) {
    if (!this.token) throw new RestError('缺少 GitHub token（请在设置里填写 Personal Access Token）', 401, null);
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs || 30000);
      try {
        const res = await fetch(path.startsWith('http') ? path : this.base + path, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'dsh-sync',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (res.status === 204) return null;
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (res.ok) return json;
        const err = new RestError(`GitHub API ${method} ${path} → ${res.status} ${(json && json.message) || ''}`.trim(), res.status, json);
        // 认证/不存在属致命，不重试；5xx/429 退避重试
        if (err.fatal) throw err;
        lastError = err;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof RestError && error.fatal) throw error;
        lastError = error;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    if (lastError instanceof RestError) throw lastError;
    throw new RestError(`网络不可用：${(lastError && lastError.message) || lastError}`, 0, null);
  }

  // ── 仓库 ────────────────────────────────────────────────────────────────
  async repoExists() {
    try { await this.request('GET', `/repos/${this.owner}/${this.repo}`); return true; }
    catch (error) { if (error instanceof RestError && error.status === 404) return false; throw error; }
  }

  async createRepo() {
    const created = await this.request('POST', '/user/repos', {
      name: this.repo, private: true, auto_init: false,
      description: 'DSH dsh-sync 私有同步仓库（由插件自动创建）',
    });
    this.log(`已创建私有仓库 ${this.owner}/${this.repo}`);
    return created;
  }

  // ── 引用 / 树 / blob ────────────────────────────────────────────────────
  /** 远端分支的提交 sha；空仓库返回 null。 */
  async headSha() {
    try {
      const ref = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.branch}`);
      return (ref && ref.object && ref.object.sha) || null;
    } catch (error) {
      // GitHub 对「仓库存在但还没有任何提交」的 ref 查询返回 409 Git Repository is empty，
      // 而不是 404；必须当成空仓库，否则后续 initializeIfEmpty 永远不会执行。
      if (error instanceof RestError && error.status === 404) return null; // 空仓库/分支不存在
      if (error instanceof RestError && error.status === 409 && /empty/i.test(error.message || '')) {
        return null;
      }
      throw error;
    }
  }

  /** 远端文件树：path → { sha, size }。truncated=true 时表示 GitHub 截断了目录树。 */
  async remoteTree() {
    const head = await this.headSha();
    if (!head) return { head: null, treeSha: null, files: new Map(), truncated: false };
    const commit = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/commits/${head}`);
    const tree = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/trees/${commit.tree.sha}?recursive=1`);
    const files = new Map();
    for (const e of tree.tree || []) {
      if (e.type === 'blob') files.set(e.path, { sha: e.sha, size: e.size });
    }
    return { head, treeSha: commit.tree.sha, files, truncated: Boolean(tree.truncated) };
  }

  /** 下载一个 blob 的原始字节。 */
  async blob(sha) {
    const r = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
    return Buffer.from(r.content, r.encoding === 'base64' ? 'base64' : 'utf8');
  }

  /**
   * 提交一批文件（新增/修改 sha 为内容 sha，删除用 sha:null），生成一个原子提交。
   * @param {Array<{path:string, buffer:Buffer|null}>} changes
   * @param {string|null} baseTreeSha 远端当前树（增量基础）
   * @param {string} message 提交信息
   */
  async commitFiles(changes, baseTreeSha, message, parents = []) {
    const entries = await mapLimit(changes, 4, async (c) => {
      if (c.buffer === null) {
        return { path: c.path, mode: '100644', type: 'blob', sha: null };
      }
      const blob = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/blobs`, {
        content: c.buffer.toString('base64'), encoding: 'base64',
      });
      return { path: c.path, mode: '100644', type: 'blob', sha: blob.sha };
    });
    const tree = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: entries,
    });
    const commit = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
      message, tree: tree.sha, parents,
    });
    await this.updateRef(commit.sha);
    return commit.sha;
  }

  async updateRef(sha) {
    try {
      await this.request('PATCH', `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`, { sha, force: true });
    } catch (error) {
      if (error instanceof RestError && error.status === 404) {
        await this.request('POST', `/repos/${this.owner}/${this.repo}/git/refs`, { ref: `refs/heads/${this.branch}`, sha });
        return;
      }
      throw error;
    }
  }
}