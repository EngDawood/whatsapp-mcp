/**
 * An open account: everything that needs the owner's key. The message store, the WhatsApp session (pulls and
 * pairing), media and transcripts. Only WhatsAppStore.open(key) makes one, so nothing keyed can run on a locked
 * account.
 *
 * Pull model: nothing stays connected. pull() opens a Baileys socket, lets WhatsApp deliver whatever it queued for
 * this linked device since we last connected, writes it to SQLite, and hangs up. Pairing is the same session with the
 * QR exposed and a longer leash, so the first full history sync lands.
 *
 * The Worker reaches it as an RPC stub (it is an RpcTarget), and reaches the store through history().
 */
import { RpcTarget } from 'cloudflare:workers';
import { liveIntervals } from '../platform/polyfills.js';
import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-generator';
import type { sqliteAuthState } from './auth-state.js';
import { initSchema, type Store } from '../store/store.js';
import type { MediaKind, MediaRef } from './translate.js';
import { downloadMedia } from './media.js';
import { MAX_AUDIO_BYTES, transcribe } from './transcribe.js';
import { limitsOf, verdict } from '../account/limits.js';
import { contactText, xHandle } from '../web/ui.js';
import type { Env } from '../index.js';

type Phase = 'idle' | 'connecting' | 'qr' | 'syncing';
export interface SessionResult { reason: string; added: number; ms: number }

const PAIR_MAX_MS = 10 * 60_000;
const PAIR_ABANDON_MS = 3 * 60_000;
const PULL_MAX_MS = 60_000;
const REUPLOAD_WAIT_MS = 30_000;
/** Largest file get_media hands back. Bigger ones would swamp an agent's context anyway. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const show = (x: unknown): string =>
  x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v));

const silent = (sink?: (level: string, args: unknown[]) => void) => {
  const l: any = {
    level: 'warn',
    child: () => l,
    trace() {}, debug() {}, info() {},
    warn: (...a: unknown[]) => sink?.('warn', a),
    error: (...a: unknown[]) => sink?.('error', a),
  };
  return l;
};

/** What the Durable Object lends an open account: its storage, its config, the keyless flags and the event log. */
export interface Host {
  ctx: DurableObjectState;
  env: Env;
  meta(k: string): string | null;
  setMeta(k: string, v: string): void;
  note(msg: string): void;
  /** Drop this open account (after its data is erased). */
  forget(): void;
}

export class Account extends RpcTarget {
  private session: Promise<SessionResult> | null = null;
  private phase: Phase = 'idle';
  private qr: string | null = null;
  private pairingCode: string | null = null;
  private lastPoll = 0;
  private sessionAdded = 0;
  private historyProgress: number | null = null;

  constructor(private host: Host, private auth: ReturnType<typeof sqliteAuthState>, private store: Store) { super(); }

  /** The message store: chats, messages, search, names, notes. */
  history(): Store { return this.store; }

  isPaired(): boolean { return this.host.meta('paired') === '1'; }
  timezone(): string { return this.host.env.TIMEZONE || this.host.meta('tz') || 'UTC'; }
  /** Keeps the Durable Object alive while a session runs (see WhatsAppStore.alarm). */
  async idle() { await this.session?.catch(() => {}); }
  /** Session state for the operator's /debug view. No content. */
  sessionPhase(): Phase { return this.phase; }


  /** Everything the pairing page needs, and a heartbeat that keeps the pairing session alive. */
  pairStatus() {
    this.lastPoll = Date.now();
    let qrSvg: string | null = null;
    if (this.qr) {
      const q = qrcode(0, 'M');
      q.addData(this.qr);
      q.make();
      qrSvg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }
    return {
      paired: this.auth.isPaired(),
      phase: this.phase,
      running: Boolean(this.session),
      progress: this.historyProgress,
      unnamed: this.session ? 0 : this.store.unnamedCount(), // counting names is wasted work while history is still arriving
      qrSvg,
      pairingCode: this.pairingCode,
      ...this.standing(),
      ...this.store.counts(),
    };
  }

