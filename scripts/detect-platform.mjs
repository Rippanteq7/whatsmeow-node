import os from 'node:os'
import { execSync } from 'node:child_process'

export function detectPlatform() {
    const platform = process.platform
    const arch = process.arch
    const isMusl = detectMusl()

    const libc = platform === 'linux' ? (isMusl ? 'musl' : 'gnu') : ''
    const triplet = platform === 'linux' ? `${platform}-${arch}-${libc}` : `${platform}-${arch}`

    const ext = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so'

    return { platform, arch, libc, triplet, ext }
}

function detectMusl() {
    // Best-effort libc detection without deps
    // Node >=16 exposes process.report on supported builds
    try {
        if (process.platform !== 'linux') return false
        if (process.report && typeof process.report.getReport === 'function') {
            const rep = process.report.getReport()
            const glibc = rep.header && rep.header.glibcVersionRuntime
            return !glibc
        }
    } catch {}
    // Fallback: check presence of musl on ldd output
    try {
        const out = execSync('ldd --version 2>&1 || true', { encoding: 'utf8' })
        return /musl/i.test(out)
    } catch {}
    // Unknown -> assume glibc to reduce false positives
    return false
}

export default detectPlatform
