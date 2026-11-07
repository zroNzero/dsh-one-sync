import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASKPASS_SCRIPT = `#!/usr/bin/env node
const prompt = String(process.argv[2] ?? '')
const value = /username/i.test(prompt) ? (process.env.DSH_GIT_USERNAME ?? '') : (process.env.DSH_GIT_PASSWORD ?? '')
process.stdout.write(value + '\\n')
`

export function runGit(args, { cwd, token, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    let askpassDir, env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

    if (token) {
      askpassDir = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
      const script = join(askpassDir, 'askpass.cjs')
      writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 })
      try { chmodSync(script, 0o700) } catch {}
      env.GIT_ASKPASS = script
      env.SSH_ASKPASS = script
      env.DSH_GIT_USERNAME = 'x-access-token'
      env.DSH_GIT_PASSWORD = token

      // Windows 上 Git 不一定能直接执行 .cjs askpass。额外用 Git 自己的
      // http.extraHeader 预先发送 Basic 认证：只要 remote 是 github.com 的
      // HTTPS，就不依赖 askpass 也能拉取/推送。非 GitHub HTTPS 地址仍走 askpass。
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
      const count = Number(env.GIT_CONFIG_COUNT || 0) || 0
      env[`GIT_CONFIG_KEY_${count}`] = 'http.https://github.com/.extraheader'
      env[`GIT_CONFIG_VALUE_${count}`] = header
      env.GIT_CONFIG_COUNT = String(count + 1)
    }

    execFile('git', args, { cwd, env, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (askpassDir) rmSync(askpassDir, { recursive: true, force: true })
      if (error) return reject(new Error(stderr || stdout || error.message))
      resolve({ stdout, stderr })
    })
  })
}

/**
 * 从任意工作区子目录向上寻找 Git 根目录。
 * @param {string} cwd 当前工作区路径
 * @returns {Promise<{ok:boolean, root:string, error:string}>}
 */
export async function findGitRoot(cwd, { token, timeoutMs = 10000 } = {}) {
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], {
      cwd,
      token,
      timeoutMs,
    })
    const root = String(result.stdout || '').trim()
    if (!root) {
      return { ok: false, root: '', error: 'git rev-parse --show-toplevel 没有返回路径' }
    }
    return { ok: true, root, error: '' }
  } catch (error) {
    return {
      ok: false,
      root: '',
      error: String((error && error.message) || error).trim(),
    }
  }
}
