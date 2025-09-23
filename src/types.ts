import type * as proto from '../proto/whatsmeow.js'
export * as proto from '../proto/whatsmeow.js'
export * from '../proto/whatsmeow.js'

export type Handle = number
export type JID = string

export interface OpenContainerOptions {
  dialect: 'sqlite3' | 'postgres'
  address: string
}

// Mirrors whatsmeow.SendRequestExtra (subset, aligned to JSON marshal casing)
export interface SendRequestExtra {
  ID?: string
  InlineBotJID?: JID
  Peer?: boolean
  Timeout?: number // milliseconds
  MediaHandle?: string
  Meta?: MsgMetaInfo
}

export interface SendResponse {
  timestamp: string // ISO
  id: string
  serverId?: number
  sender: JID
  debug?: {
    queueMs?: number
    marshalMs?: number
    getParticipantsMs?: number
    getDevicesMs?: number
    groupEncryptMs?: number
    peerEncryptMs?: number
    sendMs?: number
    respMs?: number
    retryMs?: number
  }
}

export type QREvent =
  | { event: 'code'; code: string; timeoutMs: number }
  | { event: 'success' }
  | { event: 'timeout' }
  | { event: 'closed' }
  | { event: 'err-unexpected-state' }
  | { event: 'err-client-outdated' }
  | { event: 'error'; error: string }

export interface JsonOk<T> {
  ok: true
  data: T
}

export interface JsonErr {
  ok: false
  error: string
}

export type JsonResp<T> = JsonOk<T> | JsonErr

// Shapes mirroring go.mau.fi/whatsmeow/types.MessageInfo and related structs.
// Casing matches the JSON produced by encoding/json for exported Go fields.

export interface MessageSource {
  Chat: JID
  Sender: JID
  IsFromMe: boolean
  IsGroup: boolean
  AddressingMode?: string
  SenderAlt?: JID
  RecipientAlt?: JID
  BroadcastListOwner?: JID
  BroadcastRecipients?: Array<{ LID: JID; PN?: JID }>
}

export type EditAttribute = string
export type BotEditType = 'first' | 'inner' | 'last' | ''

export interface MsgBotInfo {
  EditType?: BotEditType
  EditTargetID?: string
  EditSenderTimestampMS?: string | number | Date
}

export interface MsgMetaInfo {
  TargetID?: string
  TargetSender?: JID
  TargetChat?: JID
  DeprecatedLIDSession?: boolean
  ThreadMessageID?: string
  ThreadMessageSenderJID?: JID
}

export interface DeviceSentMeta {
  DestinationJID?: string
  Phash?: string
}

export interface MessageInfo extends MessageSource {
  ID: string
  ServerID?: number
  Type?: string
  PushName?: string
  Timestamp: string
  Category?: string
  Multicast?: boolean
  MediaType?: string
  Edit?: EditAttribute

  MsgBotInfo?: MsgBotInfo
  MsgMetaInfo?: MsgMetaInfo

  VerifiedName?: any
  DeviceSentMeta?: DeviceSentMeta
}

// Newsletter typed shapes (match Go JSON output)
export interface WrappedNewsletterState { type: string }

export interface NewsletterText {
  text: string
  id: string
  update_time: string
}

export interface NewsletterThreadMetadata {
  creation_time: string
  invite: string
  name: NewsletterText
  description: NewsletterText
  subscribers_count: string
  verification: string
  picture?: any
  preview?: any
  settings?: any
}

export interface NewsletterViewerMetadata {
  mute: string // 'on' | 'off'
  role: string // 'subscriber' | 'guest' | 'admin' | 'owner'
}

export interface NewsletterMetadata {
  id: JID
  state: WrappedNewsletterState
  thread_metadata: NewsletterThreadMetadata
  viewer_metadata?: NewsletterViewerMetadata
}

export interface NewsletterLiveUpdateMessage {
  MessageServerID: number
  MessageID: string
  Type: string
  Timestamp: string
  ViewsCount: number
  ReactionCounts: Record<string, number>
  Message?: proto.WAWebProtobufsE2E.IMessage
}
