// Drives the real MCP server in-process (no Worker) against a Store, to check what daily_digest prints.
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initSchema, Store } from '../src/store/store.ts';
import { createAccount, Vault } from '../src/account/vault.ts';
import { buildServer } from '../src/mcp/server.ts';
import { History } from '../src/history/history.ts';
import { zoneMidnight } from '../src/history/zone.ts';

const db = new DatabaseSync(':memory:');
const fromDb = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v])));
const toDb = (a: any[]) => a.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x));
const cur = (rows: any[]) => ({ toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() });
const sql: any = { exec(q: string, ...args: any[]) {
  if (!args.length && q.trim().split(';').filter((x) => x.trim()).length > 1) { db.exec(q); return cur([]); }
  const st = db.prepare(q);
  return /^\s*(select|with|pragma)/i.test(q) ? cur(fromDb(st.all(...toDb(args)) as any[])) : (st.run(...toDb(args)), cur([]));
} };
initSchema(sql);
const store = new Store(sql, (fn) => fn(), new Vault((await createAccount('x', 1000)).dek));

const TZ = 'Asia/Riyadh', day = zoneMidnight('2026-11-18', TZ);
const M = (id: string, chat: string, ts: number, body: string, fromMe = false, pushName?: string) =>
  ({ key: { id, remoteJid: chat, fromMe }, messageTimestamp: ts, message: { conversation: body }, pushName }) as any;
const ALI = '966500000001@s.whatsapp.net', SARA = '966500000002@s.whatsapp.net', OLD = '967700000003@s.whatsapp.net';
store.ingestMessages([
  M('o1', OLD, day - 3 * 86400, 'هل الطلب جاهز؟', false, 'Omar'),
  M('a1', ALI, day + 9 * 3600, 'كم سعر ٣ قطع؟', false, 'Ali'), M('a2', ALI, day + 9 * 3600 + 120, 'والتوصيل؟', false, 'Ali'),
  M('s1', SARA, day + 10 * 3600, 'order shipped?', false, 'Sara'), M('s2', SARA, day + 11 * 3600, 'yes, today', true),
]);

const live = { isPaired: async () => true, pullIfStale: async () => null, lastPull: async () => 0 };
const h = new History(store, live, TZ, { countryCode: '966' });
const server = buildServer(h, store, {} as any, {} as any, 'https://example.test');
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 't', version: '0' });
await client.connect(b);
const names = (await client.listTools()).tools.map((t) => t.name);
const r: any = await client.callTool({ name: 'daily_digest', arguments: { date: '2026-11-18' } });
const out: string = r.content[0].text;
let failed = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++; };
check('daily_digest is listed', names.includes('daily_digest'));
check('header counts chats and waiting, in the user zone', out.startsWith('# 2026-11-18 (Asia/Riyadh): 2 chats active, 1 waiting on a reply'));
check('the waiting customer comes first, with local times', out.indexOf('### Ali') < out.indexOf('### Sara') && out.includes('WAITING on the user since 2026-11-18 09:00') && out.includes('[09:02] Ali: والتوصيل؟'));
check('answered chats show my reply', out.includes('### Sara (+966500000002): 1 in, 1 out') && out.includes('[11:00] Me: yes, today'));
check('a chat forgotten since an earlier day is listed', /## Still waiting from earlier days\nOmar \(\+967700000003\) \| 1 waiting since 2026-11-15 00:00/.test(out));

// notes, through the tools
const call = async (name: string, args: any) => ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;
check('notes tools are listed', ['save_note', 'list_notes', 'update_note'].every((n) => names.includes(n)));
check('save a note with a reminder, by chat name', (await call('save_note', { chat: 'Ali', text: 'أرسل عرض السعر', remind_on: '2026-11-18' })) === 'Saved note #1 for Ali, reminder on 2026-11-18.');
check('save a note for a number with no chat yet', /^Saved note #2 for \+966511111111\.$/.test(await call('save_note', { chat: '+966 51 111 1111', text: 'new lead from Instagram' })));
check('save a general note with an older reminder', (await call('save_note', { text: 'renew licence', remind_on: '2026-11-16' })) === 'Saved note #3, reminder on 2026-11-16.');
const withNotes = await call('daily_digest', { date: '2026-11-18' });
check('digest lists reminders due, overdue marked', /## Reminders due\nOVERDUE #3 \(remind 2026-11-16\): renew licence\n#1 Ali \(remind 2026-11-18\): أرسل عرض السعر/.test(withNotes));
check('digest shows a chat\'s open notes under it', withNotes.includes('### Ali (+966500000001): 2 in, 0 out') && withNotes.includes('Note #1 (remind 2026-11-18): أرسل عرض السعر'));
check('get_messages shows the chat\'s notes', (await call('get_messages', { chat: 'Ali' })).includes('Notes: #1 (remind 2026-11-18): أرسل عرض السعر'));
check('list_notes by day', (await call('list_notes', { due_by: '2026-11-17' })).startsWith('#3 (remind 2026-11-16): renew licence'));
check('mark done', (await call('update_note', { id: 1, done: true })) === 'Note #1: marked done.');
check('a done note leaves the digest', !(await call('daily_digest', { date: '2026-11-18' })).includes('#1 '));
check('clear a reminder, then delete', (await call('update_note', { id: 3, remind_on: 'none' })) === 'Note #3: reminder cleared.' && (await call('update_note', { id: 3, delete: true })) === 'Deleted note #3.');
check('a missing note says so', (await call('update_note', { id: 42, done: true })) === 'There is no note #42.');
await client.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
