import type { JID, MessageInfo, MessageSource, NewsletterMetadata, NewsletterLiveUpdateMessage } from './types.js'
import type * as proto from '../proto/whatsmeow.js'

export type ClientEvent =
  // Connection lifecycle
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'manual_login_reconnect' }
  | { type: 'stream_replaced' }
  | { type: 'client_outdated' }
  | { type: 'qr_scanned_without_multidevice' }
  | { type: 'pair_success'; id: JID; lid: JID; business_name: string; platform: string }
  | { type: 'pair_error'; id: JID; lid: JID; business_name: string; platform: string; error?: string }
  | { type: 'logged_out'; on_connect: boolean; reason: string }
  | { type: 'cat_refresh_error'; error: string }
  | { type: 'connect_failure'; reason: string; message: string }
  | { type: 'temporary_ban'; code: number; expire_ms: number }
  | { type: 'keepalive_timeout'; error_count: number; last_success: string }
  | { type: 'keepalive_restored' }

  // Receipts & presence
  | {
      type: 'receipt'
      info: MessageSource
      message_ids: string[]
      timestamp: string
      receipt_type: string
      message_sender: JID
    }
  | { type: 'presence'; from: JID; unavailable: boolean; last_seen: string }
  | { type: 'chat_presence'; chat: JID; sender: JID; is_from_me: boolean; state: string; media: string }

  // Message-like
  | {
      type: 'message'
      info: MessageInfo
      is_ephemeral: boolean
      is_view_once: boolean
      is_view_once_v2: boolean
      is_view_once_v2_ext: boolean
      is_document_with_caption: boolean
      is_lottie_sticker: boolean
      is_edit: boolean
      is_bot_invoke: boolean
      retry_count: number
      message?: proto.WAWebProtobufsE2E.IMessage
      raw_message?: proto.WAWebProtobufsE2E.IMessage
      source_web_msg?: proto.WAWebProtobufsWeb.IWebMessageInfo
      unavailable_request_id?: string
      newsletter_meta?: { edit_ts: string; original_ts: string }
    }
  | {
      type: 'undecryptable_message'
      info: MessageInfo
      is_unavailable: boolean
      unavailable_type: string
      decrypt_fail_mode: string
    }
  | {
      type: 'fb_message'
      info: MessageInfo
      retry_count: number
      transport?: proto.WAMsgTransport.IMessageTransport
      fb_application?: proto.WAMsgApplication.IMessageApplication
      ig_transport?: proto.InstamadilloTransportPayload.ITransportPayload
    }

  // History sync
  | { type: 'history_sync'; data?: proto.WAWebProtobufsHistorySync.IHistorySync }

  // Groups & users
  | {
      type: 'joined_group'
      reason: string
      join_type: string
      create_key: string
      sender: JID
      sender_pn: JID
      notify: string
      group: any
    }
  | { type: 'group_info'; jid: JID; notify: string; sender: JID; sender_pn: JID; timestamp: string; [k: string]: any }
  | { type: 'picture'; jid: JID; author: JID; timestamp: string; remove: boolean; picture_id: string }
  | { type: 'user_about'; jid: JID; status: string; timestamp: string }
  | { type: 'identity_change'; jid: JID; timestamp: string; implicit: boolean }
  | {
      type: 'privacy_settings'
      new_settings: any
      group_add_changed: boolean
      last_seen_changed: boolean
      status_changed: boolean
      profile_changed: boolean
      read_receipts_changed: boolean
      online_changed: boolean
      call_add_changed: boolean
    }
  | { type: 'offline_sync_preview'; total: number; app_data_changes: number; messages: number; notifications: number; receipts: number }
  | { type: 'offline_sync_completed'; count: number }
  | {
      type: 'media_retry'
      ciphertext_b64?: string
      iv_b64?: string
      error?: { code: number }
      timestamp: string
      message_id: string
      chat_id: JID
      sender_id: JID
      from_me: boolean
    }
  | { type: 'blocklist'; action: string; dhash: string; prev_dhash: string; changes: Array<{ jid: JID; action: string }> }
  | { type: 'newsletter_join'; metadata: NewsletterMetadata }
  | { type: 'newsletter_leave'; id: JID; role: string }
  | { type: 'newsletter_mute_change'; id: JID; mute: string }
  | { type: 'newsletter_live_update'; jid: JID; time: string; messages: NewsletterLiveUpdateMessage[] }

  // AppState (sync actions)
  | { type: 'appstate_contact'; jid: JID; timestamp: string; action?: proto.WASyncAction.IContactAction; from_full_sync: boolean }
  | { type: 'appstate_push_name'; jid: JID; message?: MessageInfo; old_push_name: string; new_push_name: string }
  | { type: 'appstate_business_name'; jid: JID; message?: MessageInfo; old_business_name: string; new_business_name: string }
  | { type: 'appstate_pin'; jid: JID; timestamp: string; action?: proto.WASyncAction.IPinAction; from_full_sync: boolean }
  | { type: 'appstate_star'; chat_jid: JID; sender_jid: JID; is_from_me: boolean; message_id: string; timestamp: string; action?: proto.WASyncAction.IStarAction; from_full_sync: boolean }
  | { type: 'appstate_delete_for_me'; chat_jid: JID; sender_jid: JID; is_from_me: boolean; message_id: string; timestamp: string; action?: proto.WASyncAction.IDeleteMessageForMeAction; from_full_sync: boolean }
  | { type: 'appstate_mute'; jid: JID; timestamp: string; action?: proto.WASyncAction.IMuteAction; from_full_sync: boolean }
  | { type: 'appstate_archive'; jid: JID; timestamp: string; action?: proto.WASyncAction.IArchiveChatAction; from_full_sync: boolean }
  | { type: 'appstate_mark_chat_as_read'; jid: JID; timestamp: string; action?: proto.WASyncAction.IMarkChatAsReadAction; from_full_sync: boolean }
  | { type: 'appstate_clear_chat'; jid: JID; timestamp: string; action?: proto.WASyncAction.IClearChatAction; from_full_sync: boolean }
  | { type: 'appstate_delete_chat'; jid: JID; timestamp: string; action?: proto.WASyncAction.IDeleteChatAction; from_full_sync: boolean }
  | { type: 'appstate_push_name_setting'; timestamp: string; action?: proto.WASyncAction.IPushNameSetting; from_full_sync: boolean }
  | { type: 'appstate_unarchive_chats_setting'; timestamp: string; action?: proto.WASyncAction.IUnarchiveChatsSetting; from_full_sync: boolean }
  | { type: 'appstate_user_status_mute'; jid: JID; timestamp: string; action?: proto.WASyncAction.IUserStatusMuteAction; from_full_sync: boolean }
  | { type: 'appstate_label_edit'; timestamp: string; label_id: string; action?: proto.WASyncAction.ILabelEditAction; from_full_sync: boolean }
  | { type: 'appstate_label_association_chat'; jid: JID; timestamp: string; label_id: string; action?: proto.WASyncAction.ILabelAssociationAction; from_full_sync: boolean }
  | { type: 'appstate_label_association_message'; jid: JID; timestamp: string; label_id: string; message_id: string; action?: proto.WASyncAction.ILabelAssociationAction; from_full_sync: boolean }
  | { type: 'appstate'; index: string[]; value?: proto.WASyncAction.ISyncActionValue }
  | { type: 'appstate_sync_complete'; name: string }

  // Calls
  | { type: 'call_offer'; basic: any; remote: any; data: any }
  | { type: 'call_accept'; basic: any; remote: any; data: any }
  | { type: 'call_pre_accept'; basic: any; remote: any; data: any }
  | { type: 'call_transport'; basic: any; remote: any; data: any }
  | { type: 'call_offer_notice'; basic: any; media: string; notice_type: string; data: any }
  | { type: 'call_relay_latency'; basic: any; data: any }
  | { type: 'call_terminate'; basic: any; reason: string; data: any }
  | { type: 'call_reject'; basic: any; data: any }
  | { type: 'call_unknown'; node: any }

  // internal control events from eventNext
  | { type: 'timeout' }
  | { type: 'closed' }
