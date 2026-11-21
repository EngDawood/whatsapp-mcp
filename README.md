# whatsapp-mcp

A read-only MCP server over my WhatsApp Business chats. It runs on my Cloudflare Workers Paid account at `https://whatsapp-mcp.engdawood.workers.dev`, and my assistants (Meta Muse, Claude) use it for an end-of-day summary, reminders about customers waiting on a reply, and notes about customers.

The server is a linked device, like WhatsApp Web. It reads and searches the history and keeps notes on its own side. It cannot send, mark as read, edit or delete anything on WhatsApp.

## How it works

The phone stays the source of truth. The server does not stay connected to WhatsApp: when an assistant reads and the stored copy is more than 30 minutes old, it logs in, collects whatever WhatsApp queued since last time, writes it to its own database and disconnects after a few quiet seconds (60 seconds at most). The web page's refresh button uses a 5-minute window, and `sync_now` pulls on demand. The windows are long on purpose: each pull is a fresh login from a Cloudflare IP, and fewer logins keep the business number's risk low.

Everything lives in one Durable Object's SQLite database, sealed with a key that comes from my password. The session connects with `markOnlineOnConnect: false`, so the phone keeps showing notifications.

## What it guarantees, and what it doesn't

**It only reads.** No tool sends, edits or deletes anything in WhatsApp.

**Stored data is encrypted at rest.**
- The account has a random 32-byte data key. It seals everything I own: message text, chat and contact names, saved names, notes and WhatsApp's session keys.
- The data key is stored only wrapped by my password (PBKDF2-SHA256, 600,000 rounds run as six chained passes of 100,000, then AES-256-GCM). There is no master key and no recovery key. Neither Cloudflare nor someone who copies the database can read it without the password.
- Phone numbers and chat ids are replaced by keyed hashes, so the database can sort and group without knowing who anyone is. Timestamps, message types, which side sent each message and rough message lengths stay readable.
- Search uses a keyed filter per block of about 128 messages (see "Searching encrypted messages"). Without the key it reveals only roughly how many distinct words a block holds.
- After sign-in the data key travels inside the OAuth token the assistant holds and the browser session, each encrypted under that token. The server stores nothing that opens the data on its own.

**It is not end-to-end encryption.**
- While a request runs, the server has the key in memory and works with messages in plain text.
- Whatever an assistant reads goes to the company that runs the assistant.
- Files sent by customers can contain instructions aimed at the assistant (prompt injection). The server can't send anything, but other tools the assistant has can, so treat what is inside customer files as untrusted.

**Lose the password and the stored copy is gone.** Nobody can reset it. The messages are still in WhatsApp: relink and import what WhatsApp sends.

**Delete everything.** "Delete my data" on the dashboard unlinks WhatsApp, erases messages, names, notes, keys and the account, and disconnects every assistant.

**WhatsApp discourages this.** The server speaks the WhatsApp Web protocol through Baileys, an unofficial library, which WhatsApp's terms don't allow. Bans mostly hit sending (bulk, cold outreach, status uploads from servers); a read-only device that logs in rarely is in the lowest-risk group, but the risk is not zero and Meta publishes no thresholds. To keep it low:
- Keep it read-only. Never add sending, read receipts or presence.
- Keep logins rare (the 30-minute window above).
- Relink only when needed; each QR pairing registers a new device.
- Keep the phone online and the Business app updated. Linked devices are dropped after about 14 days without the phone.
- Keep a chat backup on the phone.

**The people in the chats didn't agree to this.** Their messages are in the copy too.

## Setup

What this deployment already has: a Workers Paid plan, the KV namespace, and the secrets. To redeploy from a fresh machine:

```sh
git clone https://github.com/EngDawood/whatsapp-mcp
cd whatsapp-mcp
npm ci            # not npm install: postinstall patches the pinned Baileys bridge
npm run deploy
```

From scratch on a new account:

