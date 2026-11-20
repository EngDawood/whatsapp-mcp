/** The MCP surface: tools over the message store. Each read tops up from WhatsApp first if the store is stale. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Env, McpProps } from '../index.js';
import type { WhatsAppStore } from '../whatsapp/whatsapp-do.js';
import { unlockedStub } from '../account/auth.js';
import { toJid } from '../whatsapp/phone.js';
import { addDays, zoneMidnight, zoneToday } from '../history/zone.js';
import type { Activity, Note } from '../store/store.js';

const STALE_MS = 10 * 60_000;

const epoch = (s?: string) => {
  if (!s) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Cannot parse date "${s}" - use ISO format like 2026-03-01`);
  return Math.floor(t / 1000);
};
/** Search results are for skimming; a long broadcast shouldn't flood the context. get_messages has the full text. */
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}... [+${s.length - n} chars]` : s);
const oneLine = (s: string, n: number) => clip(s.replace(/\s+/g, ' ').trim(), n);
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/**
 * WhatsApp doesn't give this server every contact name, so some chats are only a phone number. The
 * server doesn't manage contacts; whatever contacts tool the agent already has does the lookup. This
 * line goes wherever an agent might be stuck on a name it can't find, because that's when it helps.
 */
const NAME_HINT =
  `Can't find someone by name? Some chats are known only by phone number. Call unnamed_chats, match those numbers against the user's contacts ` +
  `if you can reach them (a Google Contacts or Gmail tool, for example), and save what you find with set_contact_names. Searching by name works after that.`;

type Rows = Record<string, any>[];

/** Messages with a file carry their id, which get_media and transcribe_audio take. */
const mediaTag = (r: Record<string, any>, chat?: string) => (r.media ? ` (media id: ${r.id}${chat ? ` in ${chat}` : ''})` : '');
/** Every search hit carries its id, so get_context can open the conversation around it. */
const hitTag = (r: Record<string, any>, chat: string) => (r.media ? mediaTag(r, chat) : ` (id: ${r.id} in ${chat})`);
/** "(replying to ...)" for a message that quotes another, so an agent can follow a thread. */
const replyTag = (r: Record<string, any>) => (r.reply_to ? ` (replying to "${r.reply_to.b || 'a message'}")` : '');
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const TEXTUAL = /^(text\/|application\/(json|xml|csv)\b)/;

const displayNumber = (jid: string) => (jid.endsWith('@s.whatsapp.net') ? `+${jid.replace('@s.whatsapp.net', '')}` : jid);

export function buildServer(wa: DurableObjectStub<WhatsAppStore>, env: Env, origin: string, TZ: string) {
  const canTranscribe = Boolean(env.AI);
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
  const when = (ts: number) => fmt.format(new Date(ts * 1000));
  const dayOf = (ts: number) => when(ts).slice(0, 10);
  /** One note as a line; `withChat` names the chat, for lists that mix chats. */
  const noteLine = (n: Note, withChat = false) =>
    `#${n.id}${withChat && n.name ? ` ${n.name}` : ''}${n.due ? ` (remind ${dayOf(n.due)})` : ''}${n.done ? ' [done]' : ''}: ${oneLine(n.text, 400)}`;
  const server = new McpServer(
    { name: 'whatsapp-mcp', version: '0.1.0' },
    {
      instructions:
        `Access to the user's WhatsApp history. It can read and search messages and save names for phone numbers; it cannot send anything. Timestamps are ${TZ}. ` +
        `Each read first pulls anything new from WhatsApp if the store is more than a few minutes old. ` +
        `Use list_chats to find a chat, get_messages to read it, search_messages to find things across chats, get_context to read around a search hit, ` +
        `chat_activity for who talked how much over a period, and unanswered_chats for direct messages still waiting on a reply. ` +
        `Photos, voice notes, videos, documents and stickers show as labels with a media id; get_media fetches the file` +
        `${canTranscribe ? ' and transcribe_audio turns voice notes into text' : ''}. ` +
        `daily_digest gives a whole day in one call for an end-of-day summary. When the user tells you something worth remembering about a customer ` +
        `(what they want, a promise, a day to follow up), save it with save_note, with remind_on for a follow-up; notes and due reminders show up in ` +
        `daily_digest and get_messages, and list_notes / update_note manage them. Notes stay on this server; nothing is sent to WhatsApp. ${NAME_HINT}`,
      maxToolInputElements: 10_000,
    },
  );

  // One log line per tool call: which tool and how long it took. Never arguments or results.
  const register = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: unknown, handler: (...a: any[]) => Promise<any>) =>
    register(name, config, async (...args: any[]) => {
      const t0 = Date.now();
      let ok = false;
      try { const r = await handler(...args); ok = !r?.isError; return r; }
      finally { console.log(JSON.stringify({ tool: name, ms: Date.now() - t0, ok })); }
    });

  /** Top up from WhatsApp; never let a failed pull block reading what we already have. */
  const fresh = async (): Promise<string> => {
    try {
      if (!(await wa.isPaired())) return `WhatsApp is not linked yet. Open ${origin}/setup to scan the QR code.\n\n`;
      await wa.pullIfStale(STALE_MS);
      return '';
    } catch (e: any) {
      return `(could not refresh from WhatsApp: ${e?.message}; showing stored messages)\n\n`;
    }
  };

  server.registerTool(
    'list_chats',
    {
      description:
        'List chats (DMs and groups), most recently active first. Optionally filter by name or number fragment. ' +
        "If a person you're looking for isn't here by name, they may be a chat known only by number: see unnamed_chats.",
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) },
    },
    async ({ query, limit }) => {
      const note = await fresh();
      const rows = (await wa.listChats(query, limit)) as Rows;
      if (!rows.length) return text(note + `No chats found${query ? ` matching "${query}"` : ''}. ${query ? NAME_HINT : ''}`.trimEnd());
      return text(
        note + rows.map((r) => `${r.name}${r.is_group ? ' [group]' : ''} | ${r.messages} msgs | last ${when(r.last_ts)} | ${r.jid}`).join('\n'),
      );
    },
  );

  server.registerTool(
    'get_messages',
    {
      description:
        'Read messages from one chat, oldest first. `chat` is a jid from list_chats or a name/number fragment. ' +
        'By default returns the most recent messages; pass `before` to page back in time or `after` to page forward.',
      inputSchema: {
        chat: z.string(),
        limit: z.number().int().min(1).max(500).default(50),
        before: z.string().optional().describe('ISO date/time; only messages before this'),
        after: z.string().optional().describe('ISO date/time; only messages after this'),
      },
    },
    async ({ chat, limit, before, after }) => {
      const note = await fresh();
      const matches = (await wa.resolveChat(chat)) as { jid: string; name: string }[];
      if (!matches.length) return text(note + `No chat matches "${chat}". Try list_chats. ${NAME_HINT}`);
      if (matches.length > 1 && !chat.includes('@')) {
        return text(note + `"${chat}" matches several chats, pick one by jid:\n` + matches.map((m) => `${m.name} | ${m.jid}`).join('\n'));
      }
      const [rows, notes] = await Promise.all([
        wa.getMessages({ chat: matches[0].jid, limit, before: epoch(before), after: epoch(after) }) as Promise<Rows>,
        wa.notes({ jid: matches[0].jid, open: true, limit: 20 }) as Promise<Note[]>,
      ]);
      const head = `# ${matches[0].name} (${rows.length} messages)\n` + (notes.length ? `Notes: ${notes.map((n) => noteLine(n)).join(' | ')}\n` : '');
      const body = rows.map((r) => `[${when(r.ts)}] ${r.sender}${replyTag(r)}: ${r.body}${mediaTag(r)}`).join('\n');
      let more = '';
      if (rows.length === limit) {
        more = after && !before
          ? `\n\n(more messages follow: pass after="${iso(rows[rows.length - 1].ts)}" to continue)`
          : `\n\n(older messages exist: pass before="${iso(rows[0].ts)}" to page back)`;
      }
      return text(note + head + body + more);
    },
  );

  server.registerTool(
    'search_messages',
    {
      description:
        'Search all messages (or one chat) for words, newest matches first. Words are matched whole, ignoring case and accents; several words must all appear; ' +
        '"quoted words" must appear together in order; a trailing * matches word starts (flight* finds flights). ' +
        'Messages are stored encrypted, so each search decrypts the history, which takes a few seconds. Put every search you need in `queries` ' +
        'and the cost is paid once for all of them. Each hit shows its id; pass it to get_context to read the conversation around it. To find everything with a person, use list_chats to get their chat. If nobody by that name exists, see unnamed_chats.',
      inputSchema: {
        queries: z.array(z.string()).min(1).max(20).optional().describe('Several searches at once. Results come back grouped by query.'),
        query: z.string().optional().describe('One search. Same as queries with a single item.'),
        chat: z.string().optional().describe('Restrict to one chat (jid or name fragment)'),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(30).describe('Most matches to return for each query'),
      },
    },
    async ({ queries, query, chat, since, until, limit }) => {
      const qs = [...(queries ?? []), ...(query ? [query] : [])].filter((q) => q.trim());
      if (!qs.length) return text('Give at least one search in `queries`.');
      const note = await fresh();
      let chatJid: string | undefined;
      if (chat) {
        const m = (await wa.resolveChat(chat)) as { jid: string }[];
        if (!m.length) return text(note + `No chat matches "${chat}". ${NAME_HINT}`);
        chatJid = m[0].jid;
      }
      const { hits } = await wa.search({ queries: qs, chat: chatJid, since: epoch(since), until: epoch(until), limit });
      const lines = (rows: typeof hits[number]) => rows.map((r) => `[${when(r.ts)}] ${r.chat_name} | ${r.sender}: ${clip(r.body)}${hitTag(r, r.chat)}`).join('\n');
      const capped = (n: number) => (n >= limit ? `\n(showing the newest ${limit}; there may be more. Raise limit or narrow with since/until.)` : '');
      const none = `No matches. If you were looking for something a particular person said, they may be saved only as a number. ${NAME_HINT}`;
      if (qs.length === 1) return text(note + (hits[0].length ? lines(hits[0]) + capped(hits[0].length) : none));
      return text(note + qs.map((q, i) => `## ${q} (${hits[i].length} match${hits[i].length === 1 ? '' : 'es'})\n${hits[i].length ? lines(hits[i]) + capped(hits[i].length) : 'No matches.'}`).join('\n\n'));
    },
  );

  server.registerTool(
    'unanswered_chats',
    {
      description:
        'Direct (one-to-one) chats where the other person wrote last and the user has not replied, most recent first. Groups are left out. ' +
        "A reaction from the user counts as a reply. Each row says how many messages are waiting, since when, and the last one. " +
        'Looks at chats active in the last 14 days unless `since` says otherwise.',
      inputSchema: {
        since: z.string().optional().describe('ISO date; only chats with a message at or after this. Default: 14 days ago'),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since, limit }) => {
      const note = await fresh();
      const from = epoch(since) ?? Math.floor(Date.now() / 1000) - 14 * 86400;
      const rows = (await wa.unanswered({ since: from, limit })) as Rows;
      if (!rows.length) return text(note + `No direct chats are waiting on a reply since ${when(from)}.`);
      const lines = rows.map(
        (r) => `${r.name} | ${r.waiting}${r.more ? '+' : ''} waiting since ${when(r.since)} | last ${when(r.last_ts)}: "${oneLine(r.last, 160)}" | ${r.jid}`,
      );
      return text(note + `${rows.length} direct chats waiting on a reply:\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'daily_digest',
    {
      description:
        "Everything that happened in the user's chats on one day, for an end-of-day summary or a reminder of who still needs an answer. " +
        'It starts with saved notes whose reminder day has come (overdue ones marked), and shows each chat\'s open notes. ' +
        `Days are in ${TZ}; the default is today. For each direct chat active that day: messages in and out, whether the other person is still ` +
        'waiting on a reply and since when, and that day\'s messages, oldest first. Chats still waiting come first. It also lists direct chats ' +
        'that have been waiting since earlier days, which are the easiest to forget. Summarize from this one call rather than reading chats one by one. ' +
        'Groups are left out unless include_groups is true.',
      inputSchema: {
        date: z.string().optional().describe(`YYYY-MM-DD in ${TZ}. Default: today`),
        days: z.number().int().min(1).max(7).default(1).describe('How many days, ending on `date`. 7 gives the week up to and including `date`'),
        include_groups: z.boolean().default(false),
        per_chat: z.number().int().min(1).max(100).default(20).describe('Most messages shown per chat; the latest ones are kept'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ date, days, include_groups, per_chat }) => {
      const note = await fresh();
      const last = date ?? zoneToday(TZ);
      const firstDay = addDays(last, -(days - 1));
      const from = zoneMidnight(firstDay, TZ), to = zoneMidnight(addDays(last, 1), TZ);
      const [{ chats, total }, ua, notes] = await Promise.all([
        wa.digest({ from, to, groups: include_groups, perChat: per_chat, maxChats: 50 }),
        wa.unanswered({ since: from - 14 * 86400, limit: 100 }) as Promise<Rows>,
        wa.notes({ open: true, limit: 500 }) as Promise<Note[]>,
      ]);
      const notesOf = new Map<string, Note[]>();
      for (const n of notes) if (n.jid) notesOf.set(n.jid, [...(notesOf.get(n.jid) ?? []), n]);
      const due = notes.filter((n) => n.due !== null && n.due < to);
      // a chat waiting since before the window: say since when, not just since its first message that day
      const waitingSince = new Map(ua.map((r) => [r.jid as string, r.since as number]));
      const stamp = days === 1 ? (ts: number) => when(ts).slice(11) : when;
      const span = days === 1 ? last : `${firstDay} to ${last}`;

      const block = (c: (typeof chats)[number]) => {
        const since = waitingSince.get(c.jid) ?? c.waiting_since;
        const head =
          `### ${c.name}${c.is_group ? ' [group]' : ''} (${displayNumber(c.jid)}): ${c.incoming} in, ${c.outgoing} out` +
          (c.waiting ? `, WAITING on the user since ${since ? when(since) : '?'}` : '');
        const lines = c.messages.map((m) => `[${stamp(m.ts)}] ${m.sender}: ${clip(m.body, 500)}${mediaTag(m)}`);
        const own = notesOf.get(c.jid) ?? [];
        return [head, ...own.map((n) => `Note ${noteLine(n)}`), ...(c.earlier ? [`(${c.earlier} earlier messages that day not shown)`] : []), ...lines].join('\n');
      };
      const waiting = chats.filter((c) => c.waiting);
      const rest = chats.filter((c) => !c.waiting);
      const inWindow = new Set(chats.map((c) => c.jid));
      const older = ua.filter((r) => !inWindow.has(r.jid) && r.since < from);

      const out = [`# ${span} (${TZ}): ${total} chat${total === 1 ? '' : 's'} active, ${waiting.length} waiting on a reply`];
      if (total > chats.length) out.push(`(showing the ${chats.length} most relevant)`);
      if (!chats.length) out.push('No messages in this period.');
      if (due.length) {
        out.push('', '## Reminders due');
        for (const n of due) out.push(`${n.due! < from ? 'OVERDUE ' : ''}${noteLine(n, true)}`);
      }
      if (waiting.length) out.push('', '## Waiting on the user', ...waiting.map(block));
      if (rest.length) out.push('', '## Answered, or nothing to answer', ...rest.map(block));
      if (older.length) {
        out.push('', '## Still waiting from earlier days');
        for (const r of older) out.push(`${r.name} (${displayNumber(r.jid)}) | ${r.waiting}${r.more ? '+' : ''} waiting since ${when(r.since)} | last: "${oneLine(r.last, 160)}"`);
      }
      return text(note + out.join('\n'));
    },
  );

  /** A chat for the media tools: a jid as shown, or a name that matches exactly one chat. */
  const oneChat = async (chat: string): Promise<{ jid: string } | { error: string }> => {
    const m = (await wa.resolveChat(chat)) as { jid: string; name: string }[];
    if (!m.length) return { error: `No chat matches "${chat}". Pass the jid shown with the media id.` };
    if (m.length > 1 && !chat.includes('@')) return { error: `"${chat}" matches several chats, pass the jid:\n` + m.map((c) => `${c.name} | ${c.jid}`).join('\n') };
    return { jid: m[0].jid };
  };

  /** A chat for notes: like oneChat, but a phone number that has no chat yet is fine too. */
  const noteChat = async (chat: string): Promise<{ jid: string } | { error: string }> => {
    const c = await oneChat(chat);
    if (!('error' in c)) return c;
    const jid = /^[+\d][\d\s()-]{5,}$/.test(chat.trim()) ? toJid(chat.trim(), env.DEFAULT_COUNTRY_CODE) : null;
    return jid ? { jid } : { error: c.error.replace('Pass the jid shown with the media id.', 'Pass the jid from list_chats, or a phone number.') };
  };
  const remindDay = (d: string) => zoneMidnight(d.trim(), TZ);

  server.registerTool(
    'save_note',
    {
      description:
        "Remember something about a customer or a follow-up, on this server: what they asked for, a promise made, a price quoted, a day to get back to them. " +
        'Use remind_on for anything that needs doing on a certain day; daily_digest lists it from that day until it is marked done. ' +
        "Only save what the user said or what the chat shows; don't invent. Nothing is sent to WhatsApp.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe('The note, in the language the user uses'),
        chat: z.string().optional().describe('The chat it is about: a jid, a name that matches one chat, or a phone number. Leave out for a general note'),
        remind_on: z.string().optional().describe(`YYYY-MM-DD in ${TZ}: the day to be reminded`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ text: body, chat, remind_on }) => {
      let jid: string | null = null;
      if (chat) {
        const c = await noteChat(chat);
        if ('error' in c) return { content: [{ type: 'text' as const, text: c.error }], isError: true };
        jid = c.jid;
      }
      const due = remind_on ? remindDay(remind_on) : null;
      const id = await wa.addNote(jid, body.trim(), due);
      const name = jid ? (await wa.resolveChat(jid))[0]?.name ?? displayNumber(jid) : null;
      return text(`Saved note #${id}${name ? ` for ${name}` : ''}${due ? `, reminder on ${dayOf(due)}` : ''}.`);
    },
  );

  server.registerTool(
    'list_notes',
    {
      description: 'Saved notes, reminders soonest first. Open ones only unless include_done. Filter by chat, or by due_by to see what needs doing by a day.',
      inputSchema: {
        chat: z.string().optional().describe('A jid, a name that matches one chat, or a phone number'),
        due_by: z.string().optional().describe(`YYYY-MM-DD in ${TZ}: only notes with a reminder on or before this day`),
        include_done: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chat, due_by, include_done, limit }) => {
      let jid: string | undefined;
      if (chat) {
        const c = await noteChat(chat);
        if ('error' in c) return { content: [{ type: 'text' as const, text: c.error }], isError: true };
        jid = c.jid;
      }
      const dueBy = due_by ? zoneMidnight(addDays(due_by.trim(), 1), TZ) : undefined;
      const notes = (await wa.notes({ jid, open: !include_done, dueBy, limit })) as Note[];
      if (!notes.length) return text(`No ${include_done ? '' : 'open '}notes${chat ? ` for ${chat}` : ''}${due_by ? ` due by ${due_by}` : ''}.`);
      return text(notes.map((n) => `${noteLine(n, !jid)} (saved ${dayOf(n.created)})`).join('\n'));
    },
  );

  server.registerTool(
    'update_note',
    {
      description:
        'Change a saved note by its #id: mark it done once it is handled (it then stops showing in daily_digest), change its text or reminder day, ' +
        'or delete it. remind_on "none" clears the reminder.',
      inputSchema: {
        id: z.number().int().min(1),
        done: z.boolean().optional(),
        text: z.string().min(1).max(2000).optional(),
        remind_on: z.string().optional().describe(`YYYY-MM-DD in ${TZ}, or "none"`),
        delete: z.boolean().optional().describe('true removes the note for good'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id, done, text: body, remind_on, delete: del }) => {
      if (del) return text((await wa.deleteNote(id)) ? `Deleted note #${id}.` : `There is no note #${id}.`);
      const due = remind_on === undefined ? undefined : remind_on.trim().toLowerCase() === 'none' ? null : remindDay(remind_on);
      if (done === undefined && body === undefined && due === undefined) return text('Nothing to change: pass done, text, remind_on or delete.');
      const ok = await wa.updateNote(id, { done, text: body?.trim(), due });
      if (!ok) return text(`There is no note #${id}.`);
      const parts = [done === true && 'marked done', done === false && 'reopened', body !== undefined && 'text changed',
        due === null && 'reminder cleared', typeof due === 'number' && `reminder on ${dayOf(due)}`].filter(Boolean);
      return text(`Note #${id}: ${parts.join(', ')}.`);
    },
  );

  server.registerTool(
    'get_context',
    {
      description:
        'Read the conversation around one message: the messages just before and after it in the same chat, oldest first, with the message itself marked >>. ' +
        'Take `chat` and `message_id` from the "(id: ... in ...)" or "(media id: ... in ...)" shown on a search_messages hit.',
      inputSchema: {
        chat: z.string().describe('Chat jid, or a name that matches one chat'),
        message_id: z.string(),
        before: z.number().int().min(0).max(100).default(10).describe('Messages to show before it'),
        after: z.number().int().min(0).max(100).default(10).describe('Messages to show after it'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chat, message_id, before, after }) => {
      const c = await oneChat(chat);
      if ('error' in c) return text(c.error);
      const r = await wa.context(c.jid, message_id, before, after);
      if (!r) return text(`No message with id ${message_id} in that chat. Ids come from search_messages hits, and belong to the chat shown with them.`);
      const name = (await wa.resolveChat(c.jid))[0]?.name ?? c.jid;
      const lines = r.messages.map((m) => `${m.id === r.target ? '>> ' : ''}[${when(m.ts)}] ${m.sender}${replyTag(m)}: ${m.body}${mediaTag(m)}`);
      return text(`# ${name} around ${when(r.messages.find((m) => m.id === r.target)!.ts)}\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'chat_activity',
    {
      description:
        'Who talked and how much over a period. Without `chat`: the busiest chats, with how many of the messages were the user\'s. ' +
        'With `chat`: the busiest people in that chat. Counts only, so it is fast; read the messages with get_messages. ' +
        'Good for "what did I miss this week" (find the busy chats first) or "who is most active in this group". Reactions are not counted. Default period: the last 7 days.',
      inputSchema: {
        since: z.string().optional().describe('ISO date/time. Default: 7 days ago'),
        until: z.string().optional().describe('ISO date/time. Default: now'),
        chat: z.string().optional().describe('One chat (jid or a name that matches one chat) to break down by person'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since, until, chat, limit }) => {
      const note = await fresh();
      const to = epoch(until) ?? Math.floor(Date.now() / 1000);
      const from = epoch(since) ?? to - 7 * 86400;
      let jid: string | undefined;
      if (chat) {
        const c = await oneChat(chat);
        if ('error' in c) return text(note + c.error);
        jid = c.jid;
      }
      const r = (await wa.activity({ since: from, until: to, chat: jid, limit })) as Activity;
      const span = `${when(from)} to ${when(to)}`;
      if (!r.totals.messages) return text(note + `No messages ${jid ? 'in that chat ' : ''}between ${span}.`);
      const head = `${r.totals.messages} messages (${r.totals.mine} from the user)${jid ? '' : ` in ${r.totals.chats} chats`}, ${span}.`;
      if (jid) {
        const name = (await wa.resolveChat(jid))[0]?.name ?? jid;
        return text(note + `# ${name}\n${head}\n` + r.people.map((p) => `${p.name} | ${p.messages} msgs | last ${when(p.last_ts)}`).join('\n'));
      }
      return text(note + head + '\n' + r.chats.map((c) => `${c.name}${c.is_group ? ' [group]' : ''} | ${c.messages} msgs (${c.mine} mine) | last ${when(c.last_ts)} | ${c.jid}`).join('\n'));
    },
  );


  server.registerTool(
    'get_media',
    {
      description:
        'Fetch the file behind a photo, sticker, voice note, audio, video or document. Take `message_id` from the "(media id: ...)" in get_messages or ' +
        'search_messages, and `chat` from the same place (the chat you read, or the jid after "in"). Images and stickers come back as images, audio as audio, ' +
        'text documents as text, and other files (PDFs, videos) as an embedded file. Files over 10 MB are refused. ' +
        "WhatsApp keeps files for a few weeks; for older ones the phone is asked to upload the file again, which only works while it is online and still has it." +
        (canTranscribe ? ' For what a voice note says, transcribe_audio is cheaper than fetching the audio.' : ''),
      inputSchema: {
        chat: z.string().describe('Chat jid, or a name that matches one chat'),
        message_id: z.string().describe('The media id shown next to the message'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chat, message_id }) => {
      const c = await oneChat(chat);
      if ('error' in c) return text(c.error);
      const r = await wa.fetchMedia(c.jid, message_id);
      if (!r.ok) return { content: [{ type: 'text' as const, text: `Could not get that file: ${r.error}.` }], isError: true };
      const mime = r.mime.split(';')[0].trim();
      const about = { type: 'text' as const, text: `${r.kind}${r.name ? ` "${r.name}"` : ''}, ${mime}, ${Math.ceil(r.size / 1024)} KB${r.reuploaded ? ' (uploaded again by the phone)' : ''}` };
      if (r.kind === 'image' || r.kind === 'sticker') return { content: [about, { type: 'image' as const, data: r.data, mimeType: mime }] };
      if (r.kind === 'audio') return { content: [about, { type: 'audio' as const, data: r.data, mimeType: mime }] };
      const uri = `whatsapp://media/${encodeURIComponent(c.jid)}/${encodeURIComponent(message_id)}`;
      const resource = TEXTUAL.test(mime) ? { uri, mimeType: mime, text: Buffer.from(r.data, 'base64').toString('utf8') } : { uri, mimeType: mime, blob: r.data };
      return { content: [about, { type: 'resource' as const, resource }] };
    },
  );

  if (canTranscribe) {
    server.registerTool(
      'transcribe_audio',
      {
        description:
          'Turn voice notes and audio messages in one chat into text. Take the ids from the "(media id: ...)" next to [voice note] or [audio] in get_messages ' +
          'or search_messages, and put every one you need from a chat in one call. A transcript is kept with its message, so asking again is free, and ' +
          'get_messages and search_messages show and find its words afterwards. Transcription runs on a speech model at Cloudflare, where this server runs.',
        inputSchema: {
          chat: z.string().describe('Chat jid, or a name that matches one chat'),
          message_ids: z.array(z.string()).min(1).max(20).describe('Media ids of the voice notes'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ chat, message_ids }) => {
        const c = await oneChat(chat);
        if ('error' in c) return text(c.error);
        const rows = await wa.transcribeAudio(c.jid, message_ids);
        return text(rows.map((r) => (r.ok ? `${r.id}: ${r.text}` : `${r.id}: could not transcribe (${r.text})`)).join('\n\n'));
      },
    );
  }

  server.registerTool(
    'unnamed_chats',
    {
      description:
        'One-to-one chats that are known only by phone number, busiest first, with the last thing the other person said so you can tell who they are. ' +
        "Use this when a person can't be found by name. Match the numbers against the user's contacts (for example with a Google Contacts or Gmail tool), " +
        'then save the names with set_contact_names. Most of these are one-off messages from people who were never saved, so it is normal for many to stay unnamed.',
      inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const rows = (await wa.unnamedChats(limit)) as Rows;
      if (!rows.length) return text('Every chat has a name.');
      const lines = rows.map((r) => {
        const said = r.last_theirs ? ` | they last said: "${oneLine(r.last_theirs, 120)}"` : '';
        return `${displayNumber(r.jid)} | ${r.messages} msgs | last ${when(r.last_ts)}${said}`;
      });
      return text(`${rows.length} chats known only by number (use the number as given with set_contact_names):\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'set_contact_names',
    {
      description:
        'Save names for phone numbers, so chats and group messages from them show a name instead of a number. ' +
        "Only save names you actually found, in the user's contacts or in the conversation itself. Never guess. " +
        'Numbers can be in any format (+972 52-421-9320, 052-421-9320) or the form shown by unnamed_chats. An empty name removes a saved name. ' +
        'This only changes how names display on this server. It sends nothing to WhatsApp.',
      inputSchema: {
        names: z
          .array(
            z.object({
              number: z.string().describe('Phone number in any format, or a jid'),
              name: z.string().describe('The name to show. Empty string removes a saved name.'),
            }),
          )
          .min(1)
          .max(200),
      },
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    async ({ names }) => {
      const rows: { jid: string; name: string }[] = [];
      const bad: string[] = [];
      for (const n of names) {
        const raw = n.number.trim();
        const jid = raw.includes('@') ? raw : toJid(raw, env.DEFAULT_COUNTRY_CODE);
        const name = n.name.trim().slice(0, 100);
        // a number or a masked placeholder isn't a name
        if (!jid || /∙/.test(name) || (name && /^[\d\s+-]*$/.test(name))) bad.push(raw);
        else rows.push({ jid, name });
      }
      const r = rows.length ? await wa.setNames(rows) : { saved: 0, removed: 0, withChat: 0 };
      const parts = [
        `Saved ${r.saved} name${r.saved === 1 ? '' : 's'}${r.removed ? `, removed ${r.removed}` : ''}. ${r.withChat} of ${rows.length} numbers have a chat here.`,
      ];
      if (bad.length) {
        parts.push(
          `Skipped ${bad.length} you gave that I couldn't use: ${bad.join(', ')}. A number needs a country code (or the server needs DEFAULT_COUNTRY_CODE set), and a name can't be a number.`,
        );
      }
      return text(parts.join(' '));
    },
  );

  server.registerTool(
    'link_status',
    {
      description: 'Is WhatsApp linked, when was the last pull, and how much is stored. Use this first if anything looks wrong.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const i = await wa.linkInfo();
      const dm = i.contact ? ` The operator is @${i.contact} on X.` : '';
      if (i.rejected) {
        return text(`Not linked. This history was larger than the service takes (${i.rejected.messages.toLocaleString()} messages; the limit is ${i.limits.messages ? `${i.limits.messages.toLocaleString()} messages` : `${i.limits.mb} MB`}), so it was not kept and the phone was unlinked. Nothing is stored.${dm}`);
      }
      if (!i.paired) return text(`Not linked. The owner needs to scan a QR code at ${origin}/setup.${i.messages ? ` The ${i.messages} messages already stored are kept.` : ''}`);
      const last = i.lastPull ? when(Math.floor(i.lastPull / 1000)) : 'never';
      const unnamed = i.unnamed ? ` ${i.unnamed} chats are known only by phone number (see unnamed_chats).` : '';
      return text(`Linked. Last pull ${last}. Stored: ${i.messages} messages across ${i.chats} chats.${unnamed} ${i.full ? ` This account has reached the size limit, so new messages are no longer being added.${dm}` : ''} To link a different phone or fix a broken session, call relink.`);
    },
  );

  server.registerTool(
    'relink',
    {
      description:
        'Unlink the current WhatsApp session and start over. Stored messages are kept. The owner must then open the returned URL and scan a QR code with their phone, which an agent cannot do for them. ' +
        'Use when link_status says not linked, or the session is broken, or the owner asks to relink or re-import history.',
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => {
      await wa.logout();
      return text(`Unlinked. Ask the owner to open ${origin}/setup and scan the QR code (WhatsApp > Settings > Linked Devices > Link a Device). History is re-imported on the new link; stored messages are kept.`);
    },
  );

  server.registerTool(
    'sync_now',
    {
      description: 'Force a pull of new messages from WhatsApp right now and report how many arrived.',
      inputSchema: {},
    },
    async () => {
      if (!(await wa.isPaired())) return text(`WhatsApp is not linked yet. Open ${origin}/setup to scan the QR code.`);
      const r = await wa.pull();
      const c = await wa.counts();
      return text(`Pulled ${r.added} new messages in ${(r.ms / 1000).toFixed(1)}s (${r.reason}). Store now holds ${c.messages} messages across ${c.chats} chats.`);
    },
  );

  return server;
}

export async function handleMcp(request: Request, env: Env, who: McpProps): Promise<Response> {
  // Stateless: no server-to-client stream (GET) and no session to end (DELETE). The spec's answer is 405.
  // Without it the SDK opens a stream that never sends, the request dies, and clients reconnect in a tight loop.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const wa = await unlockedStub(env, who);
  const server = buildServer(wa, env, new URL(request.url).origin, await wa.timezone());
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
