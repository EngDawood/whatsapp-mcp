/**
 * Wiring for a request: open the person's account and put the History reader in front of it. Both front ends (MCP
 * and the web chat viewer) start here, so they read through the same rules.
 *
 * The casts are the one place where an RPC stub stands in for the in-process interfaces: the stub has the same methods,
 * answering through promises.
 */
import { unlockAccount, type Identity } from '../account/auth.js';
import { History, type Live, type Records } from './history.js';
import type { Env } from '../index.js';
import type { Store } from '../store/store.js';

export async function connect(env: Env, who: Identity | { userId: string; dek: string }) {
  const account = await unlockAccount(env, who);
  const [store, tz] = await Promise.all([account.history(), account.timezone()]);
  const history = new History(store as unknown as Records, account as unknown as Live, tz, { countryCode: env.DEFAULT_COUNTRY_CODE });
  return { account, store: store as unknown as Store, history };
}
