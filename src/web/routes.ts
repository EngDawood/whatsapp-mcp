/**
 * The pages and sign-in flow a person sees in the browser, and the operator's /debug. The pairing calls are in
 * pair-api.ts and the chat viewer's calls in chats-api.ts; the MCP endpoint is wired in index.ts.
 */
import { consentPage, fullPage, loginPage, pairPage, waitlistDonePage, waitlistErrorPage } from './pages.js';
import { limitsOf } from '../account/limits.js';
import { notify } from '../account/notify.js';
import { xHandle } from './ui.js';
import { APPLE_TOUCH_ICON, FAVICON_32, FAVICON_SVG, SOCIAL_CARD } from './brand.js';
import { landingPage, llmsTxt } from './landing.js';
import { privacyPage } from './privacy.js';
import { tosPage } from './tos.js';
import { chatsPage } from './chats-page.js';
import { chatsApi } from './chats-api.js';
import { pairApi, completeOauth } from './pair-api.js';
import { b64, cookieValue, html, json, plain, zone } from './http.js';
import { noteSeats, seatsFull } from './seats.js';
import { browserIdentity, pinOk } from './guard.js';
import {
  accountStub, signupLimitOf, COOKIE_SECONDS, isSingleUser, mintSession, NOT_SET_UP, seatRegistry, serverMode, PAGE_SECONDS, peekPending, sessionCookie,
  loginServiceUrl, redeemLoginCode, signIn, signInWithLogin, startSignIn, takePending,
  type Identity,
} from '../account/auth.js';
import type { Env } from '../index.js';

const LOGIN_COOKIE = 'wa_login';
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const WAITLIST_SOURCES = new Set(['landing', 'sign-in', 'retry']);




/** Signed in. Remember this browser, then finish the MCP grant if WhatsApp is linked, else go on to pairing. */
async function proceed(env: Env, pendingId: string, who: Identity): Promise<Response> {
  const pending = await takePending(env, pendingId);
  if (!pending) return plain('Sign-in expired', 'Start again from the app that asked.', 400);
  const cookie = await mintSession(env, who, COOKIE_SECONDS);
  const remember = (res: Response) => {
    const out = new Response(res.body, res);
    out.headers.append('set-cookie', sessionCookie(cookie, COOKIE_SECONDS));
    return out;
  };
  if (pending.oauth && (await accountStub(env, who.userId).isPaired())) {
    return remember(new Response(null, { status: 302, headers: { location: await completeOauth(env, pending.oauth, who) } }));
  }
  const pageToken = await mintSession(env, who, PAGE_SECONDS);
  return remember(html(pairPage(pageToken, pending.oauth ? b64(pending.oauth) : null)));
}

/** Tell the operator when signups get close to the cap, and when they hit it. */
async function milestone(env: Env, taken: number, limit: number) {
  if (!limit) return;
  if (taken === limit) await notify(env, 'whatsapp-mcp is full', `All ${limit} seats are taken. New people now see the waitlist instead of a signup, until someone leaves or you raise SIGNUP_LIMIT.`);
  else if (limit >= 5 && taken === Math.ceil(limit * 0.8)) await notify(env, 'whatsapp-mcp is filling up', `${taken} of ${limit} seats are taken.`);
}