```sh
# 1. A store for sign-in tokens. Put the id it prints into wrangler.jsonc (binding stays OAUTH_KV).
npx wrangler kv namespace create WA_OAUTH_KV

# 2. The password that locks the data. 12+ characters.
npx wrangler secret put WA_OWNER_PASSWORD

# 3. Optional: 32+ random characters to turn on /debug.
npx wrangler secret put WA_PIN

# 4. Deploy.
npm run deploy
```

Then:

1. **Link WhatsApp.** Open the Worker URL, sign in with the password, and scan the QR code from WhatsApp (Settings, Linked Devices, Link a Device). On the phone itself, use the phone number option instead. The first link imports history; the page shows progress and can be closed.
2. **Connect an assistant.** Point the MCP client at `https://whatsapp-mcp.engdawood.workers.dev/mcp` and sign in with the password when asked. In Claude Code:

   ```sh
   claude mcp add --transport http whatsapp https://whatsapp-mcp.engdawood.workers.dev/mcp
   ```

   `/llms.txt` is a plain-text page written for assistants: where the endpoint is and what the person has to do.

The first sign-in with `WA_OWNER_PASSWORD` creates the account. After that the account's own password counts, so changing the secret later does nothing.

Workers Paid is required: the first history import needs more CPU than the free plan allows, and `wrangler.jsonc` raises `cpu_ms` to 300,000.

## Things to know

**Syncing happens when an assistant asks.** There is no scheduled pull, because the data key only exists while someone is signed in. WhatsApp queues messages for a linked device for a limited time, so a server nobody uses for weeks may need a relink and re-import.

**Search reads a block per match, not the whole history.** Each block of about 128 messages carries a keyed filter of the words it can't contain, and a search decrypts only the blocks that might match. Several queries share one pass, so `search_messages` takes a list.

**Search is exact words.** Whole words, case and accents ignored. Arabic is matched the way people write it: diacritics and tatweel dropped, أ إ آ as ا, ى as ي, ة as ه, Arabic-Indic digits as 0-9, and the prefixes ال, بال, كال and لل stripped, so الطلب and طلب find each other. Several words must all appear, "quoted words" must appear together in order, and a trailing `*` matches word starts. Not fuzzy, no stemming.

**You get what WhatsApp sends.** The first link imports whatever history WhatsApp hands a new device, once per link. Relinking keeps stored messages and fills in what is missing.

**Some chats show as phone numbers.** WhatsApp doesn't give a linked device every contact name. Ask the assistant to find names for unnamed chats: it calls `unnamed_chats`, matches the numbers against contacts with a tool it already has, and saves them with `set_contact_names`. The server never connects to a contacts service itself.

**Media is fetched when asked for, never stored.** Photos, voice notes, videos, documents and stickers appear as labels with a media id. `get_media` downloads the encrypted file from WhatsApp's CDN, decrypts it in memory and hands it to the assistant; only what it takes to fetch it again is kept. Files over 10 MB are refused. WhatsApp keeps files for a few weeks; after that the phone is asked to upload the file again, which works while it is online and still has it.

**Voice notes can be transcribed.** `transcribe_audio` runs voice notes through Whisper (`@cf/openai/whisper-large-v3-turbo`, language detected automatically) on Workers AI, through the `AI` binding in `wrangler.jsonc`. The audio goes to Cloudflare's model and nowhere else, and only when an assistant asks. A transcript is kept sealed with its message, so `get_messages` shows it and `search_messages` finds its words; asking again is free. It costs about $0.0005 a minute of audio, billed to the Cloudflare account. `TRANSCRIBE_MODEL` names another model if needed.

**Reactions show up as replies.** A reaction appears at the time it was sent, as `[reacted 🙏 to "the message"]`. The owner's reaction counts as a reply; a customer's reaction is not a new message.

**Notes and reminders.** `save_note` keeps a sealed note on a chat, optionally with a day to be reminded. Due reminders show in `daily_digest` and `get_messages`. Nothing goes to WhatsApp.

**Time.** All times are `Asia/Riyadh` (`TIMEZONE`), which wins over the zone saved at sign-up. Numbers saved without a country code get `966` (`DEFAULT_COUNTRY_CODE`).