  /** Begin (or continue) a pairing session. Runs in the alarm so it outlives this request. */
  async startPairing() {
    this.lastPoll = Date.now();
    this.host.ctx.storage.sql.exec(`DELETE FROM meta WHERE k IN ('rejected', 'full')`);
    if (!this.session) {
      this.session = this.runSession({ pairing: true, maxMs: PAIR_MAX_MS, idleMs: 8_000 })
        .finally(() => { this.session = null; });
      await this.host.ctx.storage.setAlarm(Date.now() + 50);
    }
  }

  async requestPairingCode(phone: string) {
    await this.startPairing();
    const digits = phone.replace(/\D/g, '');
    for (let i = 0; i < 40 && !this.sock; i++) await new Promise((r) => setTimeout(r, 250));
    if (!this.sock) throw new Error('socket did not start');
    await new Promise((r) => setTimeout(r, 1500)); // the code request needs the noise handshake done
    this.pairingCode = await this.sock.requestPairingCode(digits);
    return this.pairingCode;
  }

  /** Unlink this device on WhatsApp's side (so it vanishes from the phone's list), then forget the session. Messages stay. */
  async logout() {
    if (this.auth.isPaired()) {
      try {
        await this.unlinkOnServer();
      } catch (e: any) {
        this.host.note(`server-side unlink failed: ${e?.message}; remove the device in WhatsApp > Linked Devices`);
      }
    }
    this.auth.clear();
    this.host.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'last_pull'`);
  }

  private async unlinkOnServer() {
    const sock = makeWASocket({ auth: this.auth.state, logger: silent(), markOnlineOnConnect: false, getMessage: async () => undefined });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out connecting')), 20_000);
        sock.ev.on('connection.update', (u) => {
          if (u.connection === 'open') { clearTimeout(t); resolve(); }
          if (u.connection === 'close') { clearTimeout(t); reject(new Error('closed before open')); }
        });
      });
      await sock.logout();
    } finally {
      try { sock.end(undefined); } catch {}
    }
  }

  /** Unlink from WhatsApp and erase everything this person has here: messages, names, keys, the account itself. */
  async destroy() {
    try { await this.logout(); } catch {}
    await this.host.ctx.storage.deleteAlarm();
    await this.host.ctx.storage.deleteAll();
    this.host.forget(); // a later sign-up on this login makes fresh tables in createAccount
  }

  linkInfo() {
    return { paired: this.auth.isPaired(), lastPull: this.lastPull(), unnamed: this.store.unnamedCount(), ...this.standing(), ...this.store.counts() };
  }

  lastPull(): number {
    return Number(this.store.getMeta('last_pull') ?? 0);
  }

  /** Where this account stands against the size limits, for the pages and the agent to explain. */
  private standing() {
    const lim = limitsOf(this.host.env);
    const rejected = this.host.meta('rejected');
    return {
      rejected: rejected ? (JSON.parse(rejected) as { messages: number; at: number }) : null,
      full: this.host.meta('full') === '1',
      limits: { messages: lim.messages, mb: Math.round(lim.bytes / 1024 / 1024) },
      contact: xHandle(this.host.env.CONTACT_X) ?? null,
    };
  }

  private size() {
    return { messages: this.store.counts().messages, bytes: this.host.ctx.storage.sql.databaseSize ?? 0 };
  }

  /** A history that is too big for this service: unlink the phone and delete what arrived. Runs after the session has ended. */
  private async reject(total: number) {
    this.host.setMeta('rejected', JSON.stringify({ messages: total, at: Date.now() }));
    await this.logout();
    // chat_stats and lid_senders go first, so deleting the messages doesn't run the stats triggers row by row
    this.host.ctx.storage.sql.exec(`DROP TRIGGER IF EXISTS chat_stats_ad`);
    for (const t of ['chat_stats', 'lid_senders', 'messages', 'chats', 'contacts', 'custom_names', 'alias', 'notes']) this.host.ctx.storage.sql.exec(`DELETE FROM ${t}`);
    initSchema(this.host.ctx.storage.sql); // puts the trigger back
    this.store.reset();
  }

  /** Pull anything new from WhatsApp. Safe to call concurrently; callers share one session. */
  async pull(): Promise<SessionResult> {
    if (!this.auth.isPaired()) throw new Error('not paired');
    if (this.host.meta('full') === '1') {
      // an account that was full may have room now, if the operator raised the limit or messages were removed
      if (verdict(this.size(), limitsOf(this.host.env), false)) {
        throw new Error(`This account has reached the size limit for this service, so new messages aren't being added.${contactText(this.host.env.CONTACT_X)}`);
      }
      this.host.ctx.storage.sql.exec(`DELETE FROM meta WHERE k = 'full'`);
    }
    if (!this.session) {
      this.session = this.runSession({ pairing: false, maxMs: PULL_MAX_MS, idleMs: 4_000 })
        .finally(() => { this.session = null; });
    }
    return this.session;
  }

  /** Pull if the store is older than maxAgeMs. Returns null if it was fresh enough. */
  async pullIfStale(maxAgeMs: number): Promise<SessionResult | null> {
    if (Date.now() - this.lastPull() < maxAgeMs) return null;
    return this.pull();
  }

  // ---------- media ----------

  /**
   * Download one message's file. WhatsApp keeps a file on its servers for a few weeks; after that the phone is
   * asked to upload it again, which needs the phone online and still holding it. The bytes are returned, never kept.
   */
  async fetchMedia(chat: string, id: string): Promise<
    { ok: true; kind: MediaKind; mime: string; name?: string; data: string; size: number; reuploaded: boolean } | { ok: false; error: string }
  > {
    const got = await this.mediaBytes(chat, id);
    if (!got.ok) return got;
    const { ref, bytes, reuploaded } = got;
    return {
      ok: true, kind: ref.k, mime: ref.mime ?? 'application/octet-stream', ...(ref.name ? { name: ref.name } : {}),
      data: Buffer.from(bytes).toString('base64'), size: bytes.length, reuploaded,
    };
  }

  private async mediaBytes(chat: string, id: string, maxBytes = MEDIA_MAX_BYTES): Promise<{ ok: true; ref: MediaRef; bytes: Uint8Array; reuploaded: boolean } | { ok: false; error: string }> {
    const m = this.store.media(chat, id);
    if (!m) return { ok: false, error: 'there is no message with that id in that chat' };
    const ref = m.ref;
    if (!ref) return { ok: false, error: 'that message has no file this server can fetch. Files from before this server kept download keys come back after a relink (stored messages are kept)' };
    let got = await downloadMedia(ref, maxBytes);
    if (got.ok) return { ok: true, ref, bytes: got.bytes, reuploaded: false };
    if (!got.expired) return { ok: false, error: got.error };
    const why = got.error;
    try {
      const loc = await this.reupload(id, ref);
      this.store.setMediaLocation(chat, id, loc);
      got = await downloadMedia({ ...ref, ...loc }, maxBytes);
    } catch (e: any) {
      this.host.note(`media re-upload: ${e?.message}`);
      return { ok: false, error: `${why}, and asking the phone to upload it again failed (${e?.message}). The phone has to be online and still have the file` };
    }
    return got.ok ? { ok: true, ref, bytes: got.bytes, reuploaded: true } : { ok: false, error: got.error };
  }

  /**
   * Voice notes to text, kept with each message so a note is transcribed once and search finds its words after.
   * One result per id, in order.
   */
  async transcribeAudio(chat: string, ids: string[]): Promise<{ id: string; ok: boolean; text: string }[]> {
    const ai = this.host.env.AI;
    if (!ai) return ids.map((id) => ({ id, ok: false, text: 'transcription is not set up on this server' }));
    const one = async (id: string): Promise<{ id: string; ok: boolean; text: string }> => {
      const m = this.store.media(chat, id);
      if (m?.transcript) return { id, ok: true, text: m.transcript };
      if (m?.ref && m.ref.k !== 'audio') return { id, ok: false, text: `that is ${m.ref.k === 'image' ? 'an' : 'a'} ${m.ref.k}, not a voice note` };
      const got = await this.mediaBytes(chat, id, MAX_AUDIO_BYTES);
      if (!got.ok) return { id, ok: false, text: got.error };
      try {
        const text = (await transcribe(ai, got.bytes, { mime: got.ref.mime, model: this.host.env.TRANSCRIBE_MODEL })) || '[no speech]';
        this.store.setTranscript(chat, id, text);
        return { id, ok: true, text };
      } catch (e: any) {
        this.host.note(`transcribe: ${e?.message}`.slice(0, 300));
        return { id, ok: false, text: `transcription failed (${e?.message ?? 'unknown error'})` };
      }
    };
    // a note takes a few seconds, so four at a time keeps a full batch inside an agent's patience
    const out: { id: string; ok: boolean; text: string }[] = new Array(ids.length);
    let next = 0;
    const worker = async () => { for (let i = next++; i < ids.length; i = next++) out[i] = await one(ids[i]); };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return out;
  }

  /** Ask the phone to put an expired file back on WhatsApp's servers. */
  private async reupload(id: string, ref: MediaRef): Promise<{ path?: string; url?: string }> {
    const field = `${ref.k}Message`;
    const content = { mediaKey: Buffer.from(ref.key, 'base64'), directPath: ref.path, url: ref.url, mimetype: ref.mime };
    const message = { key: { ...ref.rk, id }, message: { [field]: content } };
    return this.withSocket(async (sock) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the phone did not answer')), REUPLOAD_WAIT_MS); });
      try {
        const updated: any = await Promise.race([sock.updateMediaMessage(message as any), timeout]);
        const c = updated?.message?.[field] ?? content;
        return { path: c.directPath ?? undefined, url: c.url ?? undefined };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Run fn on an open socket, starting a pull if none is running, and keeping the session from ending meanwhile. */
  private async withSocket<T>(fn: (sock: WASocket) => Promise<T>): Promise<T> {
    if (!this.auth.isPaired()) throw new Error('WhatsApp is not linked');
    this.holds++;
    try {
      if (!this.session) void this.pull().catch(() => {});
      for (let i = 0; i < 80 && !(this.sock && this.phase === 'syncing'); i++) await new Promise((r) => setTimeout(r, 250));
      if (!this.sock || this.phase !== 'syncing') throw new Error('could not connect to WhatsApp');
      return await fn(this.sock);
    } finally {
      this.holds--;
    }
  }

  // ---------- the session ----------

  private sock: WASocket | null = null;
  /** Callers waiting on the open socket (a media re-upload). A session doesn't end for being idle while any wait. */
  private holds = 0;

  private runSession(opts: { pairing: boolean; maxMs: number; idleMs: number }): Promise<SessionResult> {
    const started = Date.now();
    const intervalsBefore = new Set(liveIntervals);
    this.sessionAdded = 0;
    this.historyProgress = null;
    this.phase = 'connecting';
    this.qr = null;
    this.pairingCode = null;

    return new Promise<SessionResult>((resolve) => {
      let done = false;
      let lastActivity = Date.now();
      let backlogDelivered = false;
      let restarts = 0;
      const touch = () => { lastActivity = Date.now(); };
      const baseCount = this.store.counts().messages;
      const limits = limitsOf(this.host.env);

      /** After each batch of messages: is the account too big? */
      const guard = async () => {
        if (done) return;
        const total = baseCount + this.sessionAdded;
        const v = verdict({ messages: total, bytes: this.host.ctx.storage.sql.databaseSize ?? 0 }, limits, opts.pairing);
        if (!v) return;
        this.host.note(`over the size limit (${total} messages): ${v}`);
        await finish(v === 'reject' ? 'rejected' : 'full');
        if (v === 'reject') await this.reject(total);
        else this.host.setMeta('full', '1');
      };

      const finish = async (reason: string) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        try { this.sock?.end(undefined); } catch {}
        this.sock = null;
        // stop the timers Baileys leaked, so the object can go idle and pick up new code
        for (const id of [...liveIntervals]) if (!intervalsBefore.has(id)) clearInterval(id);
        this.phase = 'idle';
        this.qr = null;
        this.pairingCode = null;
        if (this.auth.isPaired() && reason !== 'logged_out') this.store.setMeta('last_pull', String(Date.now()));
        this.host.note(`session end: ${reason}, +${this.sessionAdded} messages`);
        resolve({ reason, added: this.sessionAdded, ms: Date.now() - started });
      };

      const connect = () => {
        try { open(); } catch (e: any) { this.host.note(`connect error: ${e?.stack ?? e}`.slice(0, 600)); void finish('error'); }
      };
      const open = () => {
        const sock = makeWASocket({
          auth: this.auth.state,
          logger: silent((lvl, a) => this.host.note(`${lvl}: ${a.map(show).join(' ').slice(0, 300)}`)),
          syncFullHistory: true,
          markOnlineOnConnect: false, // stay invisible so the phone keeps notifying
          generateHighQualityLinkPreview: false,
          getMessage: async () => undefined,
        });
        this.sock = sock;

        sock.ev.process(async (ev) => {
          if (ev['messaging-history.set'] || ev['messages.upsert']) touch();
          try {
            if (ev['creds.update']) await this.auth.saveCreds();

            if (ev['connection.update']) {
              const u = ev['connection.update'];
              if (u.qr) { this.qr = u.qr; this.phase = 'qr'; this.host.note('qr'); }
              if (u.receivedPendingNotifications) { backlogDelivered = true; this.host.note('backlog delivered'); }
              if (u.connection === 'open') {
                this.qr = null;
                this.phase = 'syncing';
                this.host.note('open');
                // group names only come from an explicit fetch
                sock.groupFetchAllParticipating()
                  .then((g) => this.store.upsertChatNames(Object.values(g)))
                  .catch((e) => this.host.note(`groups: ${e?.message}`));
              }
              if (u.connection === 'close') {
                const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
                this.host.note(`close ${code}`);
                if (code === DisconnectReason.loggedOut) {
                  this.auth.clear();
                  await finish('logged_out');
                } else if (code === DisconnectReason.connectionReplaced) {
                  await finish('replaced');
                } else if (!done && restarts++ < 8) {
                  // 515 restartRequired follows every successful pairing; reconnect with the new creds
                  this.sock = null;
                  connect();
                } else {
                  await finish(`closed_${code}`);
                }
              }
            }

            if (ev['messaging-history.set']) {
              const h = ev['messaging-history.set'];
              for (const m of h.lidPnMappings ?? []) this.store.addAlias(m.lid, m.pn);
              this.store.upsertContacts(h.contacts ?? []);
              this.store.upsertChatNames(h.chats ?? []);
              this.sessionAdded += this.store.ingestMessages(h.messages ?? []);
              if (typeof h.progress === 'number') this.historyProgress = h.progress;
              this.host.note(`history chunk: ${h.messages?.length ?? 0} msgs, progress ${h.progress ?? '-'}`);
            }
            if (ev['messages.upsert']) this.sessionAdded += this.store.ingestMessages(ev['messages.upsert'].messages);
            if (ev['messaging-history.set'] || ev['messages.upsert']) await guard();
            if (ev['lid-mapping.update']) this.store.addAlias(ev['lid-mapping.update'].lid, ev['lid-mapping.update'].pn);
            if (ev['contacts.upsert']) this.store.upsertContacts(ev['contacts.upsert']);
            if (ev['contacts.update']) this.store.upsertContacts(ev['contacts.update'] as any);
            if (ev['chats.upsert']) this.store.upsertChatNames(ev['chats.upsert']);
            if (ev['chats.update']) this.store.upsertChatNames(ev['chats.update'] as any);
            if (ev['groups.upsert']) this.store.upsertChatNames(ev['groups.upsert']);
            if (ev['groups.update']) this.store.upsertChatNames(ev['groups.update'] as any);
          } catch (e: any) {
            this.host.note(`handler error: ${e?.message}`);
          }
        });
      };

      const timer = setInterval(() => {
        const now = Date.now();
        if (now - started > opts.maxMs) return void finish('max_time');
        const paired = this.auth.isPaired();
        if (opts.pairing && !paired && now - this.lastPoll > PAIR_ABANDON_MS) return void finish('abandoned');
        if (!paired) return; // waiting on a scan
        if (this.holds) return;
        // a first link waits for WhatsApp's own "100%"; a plain pull just waits for quiet
        const historyDone = !opts.pairing || this.historyProgress === 100;
        if (backlogDelivered && historyDone && now - lastActivity > opts.idleMs) void finish('idle');
      }, 1000);

      connect();
    });
  }
}
