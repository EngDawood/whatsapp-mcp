/**
 * Baileys messages to plain message events. Everything about WhatsApp's wire format lives here: content types,
 * captions, media download details, quoted replies, reactions carried two different ways, edits and deletes.
 *
 * Pure: no storage, no keys. The one thing it needs from outside is how to normalise a jid (a "lid" becomes the
 * phone-number jid when that mapping is known), which the store passes in.
 */
import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';
/**
 * What it takes to fetch a message's file later: where it is on WhatsApp's CDN and the key it is encrypted with,
 * plus the message key, which asking the phone to upload it again needs once the CDN copy has expired. Kept inside
 * the sealed message blob like everything else. The file itself is never stored.
 */
export interface MediaRef {
  k: MediaKind; key: string; path?: string; url?: string; mime?: string; len?: number; name?: string;
  rk: { remoteJid: string; fromMe: boolean; participant?: string };
}
/** The message a reply quotes: its id and a short snippet of what it said. */
export interface Quote { id: string; b: string }

/** A new message (or a repeat delivery of one already stored). `senderJid` is null for my own messages. */
export interface MessageEvent {
  kind: 'message'; chat: string; id: string; ts: number; fromMe: boolean; senderJid: string | null; push?: string;
  type: string; body: string; media?: MediaRef; quote?: Quote;
}
/** A reaction to `target`. An empty emoji takes it back. */
export interface ReactEvent { kind: 'react'; chat: string; target: string; fromMe: boolean; senderJid: string | null; emoji: string; ts: number; push?: string; history?: boolean }
export interface EditEvent { kind: 'edit'; chat: string; id: string; body: string }
export interface DeleteEvent { kind: 'delete'; chat: string; id: string }
export type WaEvent = MessageEvent | ReactEvent | EditEvent | DeleteEvent;

/** jid (and the alternative WhatsApp sometimes sends alongside it) to the jid we store under. */
export type Normalise = (jid?: string | null, alt?: string | null) => string | null;

export const num = (v: unknown) => Number((v as { toNumber?: () => number })?.toNumber?.() ?? v ?? 0);

/** What one Baileys message means. Status updates and plumbing (key distribution and the like) mean nothing. */
export function translate(msg: proto.IWebMessageInfo, norm: Normalise): WaEvent[] {
  const key = msg.key;
  if (!key?.id || !key.remoteJid || key.remoteJid === 'status@broadcast') return [];
  const chat = norm(key.remoteJid, (key as any).remoteJidAlt);
  if (!chat) return [];
  const isGroup = chat.endsWith('@g.us');
  const who = (k: proto.IMessageKey | null | undefined, participant?: string | null) =>
    k?.fromMe ? null : isGroup ? norm(k?.participant ?? participant, (k as any)?.participantAlt) : chat;
  const out: WaEvent[] = [];

  // history sync can carry reactions on the message itself
  for (const x of msg.reactions ?? []) {
    out.push({ kind: 'react', chat, target: key.id, fromMe: !!x.key?.fromMe, senderJid: who(x.key), emoji: x.text ?? '', ts: Math.floor(num(x.senderTimestampMs) / 1000) || num(msg.messageTimestamp), history: true });
  }
  const rm = normalizeMessageContent(msg.message)?.reactionMessage;
  if (rm?.key?.id) {
    out.push({ kind: 'react', chat, target: rm.key.id, fromMe: !!key.fromMe, senderJid: who(key, msg.participant), emoji: rm.text ?? '', ts: Math.floor(num(rm.senderTimestampMs) / 1000) || num(msg.messageTimestamp), ...(msg.pushName ? { push: msg.pushName } : {}) });
    return out;
  }
  const pm = msg.message?.protocolMessage;
  if (pm?.key?.id) {
    if (pm.editedMessage) {
      const body = pm.editedMessage.conversation ?? pm.editedMessage.extendedTextMessage?.text;
      if (body) out.push({ kind: 'edit', chat, id: pm.key.id, body });
    } else if (pm.type === 0) {
      out.push({ kind: 'delete', chat, id: pm.key.id });
    }
    return out;
  }
  const d = describe(msg);
  if (!d) return out;
  const ev: MessageEvent = {
    kind: 'message', chat, id: key.id, ts: num(msg.messageTimestamp), fromMe: !!key.fromMe,
    senderJid: key.fromMe ? null : isGroup ? norm(key.participant ?? msg.participant, (key as any).participantAlt) : chat,
    type: d.type, body: d.body,
  };
  if (msg.pushName) ev.push = msg.pushName;
  if (d.media) ev.media = { ...d.media, rk: { remoteJid: key.remoteJid, fromMe: !!key.fromMe, ...(key.participant ? { participant: key.participant } : {}) } };
  const q = quoteOf(msg);
  if (q) ev.quote = q;
  out.push(ev);
  return out;
}

