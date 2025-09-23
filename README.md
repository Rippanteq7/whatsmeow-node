# whatsmeow-node

TypeScript bindings for the Go library `go.mau.fi/whatsmeow`, via a minimal c-shared bridge loaded with `koffi`.

You get a type-safe Node/TypeScript API without fragile native addons. The Go bridge is compiled once into a shared library (DLL/.dylib/.so) and loaded at runtime.

## Features

- Typed API: `Container`, `Device`, `Client`, event stream, message send helpers
- QR login flow and phone pairing-code flow
- Media upload and download-by-path
- Presence, group invite link, and many client calls via a generic dispatcher
- Device management: first/new device, list all devices, get by JID
- Optional logging levels configured at runtime (database/client, with or without color)

## Requirements

- Go 1.25+
- Node.js 18+ (tested on Node 22 with `koffi`)
- CGO toolchain for your OS (needed by `github.com/mattn/go-sqlite3`)
    - Windows: MSYS2/MinGW GCC
    - macOS: Xcode Command Line Tools
    - Linux: GCC + libc dev headers

## Install & Build

```bash
npm install
npm run build
```

This will produce:

- `build/whatsmeow.dll` (or `.dylib`/`.so`) from the Go bridge
- `dist/` with compiled JavaScript and type declarations

> Note: The repo vendors protobuf-generated JS/TS under `proto/`. The module `src/protos.ts` re-exports them for convenience and `src/index.ts` re-exports `proto` as well.

## Prebuilt binaries (recommended for npm consumers)

This package can ship without native build tools by downloading a prebuilt native library during `npm install`.

- On install, the `postinstall` script will:
    1. Try to download a release asset from GitHub based on your platform triplet.
    2. If not found, try copying from the local `prebuilt/<triplet>/` folder (if included in the package tarball).
    3. If still not found and `WHATS_BUILD_FROM_SOURCE=true`, it will attempt a local build with Go (`npm run build:go`).

Asset naming (GitHub Releases):

- The asset file name must be `whatsmeow-<triplet>.<ext>`, e.g.:
    - `whatsmeow-win32-x64.dll`
    - `whatsmeow-darwin-arm64.dylib`
    - `whatsmeow-linux-x64-gnu.so`
    - `whatsmeow-linux-x64-musl.so`

Environment variables:

- `WHATS_PREBUILT_BASEURL` – override base URL to download from (default derives from package.json repository and version tag `v<version>`)
- `WHATS_PREBUILT_REPO` – override GitHub repo slug `user/repo`
- `WHATS_PREBUILT_VERSION` – override tag name (default: `v<package.json version>`)
- `WHATS_BUILD_FROM_SOURCE=true` – enable local build fallback if no prebuilt is found
- `WHATS_SKIP_POSTINSTALL=true` – skip the postinstall step entirely

CI workflow:

- A GitHub Actions workflow at `.github/workflows/prebuild.yml` builds and uploads the correct assets to the release for common triplets (Win x64, macOS x64/arm64, Linux x64 glibc/musl). Extend as needed for other triplets.

## Quick Start (QR login + send text)

```ts
// Local repo import path:
import { openContainer, Client, JID, proto } from './dist/index.js'

// If installed as a dependency:
// import { openContainer, Client, JID, proto } from 'whatsmeow-node'

async function main() {
    const container = await openContainer({
        dialect: 'sqlite3',
        address: 'file:session.db?_foreign_keys=on'
    })
    const device = await container.getFirstDevice()
    const client = await Client.create(device)

    // Obtain QR channel BEFORE connect
    const qr = await client.getQRChannel()
    ;(async () => {
        for (;;) {
            const ev = await qr.next(60000)
            if (ev.event === 'code') console.log('[qr]', ev.code)
            else {
                console.log('[qr]', ev.event)
                break
            }
        }
    })().catch(console.error)

    await client.connect()

    // Send a text message
    const to: JID = '1234567890@s.whatsapp.net'
    const msg: proto.WAWebProtobufsE2E.IMessage = { conversation: 'Hello from Node!' }
    const resp = await client.send(to, msg)
    console.log('Sent:', resp)
}

main().catch(console.error)
```

## Pair Phone (link by code)

```ts
// After client.connect()
const code = await client.pairPhone(
    '5511999999999', // digits only, international format
    true, // show push notification on primary
    1, // clientType: 1=Chrome (2=Edge, 3=Firefox, 6=Safari, ...)
    'Chrome (Windows)'
)
console.log('Pairing code:', code)
```

On the phone, open WhatsApp > Link a device > Link with phone number/code and type the code printed in your console.

## Device Management

```ts
const all = await container.getAllDevices() // Device[]
const byJID = await container.getDevice('123@s.whatsapp.net') // Device | null
const first = await container.getFirstDevice() // Device (existing first or new)
```

Tip: If you want multiple concurrent sessions, persist device JIDs and use `getDevice(jid)` instead of `getFirstDevice()`.

## Media Upload and Send (image)

