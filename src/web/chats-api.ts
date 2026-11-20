/**
 * The calls behind the chat viewer (/chats). Reads only, plus "check WhatsApp now". A web adapter over the History
 * reader: the read rules (which chat, how far back, paging, when to pull) are the reader's, the JSON shape is ours.
 * Every response is for the signed-in person alone.
 */
import { connect } from '../history/connect.js';
import { FRESH } from '../history/history.js';
import { json } from './http.js';
import { browserIdentity } from './guard.js';
import type { Env } from '../index.js';

/** Plain pictures, audio and video show in the page; anything else a chat sent only ever downloads. */
const MEDIA_INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/[\w.+-]+|video\/[\w.+-]+)$/;

export async function chatsApi(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await browserIdentity(request, env);
  if (!who) return json({ error: 'signed out' }, 401);
  // the page always sends this header; a form or link on another site can't, so it can't trigger a pull
  if (request.headers.get('x-wa') !== '1' && url.pathname !== '/api/media') return json({ error: 'missing header' }, 400);
  const arg = (k: string) => url.searchParams.get(k) ?? '';
  const int = (k: string, def: number, max: number) => Math.max(1, Math.min(max, Number(arg(k)) || def));
  try {
    const { account, history: h } = await connect(env, who);
    switch (url.pathname) {
      case '/api/chats': {
        const [chats, paired, lastPull] = await Promise.all([h.chatList(arg('q') || undefined, int('limit', 1000, 5000)), h.isPaired(), h.lastPull()]);
        return json({ chats, paired, lastPull });
      }
      case '/api/messages': {
        if (!arg('chat')) return json({ error: 'chat is required' }, 400);
        const page = await h.messages(arg('chat'), { limit: int('limit', 60, 300), before: arg('before') || undefined });
        return json({ messages: page.messages, more: Boolean(page.older), older: page.older ?? null });
      }
      case '/api/context': {
        const r = await h.context(arg('chat'), arg('id'), 30, 30);
        return r ? json(r) : json({ error: 'no such message' }, 404);
      }
      case '/api/search': {
        const q = arg('q').trim().slice(0, 200);
        if (!q) return json({ hits: [], limit: 0 });
        const limit = 100;
        const { hits } = await h.search([q], { chat: arg('chat') || undefined, limit });
        return json({ hits: hits[0], limit });
      }
      case '/api/unanswered':
        return json({ rows: (await h.unanswered({ limit: 100 })).rows });
      case '/api/sync': {
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
        const r = await h.refresh(FRESH.button);
        return json({ added: r.added, paired: r.linked, ...(r.error ? { error: r.error } : {}) });
      }
      case '/api/media': {
        const r = await account.fetchMedia(arg('chat'), arg('id'));
        if (!r.ok) return new Response(r.error, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        const mime = r.mime.split(';')[0].trim().toLowerCase();
        // a file someone sent you is not trusted: only plain pictures, audio and video show in the page, the rest downloads,
        // and nothing served from here can run script on this origin
        const inline = MEDIA_INLINE.test(mime) && !arg('download');
        const name = (r.name ?? `${r.kind}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
        return new Response(Buffer.from(r.data, 'base64'), {
          headers: {
            'content-type': inline ? mime : 'application/octet-stream',
            'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=3600',
          },
        });
      }
    }
    return json({ error: 'not found' }, 404);
  } catch (e: any) {
    return json({ error: e?.message ?? 'failed' }, 500);
  }
}
