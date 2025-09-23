import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import { JsonResp } from './types.js'

function resolveDirname(): string {
    return path.dirname(fileURLToPath(import.meta.url))
}

function libPath(): string {
    const base = path.join(resolveDirname(), '..', 'build')
    if (process.platform === 'win32') return path.join(base, 'whatsmeow.dll')
    if (process.platform === 'darwin') return path.join(base, 'whatsmeow.dylib')
    return path.join(base, 'whatsmeow.so')
}

const LIB_FILE = libPath()
if (!fs.existsSync(LIB_FILE)) {
    throw new Error(`Native library not found at ${LIB_FILE}. Run: npm run build:go`)
}

const lib = koffi.load(LIB_FILE)

const mk = (ret: string, name: string, args: string[]) => lib.func(name, ret, args)

const fns = {
    WmSetLogOptions: mk('str', 'WmSetLogOptions', ['str']),
    WmOpenContainer: mk('str', 'WmOpenContainer', ['str']),
    WmNewClient: mk('str', 'WmNewClient', ['str']),
    WmClientConnect: mk('str', 'WmClientConnect', ['str']),
    WmClientGetQRChannel: mk('str', 'WmClientGetQRChannel', ['str']),
    WmQRNext: mk('str', 'WmQRNext', ['str']),
    WmClientSendPresence: mk('str', 'WmClientSendPresence', ['str']),
    WmClientSubscribePresence: mk('str', 'WmClientSubscribePresence', ['str']),
    WmClientSendChatPresence: mk('str', 'WmClientSendChatPresence', ['str']),
    WmClientUpload: mk('str', 'WmClientUpload', ['str']),
    WmClientDownloadByPath: mk('str', 'WmClientDownloadByPath', ['str']),
    WmClientGetGroupInviteLink: mk('str', 'WmClientGetGroupInviteLink', ['str']),
    WmClientStartEvents: mk('str', 'WmClientStartEvents', ['str']),
    WmEventNext: mk('str', 'WmEventNext', ['str']),
    WmClientIsLoggedIn: mk('str', 'WmClientIsLoggedIn', ['str']),
    WmClientHasStoreID: mk('str', 'WmClientHasStoreID', ['str']),
    WmClientDisconnect: mk('str', 'WmClientDisconnect', ['str']),
    WmClientWaitForConnection: mk('str', 'WmClientWaitForConnection', ['str']),
    WmRelease: mk('str', 'WmRelease', ['str']),
    WmClientCall: mk('str', 'WmClientCall', ['str']),
    WmFreeCString: mk('void', 'WmFreeCString', ['char*'])
} as const

function call<T>(fn: keyof typeof fns | string, payload: any): T {
    const input = JSON.stringify(payload)
    // Debug markers to trace where it stops in case of crashes
    let out: any
    const bound = (fns as any)[fn as string]
    if (bound) {
        out = bound(input)
    } else {
        // dynamic resolve for functions not prebound (e.g., WmContainerGetFirstDevice on some builds)
        const dyn = lib.func(fn as string, 'str', ['str']) as unknown as (arg: string) => any
        out = dyn(input)
    }
    try {
        const json = typeof out === 'string' ? out : koffi.decode(out as Buffer, 'str')
        const data = JSON.parse(json) as JsonResp<T>
        if (!data.ok) throw new Error((data as any).error)
        return data.data
    } finally {
        // When using 'str' return type, Koffi copies the C string, so we must not free.
        if (out && Buffer.isBuffer(out)) {
            ;(fns.WmFreeCString as any)(out)
        }
    }
}

export const native = {
    setLogOptions: (opts: { database?: string; client?: string; color?: boolean }) =>
        call<{}>('WmSetLogOptions', opts),
    openContainer: (opts: { dialect: string; address: string }) =>
        call<{ handle: number }>('WmOpenContainer', opts),
    containerGetFirstDevice: (handle: number) =>
        call<{ handle: number }>('WmContainerGetFirstDevice', { handle }),
    containerGetAllDevices: (handle: number) =>
        call<{ handles: number[] }>('WmContainerGetAllDevices', { handle }),
    containerGetDevice: (handle: number, jid: string) =>
        call<{ handle: number; found: boolean }>('WmContainerGetDevice', { handle, jid }),
    newClient: (device: number) => call<{ handle: number }>('WmNewClient', { device }),
    clientConnect: (client: number) => call<{}>('WmClientConnect', { client }),
    clientHasStoreID: (client: number) => call<{ has: boolean }>('WmClientHasStoreID', { client }),
    clientGetQR: (client: number) => call<{ handle: number }>('WmClientGetQRChannel', { client }),
    qrNext: (qr: number, timeoutMs: number) => call<any>('WmQRNext', { handle: qr, timeoutMs }),
    clientSendPresence: (client: number, state: string) =>
        call<{}>('WmClientSendPresence', { client, state }),
    clientSubscribePresence: (client: number, jid: string) =>
        call<{}>('WmClientSubscribePresence', { client, jid }),
    clientSendChatPresence: (client: number, jid: string, state: string, media: string) =>
        call<{}>('WmClientSendChatPresence', { client, jid, state, media }),
    clientUpload: (client: number, dataB64: string, type: string) =>
        call<any>('WmClientUpload', { client, data: dataB64, type }),
    clientDownloadByPath: (
        client: number,
        p: {
            direct_path: string
            enc_sha256: string
            sha256: string
            media_key: string
            file_length: number
            type: string
            mms_type?: string
        }
    ) =>
        call<{ data: string }>('WmClientDownloadByPath', {
            client,
            direct_path: p.direct_path,
            enc_sha256: p.enc_sha256,
            sha256: p.sha256,
            media_key: p.media_key,
            file_length: p.file_length,
            type: p.type,
            mms_type: p.mms_type ?? ''
        }),
    clientGetGroupInviteLink: (client: number, jid: string, reset?: boolean) =>
        call<{ link: string }>('WmClientGetGroupInviteLink', { client, jid, reset: !!reset }),
    clientPairPhone: (
        client: number,
        phone: string,
        showPushNotification: boolean,
        clientType: number,
        clientDisplayName: string
    ) =>
        call<string>('WmClientCall', {
            client,
            method: 'PairPhone',
            args: [phone, !!showPushNotification, clientType, clientDisplayName]
        }),
    clientStartEvents: (client: number) =>
        call<{ handle: number }>('WmClientStartEvents', { client }),
    eventNext: (handle: number, timeoutMs: number) =>
        call<any>('WmEventNext', { handle, timeoutMs }),
    clientIsLoggedIn: (client: number) =>
        call<{ isLoggedIn: boolean }>('WmClientIsLoggedIn', { client }),
    clientDisconnect: (client: number) => call<{}>('WmClientDisconnect', { client }),
    clientWaitForConnection: (client: number, timeoutMs: number) =>
        call<{ ok: boolean }>('WmClientWaitForConnection', { client, timeoutMs }),
    clientCall: (client: number, method: string, args: any) =>
        call<any>('WmClientCall', { client, method, args }),
    release: (handle: number) => call<{}>('WmRelease', { handle })
}