```ts
import fs from 'node:fs/promises'

const data = await fs.readFile('./img.png')
const up = await client.uploadBytes(data, 'image')
const img: any = {
    URL: up.url,
    directPath: up.direct_path,
    mediaKey: up.media_key, // base64
    fileEncSHA256: up.file_enc_sha256,
    fileSHA256: up.file_sha256,
    fileLength: up.file_length,
    mimetype: 'image/png',
    caption: 'Hello with image'
}
const message: proto.WAWebProtobufsE2E.IMessage = { imageMessage: img }
await client.send('123@s.whatsapp.net', message)
```

## Download by Direct Path

```ts
const buf = await client.downloadByPath({
    direct_path: '...',
    enc_sha256: '...', // base64
    sha256: '...', // base64
    media_key: '...', // base64
    file_length: 12345,
    type: 'image', // one of: image | video | audio | document | history | appstate | sticker-pack | thumbnail-link
    mms_type: '' // optional
})
await fs.writeFile('./downloaded.bin', buf)
```

## Presence and Group Invite

```ts
await client.sendPresence('available')
const invite = await client.getGroupInviteLink('123-456@g.us')
console.log('Invite link:', invite)
```

## Events (minimal loop)

```ts
;(async () => {
    for await (const ev of client.events(60000)) {
        if (ev.type !== 'timeout') console.log('[event]', ev.type)
    }
})().catch(console.error)
```

## Workers (non-blocking)

If you want to run multiple clients concurrently without blocking the main thread, use the built-in workers. Each client can have its own event worker, and you can also offload the QR polling to a worker.

Event worker:

```ts
import { spawnEventWorker } from './dist/index.js'

const events = spawnEventWorker(client, 500) // timeoutMs = 500ms

const unEv = events.onEvent((ev) => {
    if (ev.type !== 'timeout') console.log('[worker event]', ev.type)
})
const unErr = events.onError((err) => console.error('[worker error]', err))

// ... later
await events.stop()
unEv()
unErr()
```

QR worker:

```ts
import { spawnQRWorker } from './dist/index.js'

const qr = spawnQRWorker(client, 2000) // timeoutMs = 2s
const unQREv = qr.onEvent((ev) => console.log('[qr]', ev.event === 'code' ? ev.code : ev.event))
const unQRErr = qr.onError((err) => console.error('[qr worker error]', err))

// ... later
await qr.stop()
unQREv()
unQRErr()
```

## Logging Configuration (optional)

The bridge supports runtime log configuration for Database and Client modules. Settings apply to newly created containers/clients after the call.

```ts
// Local repo import path:
import { native } from './dist/native.js'

// Or, if installed as a dependency (not re-exported by index):
// import { native } from 'whatsmeow-node/dist/native.js'

await native.setLogOptions({
    database: 'none', // DEBUG | INFO | WARN | ERROR | none
    client: 'INFO',
    color: false
})
```

## Running the Comprehensive Example

`src/example.ts` is a feature-rich, flag-driven example. Build and run:

```bash
npm run build
node dist/example.js --MODE=qr --ECHO_BOT=true \
  --LOG_CLIENT=INFO --LOG_DB=none --LOG_COLOR=false \
  --SEND_TO=123@s.whatsapp.net --SEND_TEXT="hello"
```

Supported flags (also via env vars of the same name):

- MODE=qr|pairphone
- DIALECT=sqlite3|postgres
- ADDRESS=... (SQL DSN)
- DEVICE_JID=...
- LOG_CLIENT=DEBUG|INFO|WARN|ERROR|none
- LOG_DB=DEBUG|INFO|WARN|ERROR|none
- LOG_COLOR=true|false
- ECHO_BOT=true|false
- USE_QR_WORKER=true|false
- EVENT_TIMEOUT=ms
- QR_TIMEOUT=ms
- PHONE=digits (for pairphone)
- PUSH=true|false, CLIENT_TYPE=1, DISPLAY_NAME="Browser (OS)"
- PRESENCE=available|unavailable
- WAIT_LOGIN=true|false
- WAIT_LOGIN_MS=ms
- SEND_TO=jid, SEND_TEXT=...
- SEND_IMAGE=path, IMAGE_CAPTION=...
- INVITE_JID=...

## API Surface (summary)

- Container
    - `getFirstDevice()`
    - `getAllDevices()`
    - `getDevice(jid)`
- Client
    - `connect()`, `isLoggedIn()`, `waitForConnection()`
    - `getQRChannel()`, `events(timeoutMs)`
    - `send(to, message, extra?)` (typed via `proto.WAWebProtobufsE2E.IMessage`)
    - `pairPhone(phone, showPush, clientType, displayName)`
    - `sendPresence(state)`, `subscribePresence(jid)`, `sendChatPresence(...)`
    - `uploadBytes(data, type)`, `downloadByPath(params)`
    - `getGroupInviteLink(jid, reset?)`, `disconnect()`
- native (not re-exported by index)
    - `setLogOptions(opts)` and low-level wrappers

## License

MPL-2.0
