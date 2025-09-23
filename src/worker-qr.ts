import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import type { Client } from './client.js'

export interface QRWorkerController {
    onEvent(cb: (ev: any) => void): () => void
    onError(cb: (err: any) => void): () => void
    stop(): Promise<void>
    worker: Worker
}

export function spawnQRWorker(client: Client | number, timeoutMs = 2000): QRWorkerController {
    const handle =
        typeof client === 'number' ? client : ((client as Client).handle as unknown as number)
    const workerURL = new URL('./workers/qr-worker.js', import.meta.url)
    const worker = new Worker(workerURL, {
        workerData: { client: handle, timeoutMs },
        type: 'module'
    } as any)

    const emitter = new EventEmitter()

    const onMessage = (msg: any) => {
        if (msg && msg.type === 'worker_error') {
            emitter.emit('error', new Error(msg.error))
        } else {
            emitter.emit('event', msg)
        }
    }

    const onError = (err: any) => emitter.emit('error', err)

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', (code) => {
        if (code !== 0) emitter.emit('error', new Error(`qr worker exited with code ${code}`))
    })

    return {
        onEvent(cb) {
            emitter.on('event', cb)
            return () => emitter.off('event', cb)
        },
        onError(cb) {
            emitter.on('error', cb)
            return () => emitter.off('error', cb)
        },
        async stop() {
            try {
                worker.postMessage({ type: 'stop' })
            } catch {}
            await new Promise((r) => setTimeout(r, 10))
            try {
                await worker.terminate()
            } catch {}
        },
        worker
    }
}
