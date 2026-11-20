/**
 * The History reader: the read rules every front end shares. The MCP tools and the web chat viewer are thin adapters
 * over it; they decide how to show results, never which chat a name means, when to pull, how far back to look, or
 * how to page.
 *
 * It reads through two small interfaces: the store's queries (Records) and the live account (Live: is a phone linked,
 * pull if stale). In production both are RPC stubs into the Durable Object; in tests, a real Store on node:sqlite and
 * a stub Live.
 */
import type { Store } from '../store/store.js';
import { toJid } from '../whatsapp/phone.js';

/** A method that may answer now or later: the same Store method in-process, or through an RPC stub. */
type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => R | Promise<Awaited<R>> : never };

/** The store queries the reader needs. */
export type Records = Async<Pick<Store,
  'listChats' | 'chatList' | 'resolveChat' | 'chatName' | 'getMessages' | 'context' | 'search' | 'unanswered' | 'activity' |
  'digest' | 'notes' | 'unnamedChats' | 'counts'
>>;
/** The live side: whether a phone is linked, and pulling new messages from WhatsApp. */
export interface Live {
  isPaired(): boolean | Promise<boolean>;
  pullIfStale(maxAgeMs: number): unknown;
  lastPull(): number | Promise<number>;
}

/** How long stored messages count as fresh before a read pulls from WhatsApp first. */
export const FRESH = { read: 10 * 60_000, button: 60_000 } as const;
/** Default look-back windows, in days. */
export const WINDOW = { unanswered: 14, activity: 7 } as const;

const DAY = 86_400;

// ---------- time and paging ----------

/** A point in a chat to page from: a time, and optionally the id of the message at that time (exact paging). */
export interface Point { ts: number; id?: string }

/**
 * A time as people and pages write it: an ISO date or date-time, epoch seconds, or a cursor from a previous page
 * ("2026-11-20T14:03:00.000Z#ABCD"), which pages exactly even when several messages share a second.
 */
export function parsePoint(s: string | number | undefined | null): Point | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  if (typeof s === 'number') return { ts: Math.floor(s) };
  const t = s.trim(), hash = t.indexOf('#');
  const time = hash < 0 ? t : t.slice(0, hash), id = hash < 0 ? '' : t.slice(hash + 1);
  const ts = /^\d{9,11}$/.test(time) ? Number(time) : Math.floor(Date.parse(time) / 1000);
  if (Number.isNaN(ts)) throw new Error(`Cannot parse date "${s}" - use ISO format like 2026-03-01`);
  return id ? { ts, id } : { ts };
}
export const parseTime = (s: string | number | undefined | null) => parsePoint(s)?.ts;

/** The cursor for a message: where the next page starts. */
export const cursorOf = (m: { ts: number; id: string }) => `${new Date(m.ts * 1000).toISOString()}#${m.id}`;

// ---------- chats ----------

export type Resolution =
  | { ok: true; jid: string; name: string }
  | { ok: false; reason: 'none' | 'ambiguous'; ref: string; matches: { jid: string; name: string }[] };

export class History {
  constructor(
    readonly store: Records,
    private live: Live,
    readonly tz: string,
    private opts: { countryCode?: string; now?: () => number } = {},
  ) {}

  private now() { return Math.floor((this.opts.now?.() ?? Date.now()) / 1000); }

  /**
   * Pull from WhatsApp first if the stored copy is older than maxAgeMs. Never throws: a failed pull still lets the
   * caller read what is stored, and says why in `error`.
   */
  async refresh(maxAgeMs: number = FRESH.read): Promise<{ linked: boolean; added: number; error?: string }> {
    try {
      if (!(await this.live.isPaired())) return { linked: false, added: 0 };
      const r = (await this.live.pullIfStale(maxAgeMs)) as { added?: number } | null;
      return { linked: true, added: r?.added ?? 0 };
    } catch (e: any) {
      return { linked: true, added: 0, error: e?.message ?? 'unknown error' };
    }
  }
  lastPull() { return this.live.lastPull(); }
  isPaired() { return this.live.isPaired(); }

