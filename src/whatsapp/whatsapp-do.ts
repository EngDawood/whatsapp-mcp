/**
 * WhatsAppStore - one Durable Object per person.
 *
 * On its own it only holds what needs no key: the account record (a wrapped key, useless without the password),
 * login throttling, and flags like "is a phone linked". Everything else is sealed with the person's data key, which
 * this object only ever holds in memory: open(key) checks the key and returns the open Account (account.ts), which
 * is where the store, the WhatsApp session and media live. It is gone when the object is evicted.
 */
import { DurableObject } from 'cloudflare:workers';
import { sqliteAuthState } from './auth-state.js';
import { Store, hasSchema, initSchema, isLeftover, isLegacy, migrateLegacy } from '../store/store.js';
import { Account } from './account.js';
import { Vault } from '../account/vault.js';
import type { AccountRecord } from '../account/vault.js';
import type { Env } from '../index.js';

export type { SessionResult } from './account.js';
export { MEDIA_MAX_BYTES } from './account.js';

const LOCK_AFTER = 5;
const MAX_LOCK_MS = 60 * 60_000;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString('base64');



export class WhatsAppStore extends DurableObject<Env> {
  /** The open account for the key last given to open(), while this object stays in memory. */
  private opened: { dek: string; account: Account } | null = null;
  private events: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Signing in asks every new person's object whether they have an account. Creating tables to answer that
    // would leave storage behind for everyone, including people turned away because the service is full.
    // So tables are made when an account is, and an empty leftover from before that is erased.
    const sql = ctx.storage.sql;
    if (isLeftover(sql)) ctx.blockConcurrencyWhile(() => ctx.storage.deleteAll());
    else if (hasSchema(sql)) initSchema(sql);
  }

  // ---------- accounts and keys (no key needed) ----------

  /** The stored account, and how long a login must wait if there have been too many wrong passwords. */
  account(): { record: AccountRecord | null; retryAfter: number } {
    const sql = this.ctx.storage.sql;
    if (!hasSchema(sql)) return { record: null, retryAfter: 0 };
    const row = sql.exec<{ v: string }>(`SELECT v FROM account WHERE k = 'record'`).toArray()[0];
    const until = Number(this.meta('locked_until') ?? 0);
    return { record: row ? JSON.parse(row.v) : null, retryAfter: Math.max(0, until - Date.now()) };
  }

  /** Create the account. False if there already is one, so two signups for the same login can't both win. */
  createAccount(record: AccountRecord, timezone: string): boolean {
    const sql = this.ctx.storage.sql;
    initSchema(sql);
    if (sql.exec(`SELECT 1 FROM account WHERE k = 'record'`).toArray().length) return false;
    sql.exec(`INSERT INTO account (k, v) VALUES ('record', ?)`, JSON.stringify(record));
    this.setMeta('tz', timezone);
    return true;
  }

  /** Slow down password guessing: five wrong passwords in a row, then longer and longer waits. */
  noteLogin(ok: boolean) {
    // a wrong password before there is an account: no tables yet (see the constructor), and nothing to lock
    if (!hasSchema(this.ctx.storage.sql)) return;
    if (ok) { this.setMeta('fails', '0'); this.setMeta('locked_until', '0'); return; }
    const fails = Number(this.meta('fails') ?? 0) + 1;
    this.setMeta('fails', String(fails));
    if (fails >= LOCK_AFTER) this.setMeta('locked_until', String(Date.now() + Math.min(MAX_LOCK_MS, 30_000 * 2 ** (fails - LOCK_AFTER))));
  }

  /** Swap in a new password wrapping for the same key. */
  replaceAccount(record: AccountRecord) {
    this.ctx.storage.sql.exec(`UPDATE account SET v = ? WHERE k = 'record'`, JSON.stringify(record));
  }

  /** TIMEZONE, when set, wins over the zone saved at sign-up, so a wrong first guess can be fixed without a new account. */
  timezone(): string { return this.env.TIMEZONE || this.meta('tz') || 'UTC'; }
  /** Is a phone linked? Remembered in the clear because it is asked before there is a key. */
  isPaired(): boolean { return this.meta('paired') === '1'; }

  private meta(k: string): string | null {
    return this.ctx.storage.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]?.v ?? null;
  }
  private setMeta(k: string, v: string) {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, v);
  }

  /**
   * Open the account with the person's data key (base64): the only way to anything keyed. Returns the open Account,
   * the same one for as long as this object stays in memory. The first open after an upgrade from the plaintext
   * release encrypts what was stored. A wrong key is refused.
   */
  open(dek: string): Account {
    if (this.opened?.dek === dek) return this.opened.account;
    const sql = this.ctx.storage.sql;
    if (!hasSchema(sql)) throw new Error('no account');
    const tx = <T>(fn: () => T) => this.ctx.storage.transactionSync(fn);
    const vault = Vault.fromBase64(dek);
    if (isLegacy(sql)) migrateLegacy(sql, vault, tx);
    const canary = this.meta('canary');
    if (canary) {
      try { vault.open(Buffer.from(canary, 'base64'), 'canary'); } catch { throw new Error('wrong key'); }
    } else {
      this.setMeta('canary', b64(vault.seal('ok', 'canary')));
    }
    // told on every open and every creds save; only a change is worth a write
    const auth = sqliteAuthState(sql, vault, (paired) => {
      const v = paired ? '1' : '0';
      if (this.meta('paired') !== v) this.setMeta('paired', v);
    });
    const host = {
      ctx: this.ctx, env: this.env,
      meta: (k: string) => this.meta(k), setMeta: (k: string, v: string) => this.setMeta(k, v),
      note: (m: string) => this.note(m), forget: () => { this.opened = null; },
    };
    const account = new Account(host, auth, new Store(sql, tx, vault));
    this.opened = { dek, account };
    return account;
  }

  private note(msg: string) {
    this.events.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (this.events.length > 80) this.events.shift();
  }


  /** A pairing or pull session runs in the alarm, so it outlives the request that started it. */
  async alarm() {
    await this.opened?.account.idle(); // holding the alarm open keeps the DO alive while the session runs
  }

  /** What is safe to show without a key: the state of the session and its log. Never message content. */
  debug() {
    const one = (q: string) => this.ctx.storage.sql.exec<{ n: number }>(q).toArray()[0].n;
    return {
      phase: this.opened?.account.sessionPhase() ?? 'idle', paired: this.isPaired(), unlocked: Boolean(this.opened),
      lastPull: Number(this.meta('last_pull') ?? 0), messages: one(`SELECT COUNT(*) n FROM messages`), events: this.events,
    };
  }
}
