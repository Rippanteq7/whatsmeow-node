import { parentPort, workerData } from 'node:worker_threads'
import { native } from '../native.js'

// Worker that polls QR channel without blocking the main thread.
// Posts back objects like { event: 'code' | 'success' | 'closed' | 'timeout', ... }.
// Send { type: 'stop' } to stop.

type WorkerData = {
    client: number
    timeoutMs: number
}

const port = parentPort!
const { client, timeoutMs } = workerData as WorkerData

let running = true
let qrHandle: number | null = null

port.on('message', (msg: any) => {
    if (msg && msg.type === 'stop') running = false
})
;(async () => {
    try {
        // If the Store already has a user ID, QR flow is invalid.
        const { has } = native.clientHasStoreID(client)
        if (has) {
            port.postMessage({ event: 'skipped', reason: 'store_has_user_id' })
            return
        }
        const { handle } = native.clientGetQR(client)
        qrHandle = handle
        while (running) {
            const ev = native.qrNext(handle, timeoutMs)
            port.postMessage(ev)
            // Stop loop if QR finished
            if ((ev as any)?.event && (ev.event === 'success' || ev.event === 'closed')) break
        }
    } catch (err) {
        port.postMessage({ type: 'worker_error', error: (err as Error)?.message ?? String(err) })
    } finally {
        try {
            if (qrHandle != null) native.release(qrHandle as any)
        } catch {}
        try {
            port.close()
        } catch {}
    }
})().catch((err) => {
    try {
        port.postMessage({ type: 'worker_error', error: (err as Error)?.message ?? String(err) })
    } catch {}
})