  /**
   * Which chat a reference means. A jid is taken as given. A name or number fragment must match one chat, or match one
   * chat's name exactly; otherwise the caller gets the candidates to choose from. With `phone`, a phone number that
   * has no chat yet still resolves (notes can be about someone who hasn't written).
   */
  async resolve(ref: string, o: { phone?: boolean } = {}): Promise<Resolution> {
    const r = ref.trim();
    if (r.includes('@')) return { ok: true, jid: r, name: await this.store.chatName(r) };
    const matches = await this.store.resolveChat(r);
    if (matches.length === 1) return { ok: true, ...matches[0] };
    const exact = matches.filter((m) => m.name.toLowerCase() === r.toLowerCase());
    if (exact.length === 1) return { ok: true, ...exact[0] };
    if (!matches.length && o.phone && /^[+\d][\d\s()-]{5,}$/.test(r)) {
      const jid = toJid(r, this.opts.countryCode);
      if (jid) return { ok: true, jid, name: await this.store.chatName(jid) };
    }
    return { ok: false, reason: matches.length ? 'ambiguous' : 'none', ref: r, matches };
  }

  /** A chat's name for a jid already in hand. */
  name(jid: string) { return this.store.chatName(jid); }

  // ---------- reading ----------

  /**
   * Messages of one chat, oldest first: the latest `limit`, or the page before / after a point. Says whether there
   * is more, with the cursor to get it.
   */
  async messages(jid: string, o: { limit: number; before?: string | number; after?: string | number }) {
    const before = parsePoint(o.before), after = parsePoint(o.after);
    const forward = Boolean(after && !before);
    const rows = await this.store.getMessages({ chat: jid, limit: o.limit + 1, before: before?.ts, beforeId: before?.id, after: after?.ts });
    const more = rows.length > o.limit;
    const messages = more ? (forward ? rows.slice(0, o.limit) : rows.slice(1)) : rows;
    return {
      messages,
      older: !forward && more && messages.length ? cursorOf(messages[0]) : undefined,
      newer: forward && more && messages.length ? cursorOf(messages[messages.length - 1]) : undefined,
    };
  }

  context(jid: string, id: string, before: number, after: number) { return this.store.context(jid, id, before, after); }

  /** Several searches in one pass. `more[i]` says query i hit its limit, so there may be older matches. */
  async search(queries: string[], o: { chat?: string; since?: string | number; until?: string | number; limit: number }) {
    const { hits } = await this.store.search({ queries, chat: o.chat, since: parseTime(o.since), until: parseTime(o.until), limit: o.limit });
    return { hits, more: hits.map((h) => h.length >= o.limit) };
  }

  /** Direct chats waiting on the owner's reply. Default window: the last WINDOW.unanswered days. */
  async unanswered(o: { since?: string | number; limit: number }) {
    const since = parseTime(o.since) ?? this.now() - WINDOW.unanswered * DAY;
    return { since, rows: await this.store.unanswered({ since, limit: o.limit }) };
  }

  /** Who talked how much. Default window: the last WINDOW.activity days up to now. */
  async activity(o: { since?: string | number; until?: string | number; chat?: string; limit: number }) {
    const until = parseTime(o.until) ?? this.now();
    const since = parseTime(o.since) ?? until - WINDOW.activity * DAY;
    return { since, until, ...(await this.store.activity({ since, until, chat: o.chat, limit: o.limit })) };
  }

  chats(query: string | undefined, limit: number) { return this.store.listChats(query, limit); }
  /** The chat list with each chat's latest message, for a screen that shows chats the way WhatsApp does. */
  chatList(query: string | undefined, limit: number) { return this.store.chatList(query, limit); }
  notes(o: Parameters<Store['notes']>[0]) { return this.store.notes(o); }
}
