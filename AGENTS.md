# whatsapp-mcp (EngDawood fork)

A single-user, read-only MCP server over the owner's WhatsApp Business chats, running on the owner's Cloudflare Workers Paid account at `https://whatsapp-mcp.engdawood.workers.dev`. The owner's assistant (Meta Muse, Claude) uses it for an end-of-day summary, reminders about customers waiting on a reply, and notes about customers. Imported as one commit from [finereli/whatsapp-mcp](https://github.com/finereli/whatsapp-mcp) (MIT); `README.md` is the upstream manual plus a fork note, and is the reference for architecture, crypto and setup.

## Invariants

Hold these on every change:

- **Read-only to WhatsApp.** Tools read, search and keep notes on this server. Sending, marking read and editing on WhatsApp stay out; the session runs with `markOnlineOnConnect: false` so the phone keeps notifying.
- **Single-user mode.** Sign-in is the `WA_OWNER_PASSWORD` secret; `OPEN_SIGNUP` stays unset, so the finereli login service is never used.
- **Everything the owner owns is sealed** with the account key (`Vault`): message text, names, notes. A new table that holds user content stores a keyed hash (`vault.pid`) for anything it indexes and a sealed blob for the rest, with its own AAD letter (see the constants at the top of `src/store/store.ts`).
- **Logs carry counts and timings only.** Message content, names and numbers stay out of `console.log` and the `/debug` events.

## Names that look renamable but aren't

- Secrets are `WA_OWNER_PASSWORD` and `WA_PIN` (upstream: `OWNER_PASSWORD`, `PIN`).
- The KV namespace is named `WA_OAUTH_KV` in the account, but its **binding** stays `OAUTH_KV`: `@cloudflare/workers-oauth-provider` reads `env.OAUTH_KV` and has no option to change it.
- `wrangler.jsonc` is this deployment's real config (KV id, `TIMEZONE=Asia/Riyadh`, `DEFAULT_COUNTRY_CODE=966`) and is committed; there is no `wrangler.local.jsonc`.

## Layout

`src/` is split by concern: `account/` (keys, sign-in, seats), `whatsapp/` (the Durable Object, the open `Account`, the WhatsApp session and wire format), `store/` (SQLite, names, search filters), `history/` (the reader both front ends use), `mcp/` (tools), `web/` (pages and the chat viewer), `platform/` (workerd shims). The README's file table lists each file.

- **Keyed vs keyless.** `WhatsAppStore` holds only what needs no key. Everything keyed lives on `Account`, which only `open(key)` returns; there is no "locked" mode to forget about.
- **Read rules live in `src/history/history.ts`.** Which chat a name means, when a read pulls first, default windows (14 days unanswered, 7 days activity) and paging cursors are decided there. The MCP tools and the web chat API format results; they don't re-decide these.
- **Names live in `src/store/names.ts`.** Chat and sender names use one ranking; ask it for `{ name, numberOnly }` rather than parsing a label.
- **WhatsApp's wire format lives in `src/whatsapp/translate.ts`.** New message kinds are added there as events; the store only applies events.

## Behaviour that lives in more than one place

- **Search tokens.** `fold` and `core` in `src/store/search-index.ts` decide what a word is (Arabic normalisation, definite-prefix stripping). Any change to them, or to `entriesOf`/`needsOf`, bumps `INDEX_VERSION` so existing stores rebuild their filters on the next search; the query side (`matches`/`hasTerm` in `src/store/store.ts`) must apply the same `core`.
- **Time.** `TIMEZONE` wins over the zone saved at sign-up (`WhatsAppStore.timezone`). Day windows for tools come from `src/history/zone.ts`.
- **Waiting on a reply.** `unanswered` and `digest` in `src/store/store.ts` share one rule: the owner's reaction counts as a reply, the customer's reaction is not a new message, groups never wait.
- **Agent guidance.** The MCP `instructions` string and each tool's `description` in `src/mcp/server.ts` are what Muse and Claude read to decide which tool to call. When adding or changing a tool, update them there; that string is the single source of truth for how assistants use the server.

## Making a change

1. Work on a feature branch; the owner merges to `main` and deploys with `npm run deploy`.
2. `npm ci` (not `npm install`): `postinstall` regex-patches the pinned `whatsapp-rust-bridge`, and a different version breaks it.
3. Add tests beside the code they cover: `test/store.test.mts` runs the real `Store` on `node:sqlite`; `test/history.test.mts` checks the reader's rules over a real Store; `test/names.test.mts` and `test/translate.test.mts` cover those modules alone; `test/digest-render.test.mts` drives the real MCP server in-process through `buildServer` over a History reader, which is how tool output is checked. `npm test` runs every `test/*.test.mts`; `cloudflare:workers` is shimmed in `test/ts-resolve.mjs`.
4. Done means all three are green: `npm test`, `npm run typecheck`, and `npx wrangler deploy --dry-run --outdir /tmp/dryrun` (proves the bundle builds).
5. README tool table and this file updated if a tool, secret, or invariant changed.

## Upstream

There is no shared history with upstream. To take an upstream fix: `git remote add upstream https://github.com/finereli/whatsapp-mcp.git` if missing, `git fetch upstream`, read `git log upstream/main` since `b49d494` (the imported commit), and port the change by hand, keeping the renames and additions above.