type MediaContent = { mediaKey?: Uint8Array | string | null; directPath?: string | null; url?: string | null; mimetype?: string | null; fileLength?: unknown; fileName?: string | null };
/** The download details of a media message, or nothing if WhatsApp didn't send enough to fetch it. */
function mediaOf(k: MediaKind, c?: MediaContent | null): Omit<MediaRef, 'rk'> | undefined {
  const key = typeof c?.mediaKey === 'string' ? c.mediaKey : c?.mediaKey?.length ? Buffer.from(c.mediaKey).toString('base64') : undefined;
  if (!c || !key || !(c.directPath || c.url)) return undefined;
  const ref: Omit<MediaRef, 'rk'> = { k, key };
  if (c.directPath) ref.path = c.directPath;
  if (c.url) ref.url = c.url;
  if (c.mimetype) ref.mime = c.mimetype;
  if (num(c.fileLength)) ref.len = num(c.fileLength);
  if (c.fileName) ref.name = c.fileName;
  return ref;
}

/** What a message says, in text. Media becomes a short label so search and reading still make sense. */
export function describe(msg: proto.IWebMessageInfo): { type: string; body: string; media?: Omit<MediaRef, 'rk'> } | null {
  const m = normalizeMessageContent(msg.message);
  if (!m) return null;
  const type = getContentType(m);
  if (!type) return null;
  const cap = (s?: string | null) => (s ? ` ${s}` : '');
  switch (type) {
    case 'conversation':
      return { type: 'text', body: m.conversation ?? '' };
    case 'extendedTextMessage':
      return { type: 'text', body: m.extendedTextMessage?.text ?? '' };
    case 'imageMessage':
      return { type: 'image', body: `[image]${cap(m.imageMessage?.caption)}`, media: mediaOf('image', m.imageMessage) };
    case 'videoMessage':
      return { type: 'video', body: `[video]${cap(m.videoMessage?.caption)}`, media: mediaOf('video', m.videoMessage) };
    case 'audioMessage': {
      const s = num(m.audioMessage?.seconds);
      return { type: 'audio', body: `[${m.audioMessage?.ptt ? 'voice note' : 'audio'}${s ? ` ${s}s` : ''}]`, media: mediaOf('audio', m.audioMessage) };
    }
    case 'documentMessage':
      return { type: 'document', body: `[document: ${m.documentMessage?.fileName ?? 'file'}]${cap(m.documentMessage?.caption)}`, media: mediaOf('document', m.documentMessage) };
    case 'documentWithCaptionMessage':
      return { type: 'document', body: `[document]` };
    case 'stickerMessage':
      return { type: 'sticker', body: '[sticker]', media: mediaOf('sticker', m.stickerMessage) };
    case 'locationMessage':
    case 'liveLocationMessage':
      return { type: 'location', body: `[location${m.locationMessage?.name ? `: ${m.locationMessage.name}` : ''}]` };
    case 'contactMessage':
      return { type: 'contact', body: `[contact: ${m.contactMessage?.displayName ?? ''}]` };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { type: 'poll', body: `[poll: ${(m as any)[type]?.name ?? ''}]` };
    default:
      return null; // reactions, protocol, key distribution and other plumbing
  }
}

/** If this message replies to another, which one and what it said (shortened). */
export function quoteOf(msg: proto.IWebMessageInfo): Quote | undefined {
  const m = normalizeMessageContent(msg.message);
  const type = m && getContentType(m);
  const ci = type ? (m as any)[type]?.contextInfo : undefined;
  if (!ci?.stanzaId) return undefined;
  const said = ci.quotedMessage ? describe({ key: {}, message: ci.quotedMessage } as proto.IWebMessageInfo)?.body : undefined;
  const flat = (said ?? '').replace(/\s+/g, ' ').trim();
  return { id: ci.stanzaId, b: flat.length > 120 ? flat.slice(0, 120).trimEnd() + '…' : flat };
}
