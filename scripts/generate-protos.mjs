// Generate aggregated protobuf static module + d.ts for all whatsmeow protos
// Outputs: proto/whatsmeow.js and proto/whatsmeow.d.ts
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import fg from 'fast-glob'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.join(__dirname, '..')
const protoRoot = path.join(root, 'whatsmeow', 'proto')
const outDir = path.join(root, 'proto')
const outJS = path.join(outDir, 'whatsmeow.js')
const outDTS = path.join(outDir, 'whatsmeow.d.ts')

if (!fs.existsSync(protoRoot)) {
    console.error(`[gen:protos] proto root not found: ${protoRoot}`)
    process.exit(0)
}

fs.mkdirSync(outDir, { recursive: true })

const patterns = ['**/*.proto']
const protosAbs = fg.sync(patterns, { cwd: protoRoot, absolute: true })
// Use relative paths so pbjs can resolve imports via -p include path
const protos = protosAbs.map((p) => path.relative(protoRoot, p).split(path.sep).join('/'))
if (protos.length === 0) {
    console.warn('[gen:protos] no .proto files found under', protoRoot)
    process.exit(0)
}

const pbjsBin = path.join(root, 'node_modules', 'protobufjs-cli', 'bin', 'pbjs')
const pbtsBin = path.join(root, 'node_modules', 'protobufjs-cli', 'bin', 'pbts')

console.log(`[gen:protos] Generating ${outJS} from ${protos.length} protos...`)
{
    const args = [
        pbjsBin,
        '-t',
        'static-module',
        '-w',
        'es6',
        '--no-delimited', // reduce code size; not needed for our usage
        '--eslint-disable',
        // Include path for resolving imports like "folder/File.proto"
        '-p',
        protoRoot,
        '-o',
        outJS,
        ...protos
    ]
    const res = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log(`[gen:protos] Generating ${outDTS}...`)
{
    const args = [pbtsBin, '-o', outDTS, outJS]
    const res = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (res.status !== 0) process.exit(res.status ?? 1)
}

console.log('[gen:protos] Done')

function patchProtobufESM(file) {
    try {
        let src = fs.readFileSync(file, 'utf8')

        // 1. Corrigir import com extensão
        src = src.replace(/from\s+"protobufjs\/minimal";/g, 'from "protobufjs/minimal.js";')

        // 2. Forçar uso do default export no Node ESM
        src = src.replace(
            /import\s+\*\s+as\s+\$protobuf\s+from\s+"protobufjs\/minimal\.js";/,
            'import * as _pb from "protobufjs/minimal.js";\n' +
                'const $protobuf = (_pb && _pb.default) ? _pb.default : _pb;'
        )

        fs.writeFileSync(file, src, 'utf8')
        return true
    } catch (err) {
        console.warn('[gen:protos] Warn: could not patch', file, err?.message || err)
        return false
    }
}

// Patch src output first
if (patchProtobufESM(outJS)) console.log('[gen:protos] Patched src/proto import path')
