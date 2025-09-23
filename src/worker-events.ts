import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import type { Client } from './client.js'
import type { ClientEvent } from './events.js'

export interface EventWorkerController {
    /** Subscribe to events coming from the worker. Returns an unsubscribe fn. */
    onEvent(cb: (ev: ClientEvent) => void): () => void
    /** Subscribe to errors coming from the worker. Returns an unsubscribe fn. */
    onError(cb: (err: any) => void): () => void
    /** Stop the worker and clean up resources. */
    stop(): Promise<void>
    /** Access to the underlying Node Worker if needed. */
    worker: Worker
}

/**
 * Spawn a dedicated worker thread that polls client events without blocking the main thread.
 * You can run many of these concurrently (one per client) safely.
 */
export function spawnEventWorker(client: Client | number, timeoutMs = 500): EventWorkerController {
    const handle =
        typeof client === 'number' ? client : ((client as Client).handle as unknown as number)
    const workerURL = new URL('./workers/event-worker.js', import.meta.url)
    const worker = new Worker(workerURL, {
        workerData: { client: handle, timeoutMs },
        type: 'module'
    } as any)

    const emitter = new EventEmitter()

    const onMessage = (msg: any) => {
        if (msg && msg.type === 'worker_error') {
            emitter.emit('error', new Error(msg.error))
        } else {
            emitter.emit('event', msg as ClientEvent)
        }
    }

    const onError = (err: any) => emitter.emit('error', err)

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', (code) => {
        if (code !== 0) emitter.emit('error', new Error(`event worker exited with code ${code}`))
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
            // Give the worker a tick to cleanly finish
            await new Promise((r) => setTimeout(r, 10))
            try {
                await worker.terminate()
            } catch {}
        },
        worker
    }
}
