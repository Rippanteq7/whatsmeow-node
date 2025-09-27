import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { detectPlatform } from './detect-platform.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function readPkg() {
    const p = path.join(__dirname, '..', 'package.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function defaultRepoSlug(pkg) {
    // Try package.json.repository if present
    const repo = pkg.repository
    if (typeof repo === 'string') {
        // e.g. "github:user/repo"
        const m = repo.match(/github:(.+)/i)
        if (m) return m[1]
        // or "user/repo"
        if (/^[\w-]+\/[\w.-]+$/.test(repo)) return repo
    } else if (repo && typeof repo === 'object' && repo.url) {
        const m = repo.url.match(/github\.com[:/]+([^#]+?)(?:\.git)?$/i)
        if (m) return m[1]
    }
    // Fallback
    return 'pluvism/whatsmeow-node'
}

function buildBaseURL(pkg) {
    const repo = process.env.WHATS_PREBUILT_REPO || defaultRepoSlug(pkg)
    const versionTag = process.env.WHATS_PREBUILT_VERSION || `v${pkg.version}`
    const baseURL =
        process.env.WHATS_PREBUILT_BASEURL ||
        `https://github.com/${repo}/releases/download/${versionTag}`
    return baseURL.replace(/\/$/, '')
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    // follow redirect
                    return resolve(httpGet(res.headers.location))
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
                }
                resolve(res)
            })
            .on('error', reject)
    })
}

async function downloadTo(url, dstPath) {
    await fsp.mkdir(path.dirname(dstPath), { recursive: true })
    await fsp.rename(tmp, dstPath)
    const tmp = `${dstPath}.download`
    try {
        await fsp.unlink(tmp)
    } catch {}
    const res = await httpGet(url)
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp)
        res.pipe(out)
        res.on('error', reject)
        out.on('error', reject)
        out.on('finish', resolve)
    })
    
}

export async function downloadPrebuilt() {
    const { triplet, ext } = detectPlatform()
    const pkg = readPkg()
    const baseURL = buildBaseURL(pkg)
    const filename = `whatsmeow-${triplet}.${ext}`
    const url = `${baseURL}/${filename}`

    const out = path.join(__dirname, '..', 'build', `whatsmeow.${ext}`)
    try {
        await downloadTo(url, out)
        console.log(`[whatsmeow-node] Downloaded prebuilt from ${url}`)
        return true
    } catch (err) {
        console.warn(
            `[whatsmeow-node] No remote prebuilt found at ${url}:`,
            err?.message || String(err)
        )
        return false
    }
}

if (import.meta.url === `file://${__filename}`) {
    downloadPrebuilt()
        .then((ok) => {
            if (!ok) process.exit(1)
        })
        .catch((err) => {
            console.error('[whatsmeow-node] download-prebuilt failed:', err?.message || String(err))
            process.exit(1)
        })
}