**Relinking.** If the phone says the device was removed, ask the assistant to run `relink`, or open `/setup` and choose "Unlink and scan again". Stored messages are kept.

## Chat viewer

`/chats` is a read-only, WhatsApp-style view of the stored history in the browser: the chat list, conversations with replies, inline photos and voice notes, search across every message, and a "Waiting on me" tab. It uses the dashboard sign-in, a 14-day cookie, so anyone holding that browser session can read the messages. Sign out on shared machines.

## Tools

| Tool | What it does |
| --- | --- |
| `list_chats` | Chats, most recent first. Filter by name or number. |
| `get_messages` | Read one chat. Page back or forward by date or cursor. |
| `search_messages` | Search across everything or one chat. Takes a list of queries and answers them in one pass. |
| `get_context` | The messages just before and after one message, e.g. a search hit. |
| `chat_activity` | Who talked how much over a period (default 7 days): busiest chats, or busiest people in one chat. Counts only. |
| `unanswered_chats` | Direct chats where the customer wrote last and hasn't had a reply (default 14 days). Groups never wait. |
| `daily_digest` | One day (or up to 7) in one call for an end-of-day summary: reminders due, per-chat messages in and out with open notes, who is still waiting and since when. |
| `save_note` | Remember something about a customer, optionally with a reminder day (`remind_on`). |
| `list_notes` | Saved notes, soonest reminder first; filter by chat or day due. |
| `update_note` | Mark a note done, change its text or reminder day, or delete it. |
| `get_media` | Fetch the photo, voice note, video or document behind a message. |
| `transcribe_audio` | Voice notes to text, kept with the message. Up to 20 per call. |
| `unnamed_chats` | Chats known only by number, busiest first, with the last thing the other person said. |
| `set_contact_names` | Save names for phone numbers. Names stick to the number, so they show in groups too. |
| `sync_now` | Pull new messages right now. |
| `link_status` | Is it linked, when did it last pull, how much is stored. |
| `relink` | Unlink and start over. A human scans the new QR code. |

The MCP `instructions` string and each tool's `description` in `src/mcp/server.ts` are what assistants read to choose a tool. Change them there when a tool changes.

---

# For agents, and anyone changing the code

`AGENTS.md` holds the rules every change must keep (read-only, single-user, everything sealed, no content in logs) and where each piece of shared behaviour lives. Read it first. This part explains how the code works.

## Shape of the thing

```
MCP client ──OAuth──> Worker (src/index.ts)
                        ├─ /mcp ──────> src/mcp/server.ts: tools, one McpServer per request
                        └─ /, /setup, /login, /authorize, /chats, /api/*, /pair/*, /debug  (src/web/routes.ts)
                                   │ RPC: open(key), then the call
                                   v
              WhatsAppStore (Durable Object, src/whatsapp/whatsapp-do.ts, named "owner")
                ├─ keyless: account record, login throttling, flags
                └─ Account (src/whatsapp/account.ts), only from open(key)
                     ├─ SQLite: sealed auth keys, messages, chats, contacts, notes
                     └─ Baileys socket, opened only during a session (pairing or pull)
                                   │ WebSocket
                                   v
                              WhatsApp servers
```

The Worker is stateless apart from the KV namespace (OAuth tokens, pending sign-ins, browser sessions). `src/history/history.ts` is the reader both front ends (MCP tools and the web chat API) use, so read rules are decided once.

## How the key travels

`src/account/vault.ts` is the only code that touches keys.

1. **First sign-in.** `createAccount` makes a random data key, stretches the password with PBKDF2 into a key-encryption key and an auth key, wraps the data key under the first and stores a hash of the second as a verifier.
2. **Sign-in.** `openAccount` checks the verifier and unwraps the data key. Wrong passwords are throttled in the Durable Object: five in a row, then longer waits. A missing account spends the same time as a wrong password.
3. **Carrying it.** The data key goes into the OAuth grant's `props`, which `@cloudflare/workers-oauth-provider` encrypts under each token. The browser gets a random session token filed in KV with the data key sealed under a key derived from the token, so KV alone can't open it.
4. **Using it.** Each call opens the account with `open(key)`, which checks the key against a sealed canary and returns an `Account`. There is no "locked" mode: anything that needs the key lives on `Account`. The key is kept in memory only.
5. **Sealing.** `Vault.seal` is AES-256-GCM with a random nonce and an AAD letter naming what the blob is. `Vault.pid` is an HMAC that turns a jid into an opaque, stable id.

