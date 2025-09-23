import { parentPort, workerData } from 'node:worker_threads'
import { native } from '../native.js'

// Worker that continuously polls Client events without blocking the main thread.
// Messages posted back to parent are already JS objects shaped like ClientEvent.
// Send message { type: 'stop' } to end the loop gracefully.

type WorkerData = {
    client: number
    timeoutMs: number
}

const port = parentPort!
const { client, timeoutMs } = workerData as WorkerData

let running = true
let handle: number | null = null

port.on('message', (msg: any) => {
    if (msg && msg.type === 'stop') {
        running = false
    }
})
;(async () => {
    try {
        const { handle: h } = native.clientStartEvents(client)
        handle = h
        while (running) {
            const ev = native.eventNext(h, timeoutMs)
            // If event stream indicates closure, stop the loop
            if ((ev as any)?.type === 'closed') {
                port.postMessage(ev)
                break
            }
            port.postMessage(ev)
        }
    } catch (err) {
        port.postMessage({ type: 'worker_error', error: (err as Error)?.message ?? String(err) })
    } finally {
        try {
            if (handle != null) native.release(handle as any)
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