export const ownerHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const p = url.searchParams.get('p') ?? '';
    const single = isSingleUser(env);
    const hosted = serverMode(env) === 'multi';
    const contact = xHandle(env.CONTACT_X);
    const signupLimit = signupLimitOf(env);

    // Someone signed in lands on their dashboard. Everyone else gets the front page.
    if (path === '/') {
      const who = await browserIdentity(request, env);
      return html(who ? pairPage(await mintSession(env, who, PAGE_SECONDS), null) : landingPage(url.origin, hosted, { signupLimit, maxMessages: limitsOf(env).messages, contact, full: await seatsFull(env, signupLimit) }));
    }
    // The logo, and the plain-text page an assistant reads when someone pastes "set this up for me".
    const asset = (body: BodyInit, type: string) => new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } });
    if (path === '/favicon.svg') return asset(FAVICON_SVG, 'image/svg+xml');
    if (path === '/favicon-32.png' || path === '/favicon.ico') return asset(FAVICON_32, 'image/png');
    if (path === '/apple-touch-icon.png') return asset(APPLE_TOUCH_ICON, 'image/png');
    if (path === '/og.png') return asset(SOCIAL_CARD, 'image/png');
    if (path === '/llms.txt') return new Response(llmsTxt(url.origin, hosted, await seatsFull(env, signupLimit)), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    if (path === '/privacy') return html(privacyPage(env.OPERATOR_NAME, hosted, contact));
    if (path === '/tos') return html(tosPage(env.OPERATOR_NAME, hosted, contact));
    if (path === '/signout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie('', 0) } });

    // An MCP client wants in: show who is asking, then send the person to sign in.
    if (path === '/authorize') {
      const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(oauth.clientId);
      return html(consentPage(client?.clientName ?? 'An app', await startSignIn(env, url.origin, { oauth }), await seatsFull(env, signupLimit), signupLimit));
    }
    if (path === '/setup') {
      return (await browserIdentity(request, env))
        ? Response.redirect(`${url.origin}/`, 302)
        : Response.redirect(await startSignIn(env, url.origin, {}), 302);
    }

    if (path === '/login') {
      if (serverMode(env) === 'unset') return plain('Not set up', NOT_SET_UP, 503);
      if (!(await peekPending(env, p))) return plain('Sign-in expired', 'Start again from the setup page.', 400);
      if (!single) {
        // Many people: Google, through the login service. The cookie ties the way back to this browser, so a
        // link someone else started can't sign this one into their account.
        const res = new Response(null, { status: 302, headers: { location: loginServiceUrl(env, url.origin, p) } });
        res.headers.append('set-cookie', `${LOGIN_COOKIE}=${p}; Path=/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
        return res;
      }
      const page = (error?: string) => loginPage(url.pathname + url.search, { error });
      if (request.method !== 'POST') return html(page());
      const r = await signIn(env, { password: String(((await request.formData()).get('password')) ?? '') }, zone(request));
      return r.ok ? proceed(env, p, r.who) : html(page(r.error), r.status);
    }

    // The login service sends the browser back here with a one-time code.
    if (path === '/auth/callback') {
      if (serverMode(env) !== 'multi') return plain('Not available', 'This server does not sign in with Google.', 404);
      if (cookieValue(request, LOGIN_COOKIE) !== p || !(await peekPending(env, p))) return plain('Sign-in expired', 'Start again from the app that asked.', 400);
      const code = url.searchParams.get('finereli_code');
      if (!code) return plain('Sign-in cancelled', 'Start again from the app that asked.', 400);
      const person = await redeemLoginCode(env, code);
      if (!person) return plain('Sign-in failed', 'The login service did not accept that sign-in. Start again from the app that asked.', 400);
      const r = await signInWithLogin(env, person, zone(request));
      if (!r.ok) {
        if (!r.full) return plain('Sign-in failed', r.error, r.status);
        noteSeats(signupLimit);
        return html(fullPage(signupLimit, contact, person.email), 503);
      }
      if (r.seats) { noteSeats(r.seats.taken); await milestone(env, r.seats.taken, r.seats.limit); }
      return proceed(env, p, r.who);
    }

    // The chat viewer, and the read-only calls behind it. Signed in with the dashboard's cookie.
    if (path === '/chats') {
      if (!(await browserIdentity(request, env))) return Response.redirect(`${url.origin}/setup`, 302);
      const res = html(chatsPage());
      res.headers.set('x-frame-options', 'DENY');
      res.headers.set('referrer-policy', 'no-referrer');
      return res;
    }
    if (path.startsWith('/api/')) return chatsApi(request, env, url);

    if (path.startsWith('/pair/')) return pairApi(request, env, path);

    // Someone who couldn't get a seat leaves an email. Only the operator sees the list (/debug?u=waitlist).
    if (path === '/waitlist' && request.method === 'POST' && hosted) {
      const form = await request.formData();
      if (String(form.get('website') ?? '')) return html(waitlistDonePage(true, contact)); // the field people can't see: a bot
      const email = String(form.get('email') ?? '').trim().toLowerCase();
      if (email.length > 254 || !EMAIL.test(email)) return html(waitlistErrorPage(contact), 400);
      const source = String(form.get('source') ?? '');
      const r = await seatRegistry(env).join(email, WAITLIST_SOURCES.has(source) ? source : 'landing');
      return html(waitlistDonePage(r.added, contact));
    }

    // What a deployment's operator can see without anyone's key: whether a session is running, and its log.
    if (path === '/debug') {
      if (!pinOk(request, env)) return new Response('unauthorized', { status: 401 });
      const registry = seatRegistry(env);
      if (url.searchParams.get('u') === 'seats') return json({ taken: await registry.count(), limit: signupLimit, waiting: await registry.waiting() });
      if (url.searchParams.get('u') === 'signups') return json(await registry.days());
      if (url.searchParams.get('u') === 'waitlist') {
        const email = url.searchParams.get('remove');
        if (email && request.method === 'POST') return json({ removed: await registry.unlist(email.toLowerCase()) });
        return json(await registry.waitlist());
      }
      return json(await accountStub(env, url.searchParams.get('u') ?? 'owner').debug());
    }

    return new Response('Not found', { status: 404 });
  },
};

