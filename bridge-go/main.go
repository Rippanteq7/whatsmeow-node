package main

/*
#cgo CFLAGS: -DNAPI_GO_BRIDGE
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	wa "go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	_ "github.com/mattn/go-sqlite3"
	"github.com/lib/pq"
)

type handle uint64

var nextHandle atomic.Uint64

// --- Logging configuration (optional levels) ---
type logOptions struct {
	Database string `json:"database"`
	Client   string `json:"client"`
	Color    bool   `json:"color"`
}

func init() {
    // Enable Postgres array support by wiring the wrapper expected by whatsmeow's sqlstore
    sqlstore.PostgresArrayWrapper = pq.Array
}

var (
	logCfg   = logOptions{Database: "DEBUG", Client: "DEBUG", Color: true}
	logCfgMu sync.RWMutex
)

func makeLogger(module, level string, color bool) waLog.Logger {
	if strings.EqualFold(level, "none") {
		return waLog.Noop
	}
	return waLog.Stdout(module, strings.ToUpper(level), color)
}

func newDBLogger() waLog.Logger {
	logCfgMu.RLock()
	cfg := logCfg
	logCfgMu.RUnlock()
	return makeLogger("Database", cfg.Database, cfg.Color)
}

func newClientLogger() waLog.Logger {
	logCfgMu.RLock()
	cfg := logCfg
	logCfgMu.RUnlock()
	return makeLogger("Client", cfg.Client, cfg.Color)
}

//export WmSetLogOptions
func WmSetLogOptions(input *C.char) *C.char {
	var req struct {
		Database string `json:"database"`
		Client   string `json:"client"`
		Color    *bool  `json:"color"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &req); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	logCfgMu.Lock()
	if req.Database != "" {
		logCfg.Database = req.Database
	}
	if req.Client != "" {
		logCfg.Client = req.Client
	}
	if req.Color != nil {
		logCfg.Color = *req.Color
	}
	logCfgMu.Unlock()
	return success(map[string]any{})
}

func newHandle() handle { return handle(nextHandle.Add(1)) }

//export WmClientIsLoggedIn
func WmClientIsLoggedIn(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	return success(map[string]any{"isLoggedIn": cli.IsLoggedIn()})
}

//export WmClientHasStoreID
func WmClientHasStoreID(input *C.char) *C.char {
    var payload struct {
        Client uint64 `json:"client"`
    }
    if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
        return fail(fmt.Errorf("invalid json: %w", err))
    }
    clientsMu.RLock()
    cli := clients[handle(payload.Client)]
    clientsMu.RUnlock()
    if cli == nil {
        return fail(errors.New("client handle not found"))
    }
    has := !cli.Store.GetJID().IsEmpty()
    return success(map[string]any{"has": has})
}

//export WmClientDisconnect
func WmClientDisconnect(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	cli.Disconnect()
	return success(map[string]any{})
}

//export WmClientWaitForConnection
func WmClientWaitForConnection(input *C.char) *C.char {
	var payload struct {
		Client    uint64 `json:"client"`
		TimeoutMs int    `json:"timeoutMs"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	ok := cli.WaitForConnection(time.Duration(payload.TimeoutMs) * time.Millisecond)
	return success(map[string]any{"ok": ok})
}

func marshalProtoToMap(m proto.Message) map[string]any {
	if m == nil {
		return nil
	}
	b, err := protojson.Marshal(m)
	if err != nil {
		return nil
	}
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func serializeEvent(raw interface{}) map[string]any {
	switch evt := raw.(type) {
	// Connection lifecycle
	case *events.Connected:
		return map[string]any{"type": "connected"}
	case *events.Disconnected:
		return map[string]any{"type": "disconnected"}
	case *events.ManualLoginReconnect:
		return map[string]any{"type": "manual_login_reconnect"}
	case *events.StreamReplaced:
		return map[string]any{"type": "stream_replaced"}
	case *events.ClientOutdated:
		return map[string]any{"type": "client_outdated"}
	case *events.QRScannedWithoutMultidevice:
		return map[string]any{"type": "qr_scanned_without_multidevice"}
	case *events.PairSuccess:
		return map[string]any{"type": "pair_success", "id": evt.ID.String(), "lid": evt.LID.String(), "business_name": evt.BusinessName, "platform": evt.Platform}
	case *events.PairError:
		// When pair success message received but local finish fails
		var errStr string
		if evt.Error != nil {
			errStr = evt.Error.Error()
		}
		return map[string]any{"type": "pair_error", "id": evt.ID.String(), "lid": evt.LID.String(), "business_name": evt.BusinessName, "platform": evt.Platform, "error": errStr}
	case *events.LoggedOut:
		return map[string]any{"type": "logged_out", "on_connect": evt.OnConnect, "reason": evt.Reason.NumberString()}
	case *events.CATRefreshError:
		return map[string]any{"type": "cat_refresh_error", "error": evt.Error.Error()}
	case *events.ConnectFailure:
		return map[string]any{"type": "connect_failure", "reason": evt.Reason.NumberString(), "message": evt.Message}
	case *events.StreamError:
		return map[string]any{"type": "stream_error", "code": evt.Code}
	case *events.TemporaryBan:
		return map[string]any{"type": "temporary_ban", "code": int(evt.Code), "expire_ms": int64(evt.Expire / time.Millisecond)}
	case *events.KeepAliveTimeout:
		return map[string]any{"type": "keepalive_timeout", "error_count": evt.ErrorCount, "last_success": evt.LastSuccess.Format(time.RFC3339)}
	case *events.KeepAliveRestored:
		return map[string]any{"type": "keepalive_restored"}

	// Receipts & presence
	case *events.Receipt:
		return map[string]any{
			"type":           "receipt",
			"info":           evt.MessageSource,
			"message_ids":    evt.MessageIDs,
			"timestamp":      evt.Timestamp.Format(time.RFC3339),
			"receipt_type":   string(evt.Type),
			"message_sender": evt.MessageSender.String(),
		}
	case *events.Presence:
		return map[string]any{"type": "presence", "from": evt.From.String(), "unavailable": evt.Unavailable, "last_seen": evt.LastSeen.Format(time.RFC3339)}
	case *events.ChatPresence:
		return map[string]any{"type": "chat_presence", "chat": evt.MessageSource.Chat.String(), "sender": evt.MessageSource.Sender.String(), "is_from_me": evt.MessageSource.IsFromMe, "state": string(evt.State), "media": string(evt.Media)}

	// Message-like
	case *events.Message:
		out := map[string]any{
			"type":                     "message",
			"info":                     evt.Info,
			"is_ephemeral":             evt.IsEphemeral,
			"is_view_once":             evt.IsViewOnce,
			"is_view_once_v2":          evt.IsViewOnceV2,
			"is_view_once_v2_ext":      evt.IsViewOnceV2Extension,
			"is_document_with_caption": evt.IsDocumentWithCaption,
			"is_lottie_sticker":        evt.IsLottieSticker,
			"is_edit":                  evt.IsEdit,
			"is_bot_invoke":            evt.IsBotInvoke,
			"retry_count":              evt.RetryCount,
		}
		if evt.Message != nil {
			out["message"] = marshalProtoToMap(evt.Message)
		}
		if evt.RawMessage != nil {
			out["raw_message"] = marshalProtoToMap(evt.RawMessage)
		}
		if evt.SourceWebMsg != nil {
			out["source_web_msg"] = marshalProtoToMap(evt.SourceWebMsg)
		}
		if evt.UnavailableRequestID != "" {
			out["unavailable_request_id"] = string(evt.UnavailableRequestID)
		}
		if evt.NewsletterMeta != nil {
			out["newsletter_meta"] = map[string]any{
				"edit_ts":     evt.NewsletterMeta.EditTS.Format(time.RFC3339),
				"original_ts": evt.NewsletterMeta.OriginalTS.Format(time.RFC3339),
			}
		}
		return out
	case *events.UndecryptableMessage:
		return map[string]any{
			"type":              "undecryptable_message",
			"info":              evt.Info,
			"is_unavailable":    evt.IsUnavailable,
			"unavailable_type":  string(evt.UnavailableType),
			"decrypt_fail_mode": string(evt.DecryptFailMode),
		}
	case *events.FBMessage:
		out := map[string]any{
			"type":        "fb_message",
			"info":        evt.Info,
			"retry_count": evt.RetryCount,
		}
		if evt.Transport != nil {
			out["transport"] = marshalProtoToMap(evt.Transport)
		}
		if evt.FBApplication != nil {
			out["fb_application"] = marshalProtoToMap(evt.FBApplication)
		}
		if evt.IGTransport != nil {
			out["ig_transport"] = marshalProtoToMap(evt.IGTransport)
		}
		// evt.Message is an interface; not a proto.Message directly; skip generic marshal
		return out

	// History sync
	case *events.HistorySync:
		return map[string]any{"type": "history_sync", "data": marshalProtoToMap(evt.Data)}

	// Group & user
	case *events.JoinedGroup:
		return map[string]any{
			"type":       "joined_group",
			"reason":     evt.Reason,
			"join_type":  evt.Type,
			"create_key": string(evt.CreateKey),
			"sender":     strPtr(evt.Sender),
			"sender_pn":  strPtr(evt.SenderPN),
			"notify":     evt.Notify,
			"group":      evt.GroupInfo,
		}
	case *events.GroupInfo:
		return map[string]any{
			"type":                        "group_info",
			"jid":                         evt.JID.String(),
			"notify":                      evt.Notify,
			"sender":                      strPtr(evt.Sender),
			"sender_pn":                   strPtr(evt.SenderPN),
			"timestamp":                   evt.Timestamp.Format(time.RFC3339),
			"name":                        evt.Name,
			"topic":                       evt.Topic,
			"locked":                      evt.Locked,
			"announce":                    evt.Announce,
			"ephemeral":                   evt.Ephemeral,
			"membership_approval_mode":    evt.MembershipApprovalMode,
			"delete":                      evt.Delete,
			"link":                        evt.Link,
			"unlink":                      evt.Unlink,
			"new_invite_link":             evt.NewInviteLink,
			"prev_participant_version_id": evt.PrevParticipantVersionID,
			"participant_version_id":      evt.ParticipantVersionID,
			"join_reason":                 evt.JoinReason,
			"join":                        evt.Join,
			"leave":                       evt.Leave,
			"promote":                     evt.Promote,
			"demote":                      evt.Demote,
			"unknown_changes":             evt.UnknownChanges,
		}
	case *events.Picture:
		return map[string]any{"type": "picture", "jid": evt.JID.String(), "author": evt.Author.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "remove": evt.Remove, "picture_id": evt.PictureID}
	case *events.UserAbout:
		return map[string]any{"type": "user_about", "jid": evt.JID.String(), "status": evt.Status, "timestamp": evt.Timestamp.Format(time.RFC3339)}
	case *events.IdentityChange:
		return map[string]any{"type": "identity_change", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "implicit": evt.Implicit}
	case *events.PrivacySettings:
		return map[string]any{"type": "privacy_settings", "new_settings": evt.NewSettings, "group_add_changed": evt.GroupAddChanged, "last_seen_changed": evt.LastSeenChanged, "status_changed": evt.StatusChanged, "profile_changed": evt.ProfileChanged, "read_receipts_changed": evt.ReadReceiptsChanged, "online_changed": evt.OnlineChanged, "call_add_changed": evt.CallAddChanged}
	case *events.OfflineSyncPreview:
		return map[string]any{"type": "offline_sync_preview", "total": evt.Total, "app_data_changes": evt.AppDataChanges, "messages": evt.Messages, "notifications": evt.Notifications, "receipts": evt.Receipts}
	case *events.OfflineSyncCompleted:
		return map[string]any{"type": "offline_sync_completed", "count": evt.Count}
	case *events.MediaRetry:
		out := map[string]any{"type": "media_retry", "ciphertext_b64": base64.StdEncoding.EncodeToString(evt.Ciphertext), "iv_b64": base64.StdEncoding.EncodeToString(evt.IV), "timestamp": evt.Timestamp.Format(time.RFC3339), "message_id": string(evt.MessageID), "chat_id": evt.ChatID.String(), "sender_id": evt.SenderID.String(), "from_me": evt.FromMe}
		if evt.Error != nil {
			out["error"] = map[string]any{"code": evt.Error.Code}
		}
		return out
	case *events.Blocklist:
		return map[string]any{"type": "blocklist", "action": string(evt.Action), "dhash": evt.DHash, "prev_dhash": evt.PrevDHash, "changes": evt.Changes}
	case *events.NewsletterJoin:
		meta := map[string]any{
			"id":              evt.ID,         // types.JID implements encoding.TextMarshaler -> JSON string
			"state":           evt.State,      // WrappedNewsletterState with json tags
			"thread_metadata": evt.ThreadMeta, // contains fields with json tags
		}
		if evt.ViewerMeta != nil {
			meta["viewer_metadata"] = evt.ViewerMeta
		}
		return map[string]any{"type": "newsletter_join", "metadata": meta}
	case *events.NewsletterLeave:
		return map[string]any{"type": "newsletter_leave", "id": evt.ID.String(), "role": string(evt.Role)}
	case *events.NewsletterMuteChange:
		return map[string]any{"type": "newsletter_mute_change", "id": evt.ID.String(), "mute": string(evt.Mute)}
	case *events.NewsletterLiveUpdate:
		msgs := make([]map[string]any, len(evt.Messages))
		for i, m := range evt.Messages {
			mm := map[string]any{
				"MessageServerID": int(m.MessageServerID),
				"MessageID":       string(m.MessageID),
				"Type":            m.Type,
				"Timestamp":       m.Timestamp.Format(time.RFC3339),
				"ViewsCount":      m.ViewsCount,
				"ReactionCounts":  m.ReactionCounts,
			}
			if m.Message != nil {
				mm["Message"] = marshalProtoToMap(m.Message)
			}
			msgs[i] = mm
		}
		return map[string]any{"type": "newsletter_live_update", "jid": evt.JID.String(), "time": evt.Time.Format(time.RFC3339), "messages": msgs}

	// AppState (sync actions)
	case *events.Contact:
		return map[string]any{"type": "appstate_contact", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.PushName:
		return map[string]any{"type": "appstate_push_name", "jid": evt.JID.String(), "message": evt.Message, "old_push_name": evt.OldPushName, "new_push_name": evt.NewPushName}
	case *events.BusinessName:
		return map[string]any{"type": "appstate_business_name", "jid": evt.JID.String(), "message": evt.Message, "old_business_name": evt.OldBusinessName, "new_business_name": evt.NewBusinessName}
	case *events.Pin:
		return map[string]any{"type": "appstate_pin", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.Star:
		return map[string]any{"type": "appstate_star", "chat_jid": evt.ChatJID.String(), "sender_jid": evt.SenderJID.String(), "is_from_me": evt.IsFromMe, "message_id": evt.MessageID, "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.DeleteForMe:
		return map[string]any{"type": "appstate_delete_for_me", "chat_jid": evt.ChatJID.String(), "sender_jid": evt.SenderJID.String(), "is_from_me": evt.IsFromMe, "message_id": evt.MessageID, "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.Mute:
		return map[string]any{"type": "appstate_mute", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.Archive:
		return map[string]any{"type": "appstate_archive", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.MarkChatAsRead:
		return map[string]any{"type": "appstate_mark_chat_as_read", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.ClearChat:
		return map[string]any{"type": "appstate_clear_chat", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.DeleteChat:
		return map[string]any{"type": "appstate_delete_chat", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.PushNameSetting:
		return map[string]any{"type": "appstate_push_name_setting", "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.UnarchiveChatsSetting:
		return map[string]any{"type": "appstate_unarchive_chats_setting", "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.UserStatusMute:
		return map[string]any{"type": "appstate_user_status_mute", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.LabelEdit:
		return map[string]any{"type": "appstate_label_edit", "timestamp": evt.Timestamp.Format(time.RFC3339), "label_id": evt.LabelID, "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.LabelAssociationChat:
		return map[string]any{"type": "appstate_label_association_chat", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "label_id": evt.LabelID, "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.LabelAssociationMessage:
		return map[string]any{"type": "appstate_label_association_message", "jid": evt.JID.String(), "timestamp": evt.Timestamp.Format(time.RFC3339), "label_id": evt.LabelID, "message_id": evt.MessageID, "action": marshalProtoToMap(evt.Action), "from_full_sync": evt.FromFullSync}
	case *events.AppState:
		out := map[string]any{"type": "appstate", "index": evt.Index}
		if evt.SyncActionValue != nil {
			out["value"] = marshalProtoToMap(evt.SyncActionValue)
		}
		return out
	case *events.AppStateSyncComplete:
		return map[string]any{"type": "appstate_sync_complete", "name": string(evt.Name)}

	// Calls
	case *events.CallOffer:
		return map[string]any{"type": "call_offer", "basic": evt.BasicCallMeta, "remote": evt.CallRemoteMeta, "data": evt.Data}
	case *events.CallAccept:
		return map[string]any{"type": "call_accept", "basic": evt.BasicCallMeta, "remote": evt.CallRemoteMeta, "data": evt.Data}
	case *events.CallPreAccept:
		return map[string]any{"type": "call_pre_accept", "basic": evt.BasicCallMeta, "remote": evt.CallRemoteMeta, "data": evt.Data}
	case *events.CallTransport:
		return map[string]any{"type": "call_transport", "basic": evt.BasicCallMeta, "remote": evt.CallRemoteMeta, "data": evt.Data}
	case *events.CallOfferNotice:
		return map[string]any{"type": "call_offer_notice", "basic": evt.BasicCallMeta, "media": evt.Media, "notice_type": evt.Type, "data": evt.Data}
	case *events.CallRelayLatency:
		return map[string]any{"type": "call_relay_latency", "basic": evt.BasicCallMeta, "data": evt.Data}
	case *events.CallTerminate:
		return map[string]any{"type": "call_terminate", "basic": evt.BasicCallMeta, "reason": evt.Reason, "data": evt.Data}
	case *events.CallReject:
		return map[string]any{"type": "call_reject", "basic": evt.BasicCallMeta, "data": evt.Data}
	case *events.UnknownCallEvent:
		return map[string]any{"type": "call_unknown", "node": evt.Node}

	default:
		return map[string]any{"type": fmt.Sprintf("unknown:%T", raw)}
	}
}

func strPtr(j *types.JID) string {
	if j == nil {
		return ""
	}
	return j.String()
}

//export WmClientStartEvents
func WmClientStartEvents(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream := &eventStream{ch: make(chan map[string]any, 128), ctx: ctx, cancel: cancel, client: cli}
	stream.handlerID = cli.AddEventHandler(func(raw interface{}) {
		if raw == nil {
			return
		}
		payload := serializeEvent(raw)
		select {
		case stream.ch <- payload:
		default: /* drop if full */
		}
	})
	h := newHandle()
	eventsMu.Lock()
	eventsMap[h] = stream
	eventsMu.Unlock()
	return success(map[string]any{"handle": uint64(h)})
}

