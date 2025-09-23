import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectPlatform } from './detect-platform.mjs'
import { downloadPrebuilt } from './download-prebuilt.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function ensureDir(p) {
    await fsp.mkdir(p, { recursive: true }).catch(() => {})
}

async function copyIfExists(src, dst) {
    try {
        await ensureDir(path.dirname(dst))
        await fsp.copyFile(src, dst)
        return true
    } catch (err) {
        if (err && err.code === 'ENOENT') return false
        throw err
    }
}

async function run() {
    if (process.env.WHATS_SKIP_POSTINSTALL === 'true') {
        console.log('[whatsmeow-node] Skipping postinstall (WHATS_SKIP_POSTINSTALL=true)')
        return
    }

    const { triplet, ext } = detectPlatform()
    const buildOut = path.join(__dirname, '..', 'build', `whatsmeow.${ext}`)

    // 1) Prefer local prebuilt shipped in npm tarball (no network)
    const prebuiltDir = path.join(__dirname, '..', 'prebuilt', triplet)
    const prebuilt = path.join(prebuiltDir, `whatsmeow.${ext}`)
    const ok = await copyIfExists(prebuilt, buildOut)
    if (ok) {
        // By default, remove the prebuilt triplet to avoid doubling disk usage in node_modules
        if (process.env.WHATS_KEEP_PREBUILT !== 'true') {
            try {
                await fsp.rm(prebuiltDir, { recursive: true, force: true })
            } catch {}
        }
        return
    }

    // 2) Try remote prebuilt from GitHub Releases
    try {
        const downloaded = await downloadPrebuilt()
        if (downloaded) return
    } catch {}

    // No prebuilt available for this platform. Try local build if allowed
    if (process.env.WHATS_BUILD_FROM_SOURCE === 'true') {
        console.log('[whatsmeow-node] No prebuilt found. Attempting local build: npm run build:go')
        try {
            const { spawnSync } = await import('node:child_process')
            const res = spawnSync(
                process.platform === 'win32' ? 'npm.cmd' : 'npm',
                ['run', 'build:go'],
                {
                    cwd: path.join(__dirname, '..'),
                    stdio: 'inherit',
                    env: process.env
                }
            )
            if (res.status === 0 && fs.existsSync(buildOut)) return
            console.warn('[whatsmeow-node] Local build did not produce the native library.')
        } catch (err) {
            console.warn('[whatsmeow-node] Local build failed:', err?.message || String(err))
        }
    }

    console.warn('[whatsmeow-node] No prebuilt found (local/remote) and no local build completed.')
    console.warn(
        `[whatsmeow-node] Expected one of the triplets under prebuilt/ or a release asset named whatsmeow-${triplet}.${ext}`
    )
    console.warn(
        `[whatsmeow-node] You can:\n- set WHATS_BUILD_FROM_SOURCE=true and re-run install\n- or build manually with: npm run build:go`
    )
}

run().catch((err) => {
    console.error('[whatsmeow-node] postinstall failed:', err?.message || String(err))
})
