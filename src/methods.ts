import type { JID, SendResponse, SendRequestExtra } from './types.js'
import type { proto } from './types.js'

// This interface declares TypeScript typings for a subset of whatsmeow Client methods
// that can be invoked via client.call(). The Go bridge injects context.Context automatically
// and converts argument/return types as follows:
// - types.JID            <-> string (e.g., "123@s.whatsapp.net")
// - time.Duration        <-> number (milliseconds)
// - *waE2E.Message       <-> any (serialized via protojson on return, accept plain object on input)
// - []byte               <-> base64 string (when applicable)
// - error (last return)  -> throws on the JS side
//
// For methods not listed here, client.call<string>(...) is still available with loose typing.
export interface ClientMethodMap {
  // Messaging
  SendMessage: (to: JID, message: proto.WAWebProtobufsE2E.IMessage, extra?: SendRequestExtra) => SendResponse
  GenerateMessageID: () => string
  BuildRevoke: (chat: JID, sender: JID, id: string) => any

  // Presence
  SendPresence: (state: 'available' | 'unavailable') => {}
  SubscribePresence: (jid: JID) => {}
  SendChatPresence: (jid: JID, state: 'composing' | 'paused', media?: '' | 'audio') => {}

  // Groups
  GetGroupInviteLink: (jid: JID, reset?: boolean) => string

  // Connection helpers
  WaitForConnection: (timeoutMs: number) => boolean
  IsLoggedIn: () => boolean

  // Pairing code
  PairPhone: (phone: string, showPushNotification: boolean, clientType: number, clientDisplayName: string) => string

  // Logout
  Logout: () => {}

  // Index signature for other methods (will be refined by codegen in the future)
  [method: string]: (...args: any[]) => any
}
