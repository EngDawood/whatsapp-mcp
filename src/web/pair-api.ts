/**
 * The calls behind the pairing page (/pair/*), signed in with the page token the dashboard carries. Linking a phone,
 * the code-instead-of-QR path, unlinking, deleting everything, and finishing an MCP client's sign-in once linked.
 */
import { unlockAccount, seatRegistry, isSingleUser, type Identity } from '../account/auth.js';
import { json, unb64 } from './http.js';
import { pageIdentity } from './guard.js';
import { noteSeats } from './seats.js';
import type { Env, McpProps } from '../index.js';

export async function completeOauth(env: Env, oauth: unknown, who: Identity) {
  const props: McpProps = { userId: who.userId, dek: who.dek.toString('base64') };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth as any, userId: who.userId, scope: ['whatsapp'], metadata: {}, props,
  });
  return redirectTo;
}

export async function pairApi(request: Request, env: Env, path: string): Promise<Response> {
  const who = await pageIdentity(request, env);
  if (!who) return json({ error: 'unauthorized' }, 401);
  let wa;
  try { wa = await unlockAccount(env, who); } catch (e: any) { return json({ error: e?.message ?? 'cannot open account' }, 403); }
  const single = isSingleUser(env);
  if (path === '/pair/status') return json(await wa.pairStatus());
  if (path === '/pair/start' && request.method === 'POST') {
    if (!(await wa.isPaired())) await wa.startPairing();
    return json({ ok: true });
  }
  if (path === '/pair/relink' && request.method === 'POST') {
    await wa.logout();
    return json({ ok: true });
  }
  if (path === '/pair/delete' && request.method === 'POST') {
    await wa.destroy();
    if (!single) {
      noteSeats(await seatRegistry(env).release()); // the seat goes back to the pool
    }
    // agents that were connected can't reach a store that no longer exists
    for (let cursor: string | undefined; ; ) {
      const page = await env.OAUTH_PROVIDER.listUserGrants(who.userId, { cursor });
      for (const g of page.items) await env.OAUTH_PROVIDER.revokeGrant(g.id, who.userId);
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return json({ ok: true }, 200);
  }
  if (path === '/pair/code' && request.method === 'POST') {
    const { phone } = (await request.json()) as { phone: string };
    try { return json({ code: await wa.requestPairingCode(phone) }); }
    catch (e: any) { return json({ error: e?.message ?? 'failed' }, 500); }
  }
  if (path === '/pair/finish' && request.method === 'POST') {
    const { req } = (await request.json()) as { req: string };
    return json({ redirectTo: await completeOauth(env, unb64(req), who) });
  }
  return json({ error: 'not found' }, 404);
}