Don't log a key, put one in a URL, or store one anywhere that outlives a session.

## Files

| File | Job |
| --- | --- |
| `src/index.ts` | Entry point: `Env` bindings, OAuth provider wiring (`/mcp` to the MCP server, the rest to `web/routes.ts`). |
| `src/account/vault.ts` | Keys: password to account record, sealing and opening, pseudonymous ids, tokens that carry a key. |
| `src/account/auth.ts` | Sign-in and the KV-backed sessions that carry the key. |
| `src/account/limits.ts`, `registry.ts`, `notify.ts` | Mode detection and the upstream multi-user code (caps, seats, alert email). Off in this deployment. |
| `src/whatsapp/whatsapp-do.ts` | The Durable Object, keyless part. `open(key)` returns the `Account`. |
| `src/whatsapp/account.ts` | The open `Account`: Baileys sessions (`runSession`, `pull`, `pullIfStale`, pairing), media, transcripts, logout. |
| `src/whatsapp/translate.ts` | WhatsApp's wire format to plain events (message, reaction, edit, delete), media refs, quoted replies. Pure. New message kinds go here. |
| `src/whatsapp/auth-state.ts` | Baileys auth state on the Durable Object's SQLite, sealed. |
| `src/whatsapp/media.ts`, `transcribe.ts` | Download and decrypt files from WhatsApp's CDN; voice notes to text on Workers AI. |
| `src/whatsapp/phone.ts` | Phone numbers in any format to WhatsApp jids. |
| `src/store/store.ts` | Schema, applying events, every query, search, notes, `unanswered` and `digest`, the legacy migration. |
| `src/store/names.ts` | Who a chat or sender is: one ranking, returns `{ name, numberOnly }`. |
| `src/store/search-index.ts` | Word folding (`fold`, `core`, Arabic normalisation) and the keyed Bloom filters. |
| `src/history/history.ts` | The reader: which chat a name means, when to pull (`FRESH`), default windows (`WINDOW`), paging cursors. |
| `src/history/connect.ts`, `zone.ts` | Opening an account behind a reader for one request; day windows in `TIMEZONE`. |
| `src/mcp/server.ts` | The MCP tools and the `instructions` string assistants read. |
| `src/web/routes.ts`, `pair-api.ts`, `chats-api.ts`, `guard.ts` | Pages and sign-in, the pairing calls, the chat viewer's API, who is asking. |
| `src/web/chats-page.ts` | The chat viewer at `/chats`. |
| `src/web/pages.ts`, `landing.ts`, `privacy.ts`, `tos.ts`, `ui.ts`, `brand.ts`, `http.ts`, `seats.ts` | HTML and helpers. `ui.ts` has the shared design tokens. |
| `src/platform/ws-shim.ts`, `lru-shim.ts`, `polyfills.ts` | Make Baileys run on workerd. |
| `scripts/vendor-bridge.mjs` | Extracts the wasm from Baileys' Rust bridge and patches its loader. Runs on `npm ci`. |
| `scripts/pull-config.mjs` | Rebuilds a config from the live Worker (writes `wrangler.local.jsonc`; this fork keeps its real config in `wrangler.jsonc`). |
| `test/*.test.mts` | Tests on `node:sqlite`; `test/ts-resolve.mjs` shims `cloudflare:workers`. |
| `Dockerfile`, `compose.yml`, `docker/`, `local-export/` | Upstream's self-hosting and export extras. Not used by this deployment. |

## How sessions work

All WhatsApp traffic happens inside `runSession()` in `src/whatsapp/account.ts`:

- **Pairing** (`startPairing`, `requestPairingCode`). Baileys emits QR strings, rendered to SVG for the setup page. After a scan WhatsApp closes the socket with code 515 and the session reconnects with the new credentials. History arrives as `messaging-history.set` chunks with a progress percentage. The session ends at 100 percent plus a few quiet seconds. A Durable Object alarm keeps the object alive while it runs, so closing the page doesn't stop the import.
- **Pull** (`pull`, `pullIfStale`). Reconnects with stored credentials, receives what WhatsApp queued, and ends after 4 quiet seconds or 60 seconds in all.

Callers share one session. Idle detection counts only data events (`messaging-history.set`, `messages.upsert`), because presence and contact updates never stop.

## Data model

All in the Durable Object's SQLite (`src/store/store.ts`). "Sealed" means a `Vault.seal` blob; "pid" means a `Vault.pid` id.

- `messages(chat, id, ts, from_me, sender, type, data)`: `chat` and `sender` are pids; `data` is sealed `{ body, push name, sender jid, media ref, transcript, quote }`. Edits rewrite it; deletes set it to `[deleted]`.
- `chats`, `contacts`, `custom_names`: `cid` is the pid of the jid; the sealed record holds the jid and names. Names resolve in memory through `names.ts`.
- `alias`: maps anonymous `@lid` ids to phone-number jids, so one person is one chat. `lid_senders` lists senders still under an unmapped lid.
- `auth`: Baileys credentials and signal keys, key names hashed too.
- `meta`, `account`: `last_pull`, `paired`, `tz`, login throttling, a sealed canary, schema and index versions; the account record.
- `chat_stats`: per-chat count and newest timestamp, kept by triggers, so counting never scans. Don't use `INSERT OR REPLACE` on `messages`; a replace skips delete triggers.
- `search_blocks`: the search filters.
- `notes(id, chat, created, due, done, data)`: `chat` is a pid and `data` the sealed text; `due` and `done` stay readable so reminders can be listed without the key's help in SQL.

A new table that holds user content stores a `vault.pid` for anything it indexes and a sealed blob for the rest, with its own AAD letter (constants at the top of `store.ts`).

## Searching encrypted messages

Each chat's timeline is cut into blocks of about 128 messages. Each block has a Bloom filter of 16,384 bits, 4 bits per word and per word prefix of one to four letters, chosen by an HMAC under a key derived from the data key.

- A search hashes its words the same way. One bit off means the word is not in that block and the block is skipped; otherwise the block is decrypted and matched properly, so results equal a full scan (the tests check this against brute force).
- Blocks are read newest first and the search stops once every query has its matches.
- Bits are only ever added, so a filter can grow stale but never wrong.
- Changing `fold`, `core`, `entriesOf` or `needsOf` bumps `INDEX_VERSION`, which rebuilds filters on the next search. The query side (`matches`/`hasTerm` in `store.ts`) must apply the same `core`.

## What costs money

Durable Object SQLite bills rows read and written, and a write costs about a thousand reads.

- Don't add an index to `messages` casually: it is one more row written per message, forever.
- Don't count or group over `messages` on a hot path; use `chat_stats`.
- Batch writes to the small tables: one per chat or block per ingest batch.
- Ingest is idempotent, which is what makes relinking safe.

## Before changing the Baileys parts

1. **Baileys needs three shims on workerd.** `ws-shim.ts` wraps the Workers WebSocket (opened with `fetch()` and an `Upgrade` header, the only way to set the `Origin` WhatsApp checks). `vendor-bridge.mjs` writes the Rust bridge's wasm to a file, because workerd forbids compiling it at runtime; `vendor/` is generated. `polyfills.ts` adds `.unref()` to timers and must be the first import.
2. **`lru-cache` autopurge breaks the first import** by starting one timer per entry past workerd's 10,000 limit. `lru-shim.ts` turns it off.
3. **QR pairing never sets `creds.registered`.** "Is this linked" is `creds.me?.id`.
4. **History comes once per link.** Don't ship an ingest change without testing it against a real first link.
5. **Group senders arrive in two places:** `key.participant` live, `msg.participant` in history.
6. **Baileys is pinned to `7.0.0-rc14`.** The `postinstall` patch depends on it; upgrade only with a real link test.
7. **Deploys don't evict a busy Durable Object.** If a fix doesn't take, stop sending requests for three to five minutes; every probe resets the idle timer.
8. **Logging out takes two steps:** connect and call Baileys' `logout()` so the device leaves the phone's list, then clear local credentials.
9. **WhatsApp stores placeholders as names** (the number, sometimes masked). `numberLike` treats them as no name.
10. **Keep `markOnlineOnConnect: false`.** Marking the device online stops the phone's notifications.