//export WmEventNext
func WmEventNext(input *C.char) *C.char {
	var payload struct {
		Handle    uint64 `json:"handle"`
		TimeoutMs int    `json:"timeoutMs"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	eventsMu.RLock()
	es := eventsMap[handle(payload.Handle)]
	eventsMu.RUnlock()
	if es == nil {
		return fail(errors.New("event handle not found"))
	}
	var timeout <-chan time.Time
	if payload.TimeoutMs > 0 {
		timeout = time.After(time.Duration(payload.TimeoutMs) * time.Millisecond)
	} else {
		timeout = make(<-chan time.Time)
	}
	select {
	case ev := <-es.ch:
		return success(ev)
	case <-timeout:
		return success(map[string]any{"type": "timeout"})
	case <-es.ctx.Done():
		return success(map[string]any{"type": "closed"})
	}
}

// registries
var (
	containersMu sync.RWMutex
	containers   = map[handle]*sqlstore.Container{}

	devicesMu sync.RWMutex
	devices   = map[handle]*store.Device{}

	clientsMu sync.RWMutex
	clients   = map[handle]*wa.Client{}

	qrsMu sync.RWMutex
	qrs   = map[handle]*qrState{}

	eventsMu  sync.RWMutex
	eventsMap = map[handle]*eventStream{}
)

type qrState struct {
	ch     <-chan wa.QRChannelItem
	cancel context.CancelFunc
}

type eventStream struct {
	ch        chan map[string]any
	ctx       context.Context
	cancel    context.CancelFunc
	client    *wa.Client
	handlerID uint32
}

type jsonResp struct {
	Ok    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}

func success(data interface{}) *C.char {
	b, _ := json.Marshal(jsonResp{Ok: true, Data: data})
	return C.CString(string(b))
}

func fail(err error) *C.char {
	msg := err.Error()
	b, _ := json.Marshal(jsonResp{Ok: false, Error: msg})
	return C.CString(string(b))
}

//export WmFreeCString
func WmFreeCString(ptr *C.char) {
	if ptr != nil {
		C.free(unsafe.Pointer(ptr))
	}
}

type openContainerReq struct {
	Dialect string `json:"dialect"`
	Address string `json:"address"`
}

type withHandle struct {
	Handle uint64 `json:"handle"`
}

//export WmOpenContainer
func WmOpenContainer(input *C.char) *C.char {
	var req openContainerReq
	if err := json.Unmarshal([]byte(C.GoString(input)), &req); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	if req.Dialect == "" || req.Address == "" {
		return fail(errors.New("dialect and address are required"))
	}
	ctx := context.Background()
	dbLog := newDBLogger()
	cont, err := sqlstore.New(ctx, req.Dialect, req.Address, dbLog)
	if err != nil {
		return fail(err)
	}
	h := newHandle()
	containersMu.Lock()
	containers[h] = cont
	containersMu.Unlock()
	return success(map[string]any{"handle": uint64(h)})
}

//export WmContainerGetFirstDevice
func WmContainerGetFirstDevice(input *C.char) *C.char {
	var req withHandle
	if err := json.Unmarshal([]byte(C.GoString(input)), &req); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	containersMu.RLock()
	cont := containers[handle(req.Handle)]
	containersMu.RUnlock()
	if cont == nil {
		return fail(errors.New("container handle not found"))
	}
	ctx := context.Background()
	dev, err := cont.GetFirstDevice(ctx)
	if err != nil {
		return fail(err)
	}
	h := newHandle()
	devicesMu.Lock()
	devices[h] = dev
	devicesMu.Unlock()
	return success(map[string]any{"handle": uint64(h)})
}

//export WmContainerGetAllDevices
func WmContainerGetAllDevices(input *C.char) *C.char {
	var req withHandle
	if err := json.Unmarshal([]byte(C.GoString(input)), &req); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	containersMu.RLock()
	cont := containers[handle(req.Handle)]
	containersMu.RUnlock()
	if cont == nil {
		return fail(errors.New("container handle not found"))
	}
	ctx := context.Background()
	devs, err := cont.GetAllDevices(ctx)
	if err != nil {
		return fail(err)
	}
	handles := make([]uint64, 0, len(devs))
	devicesMu.Lock()
	for _, d := range devs {
		h := newHandle()
		devices[h] = d
		handles = append(handles, uint64(h))
	}
	devicesMu.Unlock()
	return success(map[string]any{"handles": handles})
}

//export WmContainerGetDevice
func WmContainerGetDevice(input *C.char) *C.char {
	var req struct {
		Handle uint64 `json:"handle"`
		JID    string `json:"jid"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &req); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	containersMu.RLock()
	cont := containers[handle(req.Handle)]
	containersMu.RUnlock()
	if cont == nil {
		return fail(errors.New("container handle not found"))
	}
	jid, err := types.ParseJID(req.JID)
	if err != nil {
		return fail(err)
	}
	ctx := context.Background()
	dev, err := cont.GetDevice(ctx, jid)
	if err != nil {
		return fail(err)
	}
	if dev == nil {
		return success(map[string]any{"found": false})
	}
	h := newHandle()
	devicesMu.Lock()
	devices[h] = dev
	devicesMu.Unlock()
	return success(map[string]any{"handle": uint64(h), "found": true})
}

