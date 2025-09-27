import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { pipeline } from 'node:stream'
import { promisify } from 'node:util'
import { detectPlatform } from './detect-platform.mjs'

const pipe = promisify(pipeline)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function readPkg() {
  const p = path.join(__dirname, '..', 'package.json')
  const raw = await fsp.readFile(p, 'utf8')
  return JSON.parse(raw)
}

function defaultRepoSlug(pkg) {
  const repo = pkg && pkg.repository
  if (typeof repo === 'string') {
    const m = repo.match(/github:(.+)/i)
    if (m) return m[1]
    if (/^[\w-]+\/[\w.-]+$/.test(repo)) return repo
  } else if (repo && typeof repo === 'object') {
    if (repo.url) {
      const m = repo.url.match(/github\.com[:/]+([^#]+?)(?:\.git)?$/i)
      if (m) return m[1]
    }
  }
  return 'pluvism/whatsmeow-node'
}

function buildBaseURL(pkg) {
  const repo = process.env.WHATS_PREBUILT_REPO || defaultRepoSlug(pkg)
  const versionTag = process.env.WHATS_PREBUILT_VERSION || `v${pkg.version}`
  const baseURL = process.env.WHATS_PREBUILT_BASEURL || `https://github.com/${repo}/releases/download/${versionTag}`
  return baseURL.replace(/\/$/, '')
}

async function httpGet(url, { maxRedirects = 5, timeout = 30_000 } = {}) {
  let redirects = 0
  return new Promise((resolve, reject) => {
    function _get(u) {
      const req = https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects++ >= maxRedirects) {
            res.resume()
            return reject(new Error(`Too many redirects when fetching ${url}`))
          }
          const loc = new URL(res.headers.location, u).toString()
          res.resume()
          return _get(loc)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`))
        }
        resolve(res)
      })
      req.on('error', reject)
      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Request timed out after ${timeout}ms for ${u}`))
      })
    }
    _get(url)
  })
}

async function downloadTo(url, dstPath, opts = {}) {
  const { retries = 2, timeout = 30_000, backoffBase = 500 } = opts
  await fsp.mkdir(path.dirname(dstPath), { recursive: true })
  const tmp = `${dstPath}.download-${process.pid}-${Date.now()}`
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      try { await fsp.unlink(tmp) } catch (e) {}
      const res = await httpGet(url, { timeout })
      const out = fs.createWriteStream(tmp, { flags: 'w' })
      await pipe(res, out)
      const expected = res.headers['content-length']
      if (expected) {
        const stat = await fsp.stat(tmp)
        if (Number(expected) !== stat.size) {
          await fsp.unlink(tmp).catch(() => {})
          throw new Error(`Content-length mismatch: expected ${expected}, got ${stat.size}`)
        }
      }
      await fsp.rename(tmp, dstPath)
      return
    } catch (err) {
      try { await fsp.unlink(tmp) } catch (e) {}
      if (attempt < retries) {
        const wait = Math.round(backoffBase * Math.pow(2, attempt))
        console.warn(`[whatsmeow-node] download attempt ${attempt + 1} failed for ${url}: ${err.message}. Retrying in ${wait}ms...`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw err
    }
  }
}

export async function downloadPrebuilt(options = {}) {
  const { triplet, ext } = detectPlatform()
  const pkg = await readPkg()
  const baseURL = buildBaseURL(pkg)
  const filename = `whatsmeow-${triplet}.${ext}`
  const url = `${baseURL}/${filename}`
  const out = path.join(__dirname, '..', 'build', `whatsmeow.${ext}`)
  try {
    await downloadTo(url, out, options)
    console.log(`[whatsmeow-node] Downloaded prebuilt from ${url}`)
    return true
  } catch (err) {
    console.warn(`[whatsmeow-node] No remote prebuilt found at ${url}:`, err?.message || String(err))
    return false
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = {}
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=?(.*)$/)
    if (m) opts[m[1]] = isNaN(Number(m[2])) || m[2] === '' ? m[2] : Number(m[2])
  }
  downloadPrebuilt(opts)
    .then((ok) => { if (!ok) process.exit(1) })
    .catch((err) => {
      console.error('[whatsmeow-node] download-prebuilt failed:', err?.message || String(err))
      process.exit(1)
    })
}