## Configuration

| Name | Kind | Value here |
| --- | --- | --- |
| `WA_OWNER_PASSWORD` | secret | Set. Single-user mode; 12+ characters. |
| `WA_PIN` | secret, optional | Turns on `/debug` with an `x-pin` header. 32+ characters. |
| `TIMEZONE` | var | `Asia/Riyadh`. Wins over the zone saved at sign-up. |
| `DEFAULT_COUNTRY_CODE` | var | `966`. For numbers saved without a country code. |
| `AI` | Workers AI binding | Set. Turns on `transcribe_audio`. |
| `TRANSCRIBE_MODEL` | var, optional | Unset, so `@cf/openai/whisper-large-v3-turbo`. |
| `OAUTH_KV` | KV binding | Namespace named `WA_OAUTH_KV`; the binding name can't change because the OAuth library reads `env.OAUTH_KV`. |
| `WA` | Durable Object | `WhatsAppStore`, one instance named `owner`. |
| `REGISTRY` | Durable Object | `Registry`, upstream's seat counter; bound but unused here. |
| `OPEN_SIGNUP` | var | Must stay unset, so the upstream login service is never used. |

`wrangler.jsonc` is this deployment's real config and is committed; there is no `wrangler.local.jsonc`.

## Debugging

With `WA_PIN` set, `GET /debug` with header `x-pin: <WA_PIN>` returns the session phase, whether a phone is linked, whether the object has a key, the message count and the last session events. It shows no message content, names or numbers, on purpose. Logs carry counts and timings only.

Local: `npm run dev` with a `.dev.vars` containing `WA_OWNER_PASSWORD=...`. Linking a phone from local dev makes a second linked device, so avoid it on the business number.

## Making a change

1. Work on a feature branch. `main` is merged and deployed with `npm run deploy`.
2. `npm ci`, then add tests beside the code they cover (`test/store`, `history`, `names`, `translate`, `digest-render`).
3. Done means all three pass: `npm test`, `npm run typecheck`, `npx wrangler deploy --dry-run --outdir /tmp/dryrun`.
4. Update this README and `AGENTS.md` when a tool, secret or invariant changes.

## Known gaps

- Chats with no name in WhatsApp and none saved show as numbers until an assistant or I save one.
- If WhatsApp logs the device out, nothing says so until the next `link_status`.
- Nothing changes the password yet (`rewrap` in `vault.ts` and `replaceAccount` exist; nothing calls them).
- Wrong-password lockouts can lock the owner out of new sign-ins for up to an hour; connected assistants keep working.
- `get_media` follows the download location in the message without checking its host, so a crafted message can make the Worker fetch another address.
- One-letter prefix searches (`a*`) read nearly everything.

## Origin and license

Cloned from [finereli/whatsapp-mcp](https://github.com/finereli/whatsapp-mcp) by [@finereli](https://x.com/finereli), imported as one commit from upstream `b49d494`. There is no shared git history. To take an upstream fix, add the remote, read `git log upstream/main` since `b49d494`, and port the change by hand, keeping this fork's renames (`WA_OWNER_PASSWORD`, `WA_PIN`, the `WA_OAUTH_KV` namespace) and additions (the chat viewer, `get_context`, `chat_activity`, notes and `daily_digest`, Arabic search, the longer sync windows).

MIT, as upstream.
