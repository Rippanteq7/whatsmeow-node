import { native } from './native.js'
import { Handle, JID, OpenContainerOptions, QREvent, SendResponse } from './types.js'
import type * as proto from '../proto/whatsmeow.js'
import type { SendRequestExtra } from './types.js'
import type { ClientEvent } from './events.js'
import type { ClientMethodMap } from './methods.js'

export class Container {
  constructor(public readonly handle: Handle) {}

  static async open(opts: OpenContainerOptions): Promise<Container> {
    const { handle } = native.openContainer(opts)
    return new Container(handle)
  }

  async getFirstDevice(): Promise<Device> {
    const { handle } = native.containerGetFirstDevice(this.handle)
    return new Device(handle)
  }

  async getAllDevices(): Promise<Device[]> {
    const { handles } = native.containerGetAllDevices(this.handle)
    return handles.map((h) => new Device(h))
  }

  async getDevice(jid: JID): Promise<Device | null> {
    const res = native.containerGetDevice(this.handle, jid)
    if (!res.found) return null
    return new Device(res.handle)
  }

  async close(): Promise<void> {
    native.release(this.handle)
  }
}

export class Device {
  constructor(public readonly handle: Handle) {}
}

export class QRChannel {
  constructor(public readonly handle: Handle) {}

  async next(timeoutMs: number): Promise<QREvent> {
    return native.qrNext(this.handle, timeoutMs)
  }

  async close(): Promise<void> {
    native.release(this.handle)
  }
}

export class Client {
  private constructor(public readonly handle: Handle) {}

  static async create(device: Device): Promise<Client> {
    const { handle } = native.newClient(device.handle)
    return new Client(handle)
  }

  async connect(): Promise<void> {
    native.clientConnect(this.handle)
  }

  async isLoggedIn(): Promise<boolean> {
    const { isLoggedIn } = native.clientIsLoggedIn(this.handle)
    return isLoggedIn
  }

  async waitForConnection(timeoutMs: number): Promise<boolean> {
    const { ok } = native.clientWaitForConnection(this.handle, timeoutMs)
    return ok
  }

  async getQRChannel(): Promise<QRChannel> {
    const { handle } = native.clientGetQR(this.handle)
    return new QRChannel(handle)
  }

  // Envio via proto gerado (IMessage). Use proto.WAWebProtobufsE2E.IMessage
  async send(to: JID, message: proto.WAWebProtobufsE2E.IMessage, extra?: SendRequestExtra): Promise<SendResponse> {
    if (extra) return this.call('SendMessage', to, message, extra)
    return this.call('SendMessage', to, message)
  }

  // Pairing code: calls Client.PairPhone(phone, showPushNotification, clientType, clientDisplayName)
  // clientType: 1=Chrome, 2=Edge, 3=Firefox, 6=Safari, etc.
  async pairPhone(phone: string, showPushNotification: boolean, clientType: number, clientDisplayName: string): Promise<string> {
    return this.call('PairPhone', phone, showPushNotification, clientType, clientDisplayName)
  }

  // Dispatcher genérico (tipado) para acessar métodos do Client via reflexão
  async call<K extends keyof ClientMethodMap>(method: K, ...args: Parameters<ClientMethodMap[K]>): Promise<Awaited<ReturnType<ClientMethodMap[K]>>>
  async call<T = any>(method: string, ...args: any[]): Promise<T>
  async call(method: string, ...args: any[]): Promise<any> {
    // Passa args como array; o dispatcher aceita array ou objeto (para 1 arg)
    return native.clientCall(this.handle, method, args)
  }

  // Presence API
  async sendPresence(state: 'available' | 'unavailable'): Promise<void> {
    native.clientSendPresence(this.handle, state)
  }

  async subscribePresence(jid: JID): Promise<void> {
    native.clientSubscribePresence(this.handle, jid)
  }

  async sendChatPresence(jid: JID, state: 'composing' | 'paused', media: '' | 'audio' = ''): Promise<void> {
    native.clientSendChatPresence(this.handle, jid, state, media)
  }

  // Media API
  async uploadBytes(data: Buffer | Uint8Array, type: 'image' | 'video' | 'audio' | 'document' | 'history' | 'appstate' | 'sticker-pack' | 'thumbnail-link') {
    const b64 = Buffer.from(data).toString('base64')
    return native.clientUpload(this.handle, b64, type)
  }

  async downloadByPath(params: {
    direct_path: string
    enc_sha256: string // base64
    sha256: string // base64
    media_key: string // base64
    file_length: number
    type: 'image' | 'video' | 'audio' | 'document' | 'history' | 'appstate' | 'sticker-pack' | 'thumbnail-link'
    mms_type?: string
  }): Promise<Buffer> {
    const { data } = native.clientDownloadByPath(this.handle, params)
    return Buffer.from(data, 'base64')
  }

  // Groups
  async getGroupInviteLink(jid: JID, reset = false): Promise<string> {
    const { link } = native.clientGetGroupInviteLink(this.handle, jid, reset)
    return link
  }

  async disconnect(): Promise<void> {
    native.clientDisconnect(this.handle)
  }

  // Stream de eventos em AsyncIterator
  events(timeoutMs = 60000): AsyncIterable<ClientEvent> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<ClientEvent> {
        let closed = false
        let h: Handle | null = null
        const ensure = () => {
          if (h === null) {
            const { handle } = native.clientStartEvents(self.handle)
            h = handle
          }
        }
        return {
          async next(): Promise<IteratorResult<ClientEvent>> {
            if (closed) return { done: true, value: undefined as any }
            ensure()
            const ev = native.eventNext(h as any, timeoutMs) as ClientEvent
            if ((ev as any).type === 'closed') {
              closed = true
              return { done: true, value: undefined as any }
            }
            if ((ev as any).type === 'timeout') {
              // synthesize no-op on timeout; keep waiting on next()
              return this.next()
            }
            return { done: false, value: ev }
          },
          async return(): Promise<IteratorResult<ClientEvent>> {
            if (h != null) {
              try { native.release(h as any) } catch {}
            }
            closed = true
            return { done: true, value: undefined as any }
          },
          async throw(err?: any): Promise<IteratorResult<ClientEvent>> {
            closed = true
            return Promise.reject(err)
          },
        }
      },
    }
  }
}

export async function openContainer(opts: OpenContainerOptions): Promise<Container> {
  return Container.open(opts)
}
