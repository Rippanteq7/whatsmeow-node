import fs from 'node:fs/promises'
import { openContainer, Client, JID, proto, spawnEventWorker, spawnQRWorker } from './index.js'
import { native } from './native.js'

async function sendImageFromPath(client: Client, to: JID, filePath: string, caption?: string) {
    const data = await fs.readFile(filePath)
    const up = await client.uploadBytes(data, 'image')
    const img: proto.WAWebProtobufsE2E.IImageMessage = {
        URL: up.url,
        directPath: up.direct_path,
        mediaKey: up.media_key, // base64 string (bridge expects base64 in JSON)
        fileEncSHA256: up.file_enc_sha256,
        fileSHA256: up.file_sha256,
        fileLength: up.file_length,
        mimetype: 'image/png',
        caption: caption ?? undefined
    }
    return client.send(to, { imageMessage: img })
}

function parseArgs(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const arg of process.argv.slice(2)) {
        const m = arg.match(/^--([^=]+)=(.*)$/)
        if (m) out[m[1]] = m[2]
    }
    return out
}

function getOpt(name: string, def?: string): string | undefined {
    const args = parseArgs()
    return args[name] ?? process.env[name] ?? def
}

async function main() {
    // Optional logging levels (affects newly created container/clients)
    const clientLevel = getOpt('LOG_CLIENT')
    const dbLevel = getOpt('LOG_DB')
    const color = getOpt('LOG_COLOR')
    if (clientLevel || dbLevel || color) {
        await native.setLogOptions({
            client: clientLevel,
            database: dbLevel,
            color: color ? color === 'true' : undefined
        } as any)
    }

    // Open container
    const dialectRaw = getOpt('DIALECT', 'sqlite3')!
    const dialect: 'sqlite3' | 'postgres' = dialectRaw === 'postgres' ? 'postgres' : 'sqlite3'
    const address = getOpt('ADDRESS', 'file:session.db?_foreign_keys=on')!
    const container = await openContainer({ dialect, address })

    // Devices
    const deviceJID = getOpt('DEVICE_JID') as JID | undefined
    const all = await container.getAllDevices()
    console.log(`[devices] found: ${all.length}`)

    let device: any
    if (deviceJID) {
        const found = await container.getDevice(deviceJID)
        if (!found) {
            console.log(`[devices] not found by JID: ${deviceJID}, using first/new`)
            device = await container.getFirstDevice()
        } else {
            console.log(`[devices] selected by JID: ${deviceJID}`)
            device = found
        }
    } else {
        device = await container.getFirstDevice()
        console.log('[devices] selected first/new')
    }

    const client = await Client.create(device)

    // Events via worker (non-blocking)
    const echoBot = getOpt('ECHO_BOT', 'false') === 'true'
    const workerTimeout = Number(getOpt('EVENT_TIMEOUT', '1000000'))
    const eventsWorker = spawnEventWorker(client, workerTimeout)
    eventsWorker.onError((err) => console.error('[event worker error]', err))
    eventsWorker.onEvent(async (ev) => {
        switch (ev.type) {
            case 'connected':
                console.log('[event] connected')
                break
            case 'pair_success':
            case 'pair_error':
            case 'manual_login_reconnect':
            case 'client_outdated':
            case 'stream_replaced':
            case 'temporary_ban':
            case 'logged_out':
                console.log('[event]', ev)
                break
            case 'message': {
                const m = ev.message as any
                const text = m?.conversation || m?.extendedTextMessage?.text
                console.log('[message]', ev.info.Chat, '->', ev.info.Sender, text)
                if (echoBot && text && text.toLowerCase() === 'ping') {
                    const reply: proto.WAWebProtobufsE2E.IMessage = { conversation: 'pong' }
                    const resp = await client.send(ev.info.Chat as JID, reply)
                    console.log('[send] pong:', resp)
                }
                break
            }
            default:
                if (ev.type !== 'timeout') console.log('[event]', ev.type)
        }
    })

    // Pick mode
    const mode = (getOpt('MODE', 'qr') || 'qr').toLowerCase()
    let loggedIn = await client.isLoggedIn()

    if (mode === 'qr') {
        const useQRWorker = getOpt('USE_QR_WORKER', 'true') === 'true'
        if (useQRWorker) {
            const qrTimeout = Number(getOpt('QR_TIMEOUT', '2000'))
            const qrWorker = spawnQRWorker(client, qrTimeout)
            qrWorker.onError((err) => console.error('[qr worker error]', err))
            qrWorker.onEvent((ev) => {
                if (ev.event === 'code') console.log('[qr]', ev.code)
                else console.log('[qr]', ev.event)
            })
            await new Promise((r) => setTimeout(r, 1000))
        } else {
            const qr = await client.getQRChannel()
            setImmediate(() => {
                ;(async () => {
                    for (;;) {
                        const ev = await qr.next(2000)
                        if (ev.event === 'code') {
                            console.log('[qr]', ev.code)
                        } else {
                            console.log('[qr]', ev.event)
                            break
                        }
                        await new Promise((r) => setImmediate(r))
                    }
                })().catch(console.error)
            })
        }
    }

    // Connect
    console.log('Connecting...')
    await client.connect()
    console.log('Connected (waiting for login)')

    // Ensure we actually wait for login (QR or pairphone) before using loggedIn
    const waitLogin = getOpt('WAIT_LOGIN', 'true') === 'true'
    if (waitLogin && !loggedIn) {
        const maxMs = Number(getOpt('WAIT_LOGIN_MS', '120000')) // default 2 min
        const deadline = Date.now() + maxMs
        while (Date.now() < deadline) {
            const ok = await client.waitForConnection(1000)
            loggedIn = ok || (await client.isLoggedIn())
            if (loggedIn) break
            await new Promise((r) => setTimeout(r, 100))
        }
    }
    console.log('[loggedIn]', loggedIn)

    // Pair phone code flow (optional)
    if (mode === 'pairphone' && !loggedIn) {
        const phone = getOpt('PHONE')
        if (!phone)
            throw new Error('PHONE is required for pairphone mode (digits only, intl format)')
        const showPush = getOpt('PUSH', 'true') === 'true'
        const clientType = Number(getOpt('CLIENT_TYPE', '1')) // 1=Chrome
        const displayName = getOpt('DISPLAY_NAME', 'Chrome (Windows)')!
        const code = await client.pairPhone(phone, showPush, clientType, displayName)
        console.log('[pairing code]', code)
    }

    await new Promise((r) => setTimeout(r, 3000))
    if (!loggedIn) {
        console.warn(
            '[login] not logged in yet; will skip presence/send/group actions. Scan the QR or use pairphone.'
        )
    } else {
        // Presence (optional)
        const presence = getOpt('PRESENCE') as 'available' | 'unavailable' | undefined
        if (presence) {
            await client.sendPresence(presence)
            console.log('[presence] sent:', presence)
        }

        // Send text (optional)
        const to = getOpt('SEND_TO') as JID | undefined
        const text = getOpt('SEND_TEXT')
        if (to && text) {
            const msg: proto.WAWebProtobufsE2E.IMessage = { conversation: text }
            const resp = await client.send(to, msg)
            console.log('[send] text:', resp)
        }

        // Send image (optional)
        const imgPath = getOpt('SEND_IMAGE')
        const imgCaption = getOpt('IMAGE_CAPTION')
        if (to && imgPath) {
            try {
                const resp = await sendImageFromPath(client, to, imgPath, imgCaption)
                console.log('[send] image:', resp)
            } catch (err) {
                console.error('[send] image error:', err)
            }
        }

        // Group invite link (optional)
        const inviteJid = getOpt('INVITE_JID') as JID | undefined
        if (inviteJid) {
            const link = await client.getGroupInviteLink(inviteJid, false)
            console.log('[group invite link]', link)
        }
    }
}

main().catch(console.error)
