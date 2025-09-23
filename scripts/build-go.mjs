import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function outExt() {
    return process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'
}

function run(cmd, args, cwd) {
    const bin = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd
    const res = spawnSync(bin, args, { cwd, stdio: 'inherit', env: process.env })
    if (res.status !== 0) process.exit(res.status || 1)
}

function runGo(args) {
    const bin = process.env.GO_BIN || 'go'
    const res = spawnSync(bin, args, {
        cwd: path.join(__dirname, '..', 'bridge-go'),
        stdio: 'inherit',
        env: process.env
    })
    if (res.status !== 0) process.exit(res.status || 1)
}

// Ensure output dir
const buildDir = path.join(__dirname, '..', 'build')
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true })

// Tidy modules
runGo(['mod', 'tidy'])

// Build c-shared library
const ext = outExt()
const out = path.join('..', 'build', `whatsmeow.${ext}`)
runGo(['build', '-buildmode=c-shared', '-o', out, '.'])

console.log(`[whatsmeow-node] Built native: ${out}`)