//export WmNewClient
func WmNewClient(input *C.char) *C.char {
	var payload struct {
		Device uint64 `json:"device"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	devicesMu.RLock()
	dev := devices[handle(payload.Device)]
	devicesMu.RUnlock()
	if dev == nil {
		return fail(errors.New("device handle not found"))
	}
	clientLog := newClientLogger()
	cli := wa.NewClient(dev, clientLog)
	h := newHandle()
	clientsMu.Lock()
	clients[h] = cli
	clientsMu.Unlock()
	return success(map[string]any{"handle": uint64(h)})
}

//export WmClientConnect
func WmClientConnect(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	if err := cli.Connect(); err != nil {
		return fail(err)
	}
	return success(map[string]any{})
}

//export WmClientGetQRChannel
func WmClientGetQRChannel(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	ch, err := cli.GetQRChannel(ctx)
	if err != nil {
		cancel()
		return fail(err)
	}
	state := &qrState{ch: ch, cancel: cancel}
	h := newHandle()
	qrsMu.Lock()
	qrs[h] = state
	qrsMu.Unlock()
	return success(map[string]any{"handle": uint64(h)})
}

//export WmQRNext
func WmQRNext(input *C.char) *C.char {
	var payload struct {
		Handle    uint64 `json:"handle"`
		TimeoutMs int    `json:"timeoutMs"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	qrsMu.RLock()
	q := qrs[handle(payload.Handle)]
	qrsMu.RUnlock()
	if q == nil {
		return fail(errors.New("qr handle not found"))
	}
	var timeout <-chan time.Time
	if payload.TimeoutMs > 0 {
		timeout = time.After(time.Duration(payload.TimeoutMs) * time.Millisecond)
	} else {
		timeout = make(<-chan time.Time)
	}
	select {
	case item, ok := <-q.ch:
		if !ok {
			return success(map[string]any{"event": "closed"})
		}
		out := map[string]any{"event": ""}
		switch item.Event {
		case wa.QRChannelEventCode:
			out["event"] = "code"
			out["code"] = item.Code
			out["timeoutMs"] = int(item.Timeout / time.Millisecond)
		case wa.QRChannelEventError:
			out["event"] = "error"
			if item.Error != nil {
				out["error"] = item.Error.Error()
			}
		case "success":
			out["event"] = "success"
		case "timeout":
			out["event"] = "timeout"
		default:
			out["event"] = fmt.Sprintf("%v", item.Event)
		}
		return success(out)
	case <-timeout:
		return success(map[string]any{"event": "timeout"})
	}
}

//export WmClientSendPresence
func WmClientSendPresence(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
		State  string `json:"state"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	if err := cli.SendPresence(types.Presence(payload.State)); err != nil {
		return fail(err)
	}
	return success(map[string]any{})
}

//export WmClientSubscribePresence
func WmClientSubscribePresence(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
		JID    string `json:"jid"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	jid, err := types.ParseJID(payload.JID)
	if err != nil {
		return fail(err)
	}
	if err := cli.SubscribePresence(jid); err != nil {
		return fail(err)
	}
	return success(map[string]any{})
}

//export WmClientSendChatPresence
func WmClientSendChatPresence(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
		JID    string `json:"jid"`
		State  string `json:"state"`
		Media  string `json:"media"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	jid, err := types.ParseJID(payload.JID)
	if err != nil {
		return fail(err)
	}
	if err := cli.SendChatPresence(jid, types.ChatPresence(payload.State), types.ChatPresenceMedia(payload.Media)); err != nil {
		return fail(err)
	}
	return success(map[string]any{})
}

// map simple names -> whatsmeow.MediaType
func mapMediaType(name string) (wa.MediaType, error) {
	switch name {
	case "image":
		return wa.MediaImage, nil
	case "video":
		return wa.MediaVideo, nil
	case "audio":
		return wa.MediaAudio, nil
	case "document":
		return wa.MediaDocument, nil
	case "history":
		return wa.MediaHistory, nil
	case "appstate":
		return wa.MediaAppState, nil
	case "sticker-pack":
		return wa.MediaStickerPack, nil
	case "thumbnail-link":
		return wa.MediaLinkThumbnail, nil
	default:
		return "", fmt.Errorf("unknown media type: %s", name)
	}
}

//export WmClientUpload
func WmClientUpload(input *C.char) *C.char {
	var payload struct {
		Client  uint64 `json:"client"`
		DataB64 string `json:"data"`
		Type    string `json:"type"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	data, err := base64.StdEncoding.DecodeString(payload.DataB64)
	if err != nil {
		return fail(fmt.Errorf("invalid base64: %w", err))
	}
	mt, err := mapMediaType(payload.Type)
	if err != nil {
		return fail(err)
	}
	resp, err := cli.Upload(context.Background(), data, mt)
	if err != nil {
		return fail(err)
	}
	out := map[string]any{
		"url":             resp.URL,
		"direct_path":     resp.DirectPath,
		"handle":          resp.Handle,
		"object_id":       resp.ObjectID,
		"media_key":       base64.StdEncoding.EncodeToString(resp.MediaKey),
		"file_enc_sha256": base64.StdEncoding.EncodeToString(resp.FileEncSHA256),
		"file_sha256":     base64.StdEncoding.EncodeToString(resp.FileSHA256),
		"file_length":     resp.FileLength,
	}
	return success(out)
}

//export WmClientDownloadByPath
func WmClientDownloadByPath(input *C.char) *C.char {
	var payload struct {
		Client     uint64 `json:"client"`
		DirectPath string `json:"direct_path"`
		EncSHA256  string `json:"enc_sha256"`
		SHA256     string `json:"sha256"`
		MediaKey   string `json:"media_key"`
		FileLength int    `json:"file_length"`
		Type       string `json:"type"`
		MMSType    string `json:"mms_type"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	encSHA, err := base64.StdEncoding.DecodeString(payload.EncSHA256)
	if err != nil {
		return fail(err)
	}
	sha, err := base64.StdEncoding.DecodeString(payload.SHA256)
	if err != nil {
		return fail(err)
	}
	mediaKey, err := base64.StdEncoding.DecodeString(payload.MediaKey)
	if err != nil {
		return fail(err)
	}
	mt, err := mapMediaType(payload.Type)
	if err != nil {
		return fail(err)
	}
	data, err := cli.DownloadMediaWithPath(context.Background(), payload.DirectPath, encSHA, sha, mediaKey, payload.FileLength, mt, payload.MMSType)
	if err != nil {
		return fail(err)
	}
	return success(map[string]any{"data": base64.StdEncoding.EncodeToString(data)})
}

//export WmClientGetGroupInviteLink
func WmClientGetGroupInviteLink(input *C.char) *C.char {
	var payload struct {
		Client uint64 `json:"client"`
		JID    string `json:"jid"`
		Reset  bool   `json:"reset"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}
	jid, err := types.ParseJID(payload.JID)
	if err != nil {
		return fail(err)
	}
	link, err := cli.GetGroupInviteLink(jid, payload.Reset)
	if err != nil {
		return fail(err)
	}
	return success(map[string]any{"link": link})
}

//export WmClientCall
func WmClientCall(input *C.char) *C.char {
	// Dispatcher genérico por reflexão
	var payload struct {
		Client uint64          `json:"client"`
		Method string          `json:"method"`
		Args   json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal([]byte(C.GoString(input)), &payload); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	clientsMu.RLock()
	cli := clients[handle(payload.Client)]
	clientsMu.RUnlock()
	if cli == nil {
		return fail(errors.New("client handle not found"))
	}

	rv := reflect.ValueOf(cli)
	meth := rv.MethodByName(payload.Method)
	if !meth.IsValid() {
		return fail(fmt.Errorf("method not found: %s", payload.Method))
	}
	mt := meth.Type()

	// Parse args as array of raw messages
	var rawArgs []json.RawMessage
	if len(payload.Args) > 0 && string(payload.Args) != "null" && string(payload.Args) != "{}" {
		if payload.Args[0] == '[' { // fast check
			if err := json.Unmarshal(payload.Args, &rawArgs); err != nil {
				return fail(fmt.Errorf("args must be array: %w", err))
			}
		} else {
			// allow single arg object for single non-context parameter
			rawArgs = []json.RawMessage{payload.Args}
		}
	}

	// Build call parameters
	args := make([]reflect.Value, 0, mt.NumIn())
	ai := 0
	for i := 0; i < mt.NumIn(); i++ {
		pt := mt.In(i)
		// Auto-inject context.Context
		if pt.Kind() == reflect.Interface && pt.Implements(reflect.TypeOf((*context.Context)(nil)).Elem()) {
			args = append(args, reflect.ValueOf(context.Background()))
			continue
		}
		// Handle variadic last parameter: allow missing -> empty slice
		if mt.IsVariadic() && i == mt.NumIn()-1 {
			if ai >= len(rawArgs) {
				args = append(args, reflect.MakeSlice(pt, 0, 0))
				continue
			}
			// If provided as array in JSON, use it directly
			if rawArgs[ai][0] == '[' {
				sliceVal, err := convertArg(rawArgs[ai], pt)
				if err != nil {
					return fail(fmt.Errorf("arg %d: %w", i, err))
				}
				args = append(args, sliceVal)
				ai++
				continue
			} else {
				// Wrap single object into array for variadic parameter
				wrapped, _ := json.Marshal([]json.RawMessage{rawArgs[ai]})
				sliceVal, err := convertArg(json.RawMessage(wrapped), pt)
				if err != nil {
					return fail(fmt.Errorf("arg %d: %w", i, err))
				}
				args = append(args, sliceVal)
				ai++
				continue
			}
		}
		if ai >= len(rawArgs) {
			return fail(fmt.Errorf("missing argument %d for %s", i, payload.Method))
		}
		v, err := convertArg(rawArgs[ai], pt)
		if err != nil {
			return fail(fmt.Errorf("arg %d: %w", i, err))
		}
		args = append(args, v)
		ai++
	}

	// Call (use CallSlice for variadic methods)
	var out []reflect.Value
	if mt.IsVariadic() {
		out = meth.CallSlice(args)
	} else {
		out = meth.Call(args)
	}
	// Handle error as last return
	if len(out) > 0 {
		if errv, ok := out[len(out)-1].Interface().(error); ok {
			if errv != nil {
				return fail(errv)
			}
			out = out[:len(out)-1]
		}
	}
	if len(out) == 0 {
		return success(map[string]any{})
	}
	if len(out) == 1 {
		enc, err := encodeReturn(out[0])
		if err != nil {
			return fail(err)
		}
		return success(enc)
	}
	// multiple returns
	arr := make([]any, 0, len(out))
	for _, v := range out {
		enc, err := encodeReturn(v)
		if err != nil {
			return fail(err)
		}
		arr = append(arr, enc)
	}
	return success(arr)
}

var (
	typeOfContext  = reflect.TypeOf((*context.Context)(nil)).Elem()
	typeOfProtoMsg = reflect.TypeOf((*proto.Message)(nil)).Elem()
	typeOfDuration = reflect.TypeOf(time.Duration(0))
	typeOfJID      = reflect.TypeOf(types.JID{})
)

func convertArg(raw json.RawMessage, t reflect.Type) (reflect.Value, error) {
	// context handled by caller
	if t == typeOfDuration {
		var ms int64
		if err := json.Unmarshal(raw, &ms); err != nil {
			return reflect.Value{}, err
		}
		d := time.Duration(ms) * time.Millisecond
		return reflect.ValueOf(d), nil
	}
	if t == typeOfJID {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return reflect.Value{}, err
		}
		jid, err := types.ParseJID(s)
		if err != nil {
			return reflect.Value{}, err
		}
		return reflect.ValueOf(jid), nil
	}
	// proto message pointer
	if t.Kind() == reflect.Pointer && t.Implements(typeOfProtoMsg) {
		pv := reflect.New(t.Elem())
		// use protojson to unmarshal
		if len(raw) == 0 || string(raw) == "null" {
			return pv, nil
		}
		if err := protojson.Unmarshal(raw, pv.Interface().(proto.Message)); err != nil {
			return reflect.Value{}, err
		}
		return pv, nil
	}
	// regular pointer to struct: json.Unmarshal into it
	if t.Kind() == reflect.Pointer && t.Elem().Kind() == reflect.Struct {
		pv := reflect.New(t.Elem())
		if err := json.Unmarshal(raw, pv.Interface()); err != nil {
			return reflect.Value{}, err
		}
		return pv, nil
	}
	// struct by value
	if t.Kind() == reflect.Struct {
		pv := reflect.New(t)
		if err := json.Unmarshal(raw, pv.Interface()); err != nil {
			return reflect.Value{}, err
		}
		return pv.Elem(), nil
	}
	// basic kinds and slices
	pv := reflect.New(t)
	if err := json.Unmarshal(raw, pv.Interface()); err != nil {
		return reflect.Value{}, err
	}
	return pv.Elem(), nil
}

func encodeReturn(v reflect.Value) (any, error) {
	if !v.IsValid() {
		return nil, nil
	}
	if v.Kind() == reflect.Interface && !v.IsNil() {
		v = v.Elem()
	}
	if v.Type().Kind() == reflect.Pointer && v.IsNil() {
		return nil, nil
	}
	// Special handling for whatsmeow.SendResponse to format durations nicely
	if v.Type().PkgPath() == "go.mau.fi/whatsmeow" && v.Type().Name() == "SendResponse" {
		// struct by value
		ts := v.FieldByName("Timestamp").Interface().(time.Time)
		id := v.FieldByName("ID").Interface().(types.MessageID)
		srvID := v.FieldByName("ServerID").Interface().(types.MessageServerID)
		sender := v.FieldByName("Sender").Interface().(types.JID)
		dbg := v.FieldByName("DebugTimings")
		out := map[string]any{
			"timestamp": ts.Format(time.RFC3339),
			"id":        string(id),
			"serverId":  int(srvID),
			"sender":    sender.String(),
		}
		if dbg.IsValid() {
			dm := map[string]any{}
			setMs := func(name string) {
				d := dbg.FieldByName(name)
				if d.IsValid() {
					ms := d.Interface().(time.Duration).Milliseconds()
					if ms != 0 {
						dm[name[:1]+strings.ToLower(name[1:])+"Ms"] = ms
					}
				}
			}
			setMs("Queue")
			setMs("Marshal")
			setMs("GetParticipants")
			setMs("GetDevices")
			setMs("GroupEncrypt")
			setMs("PeerEncrypt")
			setMs("Send")
			setMs("Resp")
			setMs("Retry")
			if len(dm) > 0 {
				out["debug"] = dm
			}
		}
		return out, nil
	}
	if v.Type().Kind() == reflect.Pointer && v.Type().Implements(typeOfProtoMsg) {
		b, err := protojson.Marshal(v.Interface().(proto.Message))
		if err != nil {
			return nil, err
		}
		return json.RawMessage(b), nil
	}
	if v.Type().Implements(typeOfProtoMsg) {
		b, err := protojson.Marshal(v.Interface().(proto.Message))
		if err != nil {
			return nil, err
		}
		return json.RawMessage(b), nil
	}
	// []byte -> base64
	if v.Kind() == reflect.Slice && v.Type().Elem().Kind() == reflect.Uint8 {
		if v.IsNil() {
			return "", nil
		}
		return base64.StdEncoding.EncodeToString(v.Bytes()), nil
	}
	// time.Time -> RFC3339
	if v.Type() == reflect.TypeOf(time.Time{}) {
		return v.Interface().(time.Time).Format(time.RFC3339), nil
	}
	// types.JID -> string (and pointer)
	if v.Type() == typeOfJID {
		return v.Interface().(types.JID).String(), nil
	}
	if v.Kind() == reflect.Pointer && v.Elem().Type() == typeOfJID {
		if v.IsNil() {
			return "", nil
		}
		return v.Elem().Interface().(types.JID).String(), nil
	}
	// []proto.Message -> []json.RawMessage
	if v.Kind() == reflect.Slice && v.Type().Elem().Kind() == reflect.Pointer && v.Type().Elem().Implements(typeOfProtoMsg) {
		n := v.Len()
		out := make([]any, n)
		for i := 0; i < n; i++ {
			item := v.Index(i)
			b, err := protojson.Marshal(item.Interface().(proto.Message))
			if err != nil {
				return nil, err
			}
			out[i] = json.RawMessage(b)
		}
		return out, nil
	}
	// []types.JID -> []string
	if v.Kind() == reflect.Slice && v.Type().Elem() == typeOfJID {
		n := v.Len()
		out := make([]string, n)
		for i := 0; i < n; i++ {
			out[i] = v.Index(i).Interface().(types.JID).String()
		}
		return out, nil
	}
	return v.Interface(), nil
}

//export WmRelease
func WmRelease(input *C.char) *C.char {
	var req withHandle
	if err := json.Unmarshal([]byte(C.GoString(input)), &req); err != nil {
		return fail(fmt.Errorf("invalid json: %w", err))
	}
	h := handle(req.Handle)
	eventsMu.Lock()
	if es, ok := eventsMap[h]; ok {
		if es.client != nil && es.handlerID != 0 {
			go es.client.RemoveEventHandler(es.handlerID)
		}
		es.cancel()
		delete(eventsMap, h)
		eventsMu.Unlock()
		return success(map[string]any{})
	}
	eventsMu.Unlock()
	qrsMu.Lock()
	if st, ok := qrs[h]; ok {
		st.cancel()
		delete(qrs, h)
		qrsMu.Unlock()
		return success(map[string]any{})
	}
	qrsMu.Unlock()
	clientsMu.Lock()
	if cl, ok := clients[h]; ok {
		cl.Disconnect()
		delete(clients, h)
		clientsMu.Unlock()
		return success(map[string]any{})
	}
	clientsMu.Unlock()
	devicesMu.Lock()
	if _, ok := devices[h]; ok {
		delete(devices, h)
		devicesMu.Unlock()
		return success(map[string]any{})
	}
	devicesMu.Unlock()
	containersMu.Lock()
	if c, ok := containers[h]; ok {
		_ = c.Close()
		delete(containers, h)
		containersMu.Unlock()
		return success(map[string]any{})
	}
	containersMu.Unlock()
	return fail(errors.New("handle not found"))
}

func main() {}
