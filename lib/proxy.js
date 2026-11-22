/**
 * 系统代理探测。
 *
 * 为什么需要：
 *   Windows 上浏览器走 WinINET 系统代理（注册表 ProxyEnable/ProxyServer），
 *   而 git 和 Node 的 fetch 默认都直连。于是出现「浏览器能开 GitHub、git 报
 *   Connection was reset / Failed to connect port 443」这种割裂现象。
 *
 * 策略：
 *   1. 环境变量优先（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY）；
 *   2. 否则读 Windows 系统代理；
 *   3. 探测 TCP 可连才真正启用，避免残留的失效代理把同步带崩。
 */

import { execFileSync } from 'node:child_process'
import net from 'node:net'

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

let cached = null
let probed = null
let probePromise = null

function normalizeUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  return `http://${text}`
}

function envProxy() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = normalizeUrl(process.env[key])
    if (value) return value
  }
  return ''
}

/** 读注册表里的系统代理；失败返回空串（非 Windows 或权限不足）。 */
function windowsProxy() {
  if (process.platform !== 'win32') return ''
  let out = ''
  try {
    out = execFileSync('reg', ['query', REG_PATH], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)
  if (!enabled) return ''
  const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)
  if (!server) return ''
  let value = server[1].trim()
  // ProxyServer 可能是 "http=host:port;https=host:port" 这种分协议写法。
  if (value.includes('=')) {
    const parts = new Map()
    for (const piece of value.split(';')) {
      const [proto, addr] = piece.split('=')
      if (proto && addr) parts.set(proto.trim().toLowerCase(), addr.trim())
    }
    value = parts.get('https') || parts.get('http') || ''
  }
  return normalizeUrl(value)
}

/** 同步取代理地址（结果缓存；探测未完成时也返回，便于传 git 参数）。 */
export function getProxy() {
  if (cached === null) cached = envProxy() || windowsProxy()
  if (probed === false) return ''
  return cached
}

/** 解析 http://host:port，失败返回 null。 */
export function parseProxy(url) {
  const text = normalizeUrl(url)
  if (!text) return null
  try {
    const parsed = new URL(text)
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    return { host: parsed.hostname, port, url: text }
  } catch {
    return null
  }
}

/** 异步探测代理端口是否可连。 */
export function probeProxy(url, timeoutMs = 1500) {
  const target = parseProxy(url)
  if (!target) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 启动时调用一次：探测代理可用性，并把它注入 Node 运行时环境，
 * 让内置 fetch（GitHub API）也能走同一条通道。
 */
export function initProxy() {
  if (probePromise) return probePromise
  const url = getProxy()
  if (!url) {
    probed = false
    probePromise = Promise.resolve('')
    return probePromise
  }
  probePromise = probeProxy(url).then((ok) => {
    probed = ok
    if (!ok) return ''
    if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = url
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = url
    if (!process.env.NO_PROXY && !process.env.no_proxy) {
      process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    }
    // Node 22+ 需要显式打开才会让 fetch 采用环境变量代理。
    if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1'
    return url
  })
  return probePromise
}

/** 传给 git 的 -c 参数；没有代理时返回空数组。 */
export function gitProxyArgs() {
  const url = getProxy()
  if (!url) return []
  return ['-c', `http.proxy=${url}`, '-c', `https.proxy=${url}`]
}

/** 供日志使用的一句话描述。 */
export function describeProxy() {
  const url = getProxy()
  if (!url) return ''
  return probed === false ? `${url}（不可用，已忽略）` : url
}
