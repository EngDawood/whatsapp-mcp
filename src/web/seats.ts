/** Whether every seat is taken, cached briefly per isolate. Only matters on a hosted (many-person) server. */
import { seatRegistry, serverMode } from '../account/auth.js';
import type { Env } from '../index.js';

/**
 * Is every seat taken? The front page asks on each visit, so the answer is kept for 30 seconds per isolate.
 * Signups and deletions in this isolate refresh it straight away.
 */
let seatCache: { at: number; taken: number } | null = null;
export async function seatsFull(env: Env, limit: number): Promise<boolean> {
  if (!limit || serverMode(env) !== 'multi') return false;
  if (!seatCache || Date.now() - seatCache.at > 30_000) seatCache = { at: Date.now(), taken: await seatRegistry(env).count() };
  return seatCache.taken >= limit;
}
export const noteSeats = (taken: number) => { seatCache = { at: Date.now(), taken }; };
