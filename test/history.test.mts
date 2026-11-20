// The History reader over a real Store on node:sqlite: the read rules both front ends share.
import { DatabaseSync } from 'node:sqlite';
import { initSchema, Store } from '../src/store/store.ts';
import { createAccount, Vault } from '../src/account/vault.ts';
import { History, parsePoint, cursorOf } from '../src/history/history.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' -> ' + JSON.stringify(detail)}`); if (!ok) failed++; };

const db = new DatabaseSync(':memory:');
const fromDb = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v])));
const toDb = (a: any[]) => a.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x));
const cur = (rows: any[], n = 0) => ({ toArray: () => rows, one: () => rows[0], rowsWritten: n, [Symbol.iterator]: () => rows[Symbol.iterator]() });
const sql: any = { exec(q: string, ...args: any[]) {
  if (!args.length && q.trim().split(';').filter((x) => x.trim()).length > 1) { db.exec(q); return cur([]); }
  const st = db.prepare(q);
  return /^\s*(select|with|pragma)/i.test(q) ? cur(fromDb(st.all(...toDb(args)) as any[])) : cur([], Number(st.run(...toDb(args)).changes));
} };
initSchema(sql);
const store = new Store(sql, (fn) => fn(), new Vault((await createAccount('x', 1000)).dek));

const M = (id: string, chat: string, ts: number, body: string, fromMe = false, pushName?: string) =>
  ({ key: { id, remoteJid: chat, fromMe }, messageTimestamp: ts, message: { conversation: body }, pushName }) as any;
const NOURA = '966501111111@s.whatsapp.net', NOURA2 = '966502222222@s.whatsapp.net', DANA = '966503333333@s.whatsapp.net';
const NOW = 1_800_000_000;
store.ingestMessages([
  M('n1', NOURA, NOW - 100, 'logo please', false, 'Noura'),
  M('m1', NOURA2, NOW - 90, 'hello', false, 'Noura Ali'),
  ...Array.from({ length: 7 }, (_, i) => M(`d${i}`, DANA, NOW - 50 + (i < 4 ? 0 : i), `msg ${i}`, false, 'Dana')),
  M('old', DANA, NOW - 20 * 86400, 'ancient question', false, 'Dana'),
]);

let pulls = 0, linked = true, failPull = false;
const live = {
  isPaired: () => linked,
  pullIfStale: async (ms: number) => { if (failPull) throw new Error('socket closed'); pulls++; return { added: ms === 60_000 ? 2 : 0 }; },
  lastPull: () => 0,
};
const h = new History(store, live, 'Asia/Riyadh', { countryCode: '966', now: () => NOW * 1000 });

// resolving chats
const amb = await h.resolve('nour');
check('a fragment matching two chats is ambiguous, with both offered', !amb.ok && amb.reason === 'ambiguous' && amb.matches.length === 2, amb);
const exact = await h.resolve('Noura');
check('an exact name settles it', exact.ok && exact.jid === NOURA, exact);
const none = await h.resolve('zzz');
check('nothing matching says so', !none.ok && none.reason === 'none');
const jid = await h.resolve(DANA);
check('a jid is taken as given, with its name', jid.ok && jid.name === 'Dana', jid);
const phone = await h.resolve('0504444444', { phone: true });
check('a phone number with no chat resolves when asked to', phone.ok && phone.jid === '966504444444@s.whatsapp.net', phone);
check('but not unless asked', !(await h.resolve('0504444444')).ok);

// paging
const p1 = await h.messages(DANA, { limit: 3 });
check('the latest page, oldest first, says there is more', p1.messages.map((m) => m.id).join() === 'd4,d5,d6' && Boolean(p1.older) && !p1.newer, p1);
const p2 = await h.messages(DANA, { limit: 3, before: p1.older });
const p3 = await h.messages(DANA, { limit: 10, before: p2.older });
const seen = [...p3.messages, ...p2.messages, ...p1.messages].map((m) => m.id);
check('paging back with cursors skips and repeats nothing, even within one second', seen.join() === 'old,d0,d1,d2,d3,d4,d5,d6' && !p3.older, seen);
const fwd = await h.messages(DANA, { limit: 2, after: NOW - 60 });
check('paging forward gives a newer cursor', fwd.messages.length === 2 && Boolean(fwd.newer) && !fwd.older, fwd);
check('cursors parse back to time and id', JSON.stringify(parsePoint(cursorOf({ ts: 1700000000, id: 'X#Y' }))) === JSON.stringify({ ts: 1700000000, id: 'X#Y' }));
check('epoch seconds and ISO both parse', parsePoint('1700000000')?.ts === 1700000000 && parsePoint('2023-11-14T22:13:20Z')?.ts === 1700000000);
let threw = ''; try { parsePoint('next tuesday'); } catch (e: any) { threw = e.message; }
check('a bad date says how to write one', threw.includes('ISO format'), threw);

// default windows
const ua = await h.unanswered({ limit: 10 });
check('unanswered looks back 14 days by default', ua.since === NOW - 14 * 86400 && ua.rows.length === 3, ua);
const act = await h.activity({ limit: 10 });
check('activity covers the last 7 days by default', act.until === NOW && act.since === NOW - 7 * 86400 && act.totals.messages === 9, act);

// search
const s = await h.search(['msg', 'logo'], { limit: 2 });
check('search says which queries hit their limit', s.more[0] === true && s.more[1] === false && s.hits[1][0].id === 'n1', s.more);

// freshness
check('a read pulls if stale and reports it', (await h.refresh()).linked && pulls === 1);
check('the refresh button uses the short threshold', (await h.refresh(60_000)).added === 2);
failPull = true;
const bad = await h.refresh();
check('a failed pull never throws, it explains', bad.linked && bad.error === 'socket closed');
linked = false;
check('no phone linked is said, not pulled', !(await h.refresh()).linked);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
