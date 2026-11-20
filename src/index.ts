/**
 * whatsapp-mcp - a read-only MCP server over your own WhatsApp history.
 *
 * OAuth (workers-oauth-provider) fronts /mcp. Approving a client means signing in (see auth.ts); if WhatsApp
 * isn't linked yet, the same flow continues into the pairing screen, so a first connection links the phone and
 * a later one just signs in. Each person's messages live in their own Durable Object, sealed with a key that
 * only their password can produce.
 */
import './platform/polyfills.js';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { WhatsAppStore } from './whatsapp/whatsapp-do.js';
import { handleMcp } from './mcp/server.js';
import { ownerHandler } from './web/routes.js';
import { seatRegistry, serverMode, signupLimitOf, type AuthEnv } from './account/auth.js';

export { WhatsAppStore };
export { Registry } from './account/registry.js';

export interface Env extends AuthEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional secret for machine access to /debug. 32+ random characters. */
  WA_PIN?: string;
  /** Shown on the privacy page as who runs this server. Optional. */
  OPERATOR_NAME?: string;
  /** Country code (digits, no +) for phone numbers given without one, e.g. "972". */
  DEFAULT_COUNTRY_CODE?: string;
  /** Workers AI. Turns on transcribe_audio, which runs voice notes through a speech model on Cloudflare. Optional. */
  AI?: Ai;
  /** Workers AI model for transcription. Optional; see DEFAULT_TRANSCRIBE_MODEL in transcribe.ts. */
  TRANSCRIBE_MODEL?: string;
}

/** What an agent's token carries: who, and the key that opens their data. Encrypted by the OAuth library under the token. */
export interface McpProps { userId: string; dek: string }

const oauth = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext & { props: McpProps }) => handleMcp(request, env, ctx.props) } as any,
  defaultHandler: ownerHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['whatsapp'],
  refreshTokenTTL: 10 * 365 * 24 * 60 * 60,
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauth.fetch(request, env, ctx),
  /**
   * Once a day, write the seat and waitlist counts, and yesterday's signups and deletions, to the log, where the operator (or their agent, through
   * Cloudflare's API) can read them without WA_PIN. Counts only.
   */
  async scheduled(_event: ScheduledController, env: Env) {
    if (serverMode(env) !== 'multi') return;
    const registry = seatRegistry(env);
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const yesterday = (await registry.days(3)).find((d) => d.day === day) ?? { day, joined: 0, left: 0 };
    console.log(JSON.stringify({ stats: { taken: await registry.count(), limit: signupLimitOf(env), waiting: await registry.waiting(), yesterday } }));
  },
};
