/**
 * Who is asking, for the browser routes. There are two ways a browser proves it is the owner: the session cookie
 * (pages and the chat viewer) and the short-lived page token the dashboard sends as a bearer header (pairing calls).
 * Both carry the key, so both come back as an Identity. The operator's /debug uses its own PIN and no key.
 */
import { readSession, SESSION_COOKIE, type Identity } from '../account/auth.js';
import { bearer, cookieValue } from './http.js';
import type { Env } from '../index.js';

/** The signed-in browser, from its session cookie. */
export const browserIdentity = (request: Request, env: Env): Promise<Identity | null> => readSession(env, cookieValue(request, SESSION_COOKIE));

/** The dashboard page, from the token it was handed when it loaded. */
export const pageIdentity = (request: Request, env: Env): Promise<Identity | null> => readSession(env, bearer(request));

/** Constant-time check of the operator's PIN (WA_PIN, 32+ characters) for /debug. */
export function pinOk(request: Request, env: Env) {
  const sent = request.headers.get('x-pin');
  if (!sent || !env.WA_PIN || env.WA_PIN.length < 32 || sent.length !== env.WA_PIN.length) return false;
  let diff = 0;
  for (let i = 0; i < sent.length; i++) diff |= sent.charCodeAt(i) ^ env.WA_PIN.charCodeAt(i);
  return diff === 0;
}
