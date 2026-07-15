# Falcon — Implementation Plan

**Version:** 1.0
**Date:** 2026-07-15
**Companion docs:** `falcon-prd.md` (requirements), `falcon-system-design.md` v0.2 (architecture)
**Reference codebase:** `happy/` (slopus/happy, **MIT license**) — read in depth; every phase below cites the actual source files that prove the mechanism works, quotes the load-bearing code, and shows the Falcon adaptation.

> **How to use this doc:** phases are ordered by dependency; each phase lists concrete tasks with the Happy reference (`happy/packages/...:line`), a snippet of the actual reference code where the mechanism is non-obvious, and the Falcon code to write. "Adapt" means copy the logic, rename, and apply our v0.2 deltas (HTTP writes, two-level seq, Drizzle, Next.js web, blob payloads). Happy is MIT — reuse is legal; keep a `NOTICE` crediting it.

---

## Phase 0 — Monorepo, `@falcon/wire`, `@falcon/crypto` (Week 1–2)

### 0.1 Scaffold

```
falcon/
├─ package.json            # pnpm workspaces: packages/*
├─ pnpm-workspace.yaml
├─ tsconfig.base.json      # strict, ES2022, moduleResolution bundler, "@/" alias per package
└─ packages/{wire,crypto,cli,server,web}
```

Tasks:
- [ ] pnpm workspace + shared tsconfig + biome (or eslint+prettier) at root
- [ ] `packages/wire` and `packages/crypto` build with `pkgroll` (dual ESM/CJS + d.ts) — same tool Happy uses for `happy-wire`
- [ ] CI: typecheck + vitest on every package

### 0.2 `@falcon/crypto` — port Happy's crypto verbatim, then extend

**Reference:** `happy/packages/happy-cli/src/api/encryption.ts` (248 lines, read in full). The functions to port unchanged (they're already clean, dependency-light, and battle-tested):

```ts
// happy/packages/happy-cli/src/api/encryption.ts:154-174 — payload encryption (ACTUAL CODE)
export function encryptWithDataKey(data: any, dataKey: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(12); // GCM uses 12-byte nonces
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Bundle: version(1) + nonce (12) + ciphertext + auth tag (16)
  const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
  bundle.set([0], 0);
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(encrypted), 13);
  bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
  return bundle;
}
```

```ts
// happy/packages/happy-cli/src/api/encryption.ts:62-79 — DEK wrapping (ACTUAL CODE)
export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const ephemeralKeyPair = tweetnacl.box.keyPair();
  const nonce = getRandomBytes(tweetnacl.box.nonceLength);
  const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
  // Bundle format: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
  const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
  result.set(ephemeralKeyPair.publicKey, 0);
  result.set(nonce, ephemeralKeyPair.publicKey.length);
  result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
  return result;
}
```

```ts
// happy/packages/happy-cli/src/api/encryption.ts:233-247 — auth challenge (ACTUAL CODE)
export function authChallenge(secret: Uint8Array) {
  const keypair = tweetnacl.sign.keyPair.fromSeed(secret);
  const challenge = getRandomBytes(32);
  const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);
  return { challenge, publicKey: keypair.publicKey, signature };
}
```

Tasks:
- [ ] Port `encodeBase64/decodeBase64/base64url`, `getRandomBytes`, `encryptLegacy/decryptLegacy` (secretbox), `encryptBlob/decryptBlob`, `encryptWithDataKey/decryptWithDataKey`, `libsodiumEncryptForPublicKey` + the matching `libsodiumPublicKeyFromSecretKey` (note the SHA-512-of-seed quirk at `encryption.ts:55-60` — libsodium compat), `authChallenge`. Falcon drops the `legacy` variant for new data but keeps decrypt support in the schema (`v` byte) for future migrations.
- [ ] Add the **key tree**: `deriveKey(master, usage, path)` = HMAC-SHA512 tree (port from `happy/packages/happy-app/sources/encryption/deriveKey.ts` — remember its `.slice()`-not-`.subarray()` comment; browsers/webcrypto don't care but keep the copy semantics).
- [ ] Add `EncryptedBox` helpers: `sealBox(obj, dek) → {t:'enc', v:1, c}` / `openBox(box, dek) → obj | null`. **`openBox` never throws** — Happy's rule (`decryptWithDataKey` returns `null` on any failure, `encryption.ts:182-212`).
- [ ] Web build: same API over `libsodium-wrappers` + WebCrypto (`crypto.subtle` AES-GCM); vitest parity suite runs identical vectors against node and jsdom builds.
- [ ] Recovery code: 32B → grouped Base32 with confusion-normalization (spec in design §5.1; Happy reference `happy-app/sources/auth/secretKeyBackup.ts`).

### 0.3 `@falcon/wire` — schemas

Model on `happy/packages/happy-wire/src/*` (Zod v4 + cuid2, zero other deps). Write the v0.2 design §4 schemas: `EncryptedBox`, `SessionEnvelope` (11 event types), `Update`/`Ephemeral` unions, RPC param/result types, `PermissionMode`, `PermDecision`.

```ts
// packages/wire/src/envelope.ts (FALCON — new code, shape from design §4.2)
export const sessionEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), md: z.string(), thinking: z.boolean().optional() }),
  z.object({ t: z.literal('service'), text: z.string() }),
  z.object({ t: z.literal('tool-start'), call: z.string(), name: z.string(),
             title: z.string().optional(), args: z.unknown(),
             risk: z.enum(['read','write','exec','network']).optional() }),
  z.object({ t: z.literal('tool-end'), call: z.string(), ok: z.boolean(), output: z.unknown().optional() }),
  z.object({ t: z.literal('file'), ref: z.string(), name: z.string(), size: z.number(),
             image: z.object({ w: z.number(), h: z.number(), thumbhash: z.string() }).optional() }),
  z.object({ t: z.literal('turn-start') }),
  z.object({ t: z.literal('turn-end'), status: z.enum(['completed','failed','cancelled']) }),
  z.object({ t: z.literal('perm-request'), reqId: z.string(), call: z.string().optional(),
             name: z.string(), args: z.unknown(), modes: z.array(permissionModeSchema) }),
  z.object({ t: z.literal('perm-resolve'), reqId: z.string(), decision: permDecisionSchema }),
  z.object({ t: z.literal('mode-switch'), control: z.enum(['local','remote']), by: z.enum(['terminal','client']) }),
  z.object({ t: z.literal('sub-start') }), z.object({ t: z.literal('sub-stop') }),
]);
export const sessionEnvelopeSchema = z.object({
  id: z.string().refine(isCuid), time: z.number(),
  role: z.enum(['user','agent']),
  turn: z.string().optional(), subagent: z.string().optional(),
  ev: sessionEventSchema,
}).superRefine((v, ctx) => {
  if (v.role === 'agent' && !v.turn && v.ev.t !== 'turn-start')
    ctx.addIssue({ code: 'custom', message: 'agent events require turn' });
});
```

- [ ] Snapshot tests lock the schema; CI lint forbids non-additive changes (compare against committed JSON-schema dump).

**Exit criteria:** `pnpm test` green; crypto round-trips node↔browser; a fixture envelope encrypts→uploads-shape→decrypts.

---

## Phase 1 — Server (Week 2–5)

### 1.1 Scaffold + Drizzle

- [ ] Fastify 5 + `fastify-type-provider-zod` (same pattern as Happy: see `happy/packages/happy-cli/src/daemon/controlServer.ts:29-36` for the minimal setup — `setValidatorCompiler/setSerializerCompiler/withTypeProvider`).
- [ ] Drizzle schema exactly as design §6.1 (accounts, machines, workspaces, sessions, session_messages, unmanaged_sessions, pair_requests, push_subscriptions, blobs). `drizzle-kit generate` migrations; run on boot.
- [ ] docker-compose: `postgres:16` + server; optional minio.

### 1.2 Auth: challenge/response + pairing

**Reference (port nearly verbatim, Prisma→Drizzle):** `happy/packages/happy-server/sources/app/api/routes/authRoutes.ts:9-39`:

```ts
// happy authRoutes.ts:17-38 (ACTUAL CODE) — the entire account model is this upsert
const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
if (!isValid) return reply.code(401).send({ error: 'Invalid signature' });
const publicKeyHex = privacyKit.encodeHex(publicKey);
const user = await db.account.upsert({
  where: { publicKey: publicKeyHex },
  update: { updatedAt: new Date() },
  create: { publicKey: publicKeyHex }
});
return reply.send({ success: true, token: await auth.createToken(user.id) });
```

**Pairing** (`authRoutes.ts:41-166`) is a 3-endpoint dance worth copying exactly: `POST /auth/request` upserts a `PairRequest` by ephemeral pubkey and *returns the sealed response + token if already approved* (polling and completion are the same endpoint — elegant); `GET /auth/request/status` for cheap polling; authenticated `POST /auth/response` stores the approver's sealed box **only if not already set** (`authRoutes.ts:159-164` — first approval wins).

Falcon adaptations:
- [ ] Same three endpoints under `/v1/auth/pair*`; Drizzle `onConflictDoNothing` for first-wins.
- [ ] Token: short-lived JWT (jose, HS256 from `FALCON_MASTER_SECRET` at MVP) + refresh endpoint — replaces Happy's privacy-kit persistent tokens.
- [ ] Add expiry to pair requests (15 min) — one of the vulns Happy's security reporter filed (QR auth never expired).
- [ ] OAuth binding (`/auth/register` with Google/GitHub proof) stored on account for recovery only. Defer email+password.

### 1.3 The HTTP write path (v0.2 change #1 — this is where we deliberately diverge)

**Reference for ingest semantics:** Happy's WS `message` handler, `happy/packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts:187-246`. Key mechanics to keep: per-connection `AsyncLock`, localId dedup-before-insert, seq allocation, post-insert fan-out with `skipSenderConnection`. What we change: transport (HTTP), **drop `allocateUserSeq` from the message path** (two-level seq).

```ts
// packages/server/src/app/api/routes/messageRoutes.ts (FALCON — new code)
app.post('/v1/sessions/:id/messages', { preHandler: app.authenticate, schema: {
  params: z.object({ id: z.string() }),
  body: z.object({ localId: z.string().min(8), content: encryptedBoxSchema }),
}}, async (req, reply) => {
  const sessionId = req.params.id;
  const owned = await assertSessionOwned(db, sessionId, req.userId); // 404 if not
  // Idempotent replay: unique (session_id, local_id)
  const existing = await db.query.sessionMessages.findFirst({
    where: and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.localId, req.body.localId)) });
  if (existing) return reply.send({ seq: existing.seq, replay: true });

  const row = await db.transaction(async (tx) => {
    // Two-level seq: bump ONLY the session counter (hot-row scope = one session)
    const [{ msgSeq }] = await tx.update(sessions)
      .set({ msgSeq: sql`${sessions.msgSeq} + 1`, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .returning({ msgSeq: sessions.msgSeq });
    const [msg] = await tx.insert(sessionMessages)
      .values({ sessionId, seq: msgSeq, localId: req.body.localId,
                content: packBox(req.body.content) })
      .onConflictDoNothing({ target: [sessionMessages.sessionId, sessionMessages.localId] })
      .returning();
    return msg ?? await tx.query.sessionMessages.findFirst({ /* lost race → replay */
      where: and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.localId, req.body.localId)) });
  });
  // Post-commit fan-out (never inside the tx — Happy's afterTx rule)
  eventRouter.emitUpdate({ userId: req.userId,
    payload: { ts: Date.now(), body: { t: 'message-new', sessionId, msgSeq: row.seq,
               localId: row.localId, content: unpackBox(row.content) } },
    recipientFilter: { type: 'session-interested', sessionId } });
  return reply.send({ seq: row.seq });
});
```

- [ ] Same treatment for `PUT /v1/sessions/:id/metadata|state` — port the CAS pattern from `sessionUpdateHandler.ts:40-50` (the `updateMany where version = expected` conditional-update trick, count===0 ⇒ 409 with current value) to Drizzle `.update().where(and(id, version)).returning()`.
- [ ] `POST /v1/sessions` create-or-get by `(accountId, tag)` (unique index; on conflict return existing) — allocates **headerSeq** and fans out `session-new`.
- [ ] `GET /v1/sync?since=`, `GET /v1/sessions/:id/messages?before/after` pagination.

### 1.4 WS read stream

**Reference (port with minor renames):** `happy/packages/happy-server/sources/app/api/socket.ts` and `events/eventRouter.ts`.

Three things to copy exactly:

1. **Auth in `io.use` middleware, not the connection callback** — Happy's comment explains why (`socket.ts:79-82`): *"Without this, the async verifyToken in the connection callback creates a window where client events (rpc-register, rpc-call) arrive before handlers are attached — and get silently dropped."*
2. **Room layout** (`eventRouter.ts:228-241`): `user:<uid>`, `user:<uid>:user-scoped`, `user:<uid>:session:<sid>`, `user:<uid>:machine:<mid>`; recipient filters `all-interested-in-session | user-scoped-only | machine-scoped-only | all-user`.
3. **App-state tracking for push suppression** (`socket.ts:174-185`): read initial state from the handshake (*"to close the race window between connect and the first async app-state event"*), then update on `app-state` events, stored on `socket.data`.

Falcon deltas:
- [ ] Strip all client→server *write* handlers (`update-metadata`, `update-state`, `message` — they're HTTP now). Keep: `alive` (ephemeral activity, port of `session-alive` handler `sessionUpdateHandler.ts:140-184` including its clock-skew clamps), `app-state`, RPC events.
- [ ] `machine-presence` ephemerals on machine connect/disconnect (port from `socket.ts:163-172,196-204`).
- [ ] Backpressure: wrap ephemeral emit with a per-socket `bufferedAmount` check; coalesce latest-wins per session.

### 1.5 RPC router — port `rpcHandler.ts` nearly verbatim

`happy/packages/happy-server/sources/app/api/socket/rpcHandler.ts` (260 lines) is the single most valuable file in the reference codebase — it encodes a production postmortem. Port it with its constants and comments:

```ts
// happy rpcHandler.ts:16-34 (ACTUAL CODE) — tuning constants, keep them
const RPC_CALL_TIMEOUT_MS = 30_000;
const RPC_PRESENCE_POLL_MS = 2_000;
const RPC_LOOKUP_FETCH_TIMEOUTS_MS = [2_000, 4_000, 8_000]; // exponential backoff
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 500;
const RPC_RECONNECT_GRACE_MS = 15_000;
const RPC_RECONNECT_POLL_MS = 200;
```

```ts
// happy rpcHandler.ts:219-241 (ACTUAL CODE) — the dead-peer race, the crown jewel
const ackPromise = target.timeout(RPC_CALL_TIMEOUT_MS).emitWithAck('rpc-request', { method, params });
let presenceAlive = true;
const presencePoll = (async () => {
  let consecutiveMisses = 0;
  while (presenceAlive) {
    await sleep(RPC_PRESENCE_POLL_MS);
    if (!presenceAlive) return;
    const stillThere = await fetchRoomSockets(io, room, RPC_PRESENCE_FETCH_TIMEOUT_MS, 'presence');
    if (!stillThere.some(s => s.id === target.id)) {
      consecutiveMisses++;
      if (consecutiveMisses >= 2) throw new Error('RPC target disconnected');
    } else consecutiveMisses = 0;
  }
})();
const response = await Promise.race([ackPromise, presencePoll]);
```

Falcon deltas:
- [ ] `rpc-register` accepts `methods: string[]` (batch; Happy registers one at a time).
- [ ] Method-name authorization: a session-scoped socket may only register `s:<itsOwnSessionId>:*`; machine-scoped only `m:<itsOwnMachineId>:*` (Happy doesn't enforce this — cheap hardening).
- [ ] Enforce 64 KB param/result cap (design §4.4) with a clear error.
- [ ] Keep the Prometheus metrics (`rpcHandler.ts:36-64`) — they exist because debugging this blind is hell.

### 1.6 Push

**Reference:** `happy/packages/happy-server/sources/app/push/` — direct Expo HTTP posts, and the presence-suppression decision documented in the research. Falcon: `web-push` (VAPID) instead of Expo; add channel column.

- [ ] `POST /v1/push/subscribe {channel: 'webpush'|'telegram'|'ntfy', endpoint, keys?}`.
- [ ] `dispatchSessionEvent(userId, sessionId, kind)` — single entry point; suppression rule: skip if any user-scoped socket has `socket.data.appState === 'active'` **and** is in `user:<uid>:session:<sid>` room. Re-notify pending perms at +5/+10 min (BullMQ-less: a simple `setTimeout` registry at MVP, single process).
- [ ] Telegram: bot with `/start <accountLinkCode>` deep-link; message = generic title + `https://app.falcon.dev/session/<id>`. ntfy: POST to user-configured topic.

### 1.7 Blobs

- [ ] `POST /v1/blobs/request-upload {size, contentHash}` → presigned PUT (minio/S3) + blob row; `request-download` → presigned GET. Local-disk fallback for compose self-host.

**Exit criteria:** integration test drives: register → pair → create session → POST 500 coalesced messages from 3 parallel "sessions" (no serialization errors) → WS client receives ordered updates → RPC round-trip with a fake daemon → kill fake daemon mid-call → error in <5 s.

---

## Phase 2 — CLI foundation (Week 4–6, overlaps Phase 1)

### 2.1 Package + local state

**Reference:** `happy/packages/happy-cli` layout; `src/persistence.ts` + `src/configuration.ts` conventions.

- [ ] `packages/cli`: bin shim that re-execs node with `--no-warnings` (Happy: `bin/happy.mjs` — keeps stdout clean), hand-rolled arg parsing in `src/index.ts` (subcommand table + **pass unknown flags through**), `~/.falcon/` home (`FALCON_HOME_DIR` override).
- [ ] `settings.json` atomic writes: `O_CREAT|O_EXCL` lock file + write-temp-then-rename, 5 s stale-lock timeout (Happy's documented pattern).
- [ ] File-only logging (`src/ui/logger.ts` pattern) — **never stdout**; it would corrupt the provider TUI. `FALCON_DEBUG=1` for verbose.
- [ ] `access.key`: `{token, masterSecretOrContentBundle}` base64 JSON, chmod 600.

### 2.2 `falcon auth login` — pairing client

- [ ] Generate ephemeral X25519 keypair; `POST /v1/auth/pair {ephPub}`; print URL `https://app.falcon.dev/pair#<base64url ephPub>` (+ QR via `qrcode-terminal` for the future mobile app); poll `pair/status` (2 s); on `authorized`, open the sealed box with the ephemeral secret (layout: `ephPub(32)|nonce(24)|ct` — mirror of `libsodiumEncryptForPublicKey`), store credentials + token.
- [ ] `auth status` / `auth logout`.

### 2.3 API client + disk outbox (v0.2 write path)

```ts
// packages/cli/src/api/outbox.ts (FALCON — new code)
// Append-only JSONL at ~/.falcon/outbox/<sessionId>.jsonl; each line
// {localId, body} already encrypted. A single drain loop POSTs in order:
export async function drainOutbox(sessionId: string) {
  for (const entry of readPending(sessionId)) {
    while (true) {
      try {
        const res = await http.post(`/v1/sessions/${sessionId}/messages`,
          { localId: entry.localId, content: entry.body });
        markSent(sessionId, entry.localId, res.seq);
        break;
      } catch (e) {
        if (isPermanent(e)) { markFailed(sessionId, entry.localId, e); break; } // 4xx ≠ 429
        await backoff(); // 1s → 30s cap; retry forever on network/5xx — localId makes it safe
      }
    }
  }
}
```

- [ ] Session-scoped WS client (socket.io-client, `transports:['websocket']`, auth `{token, clientType:'session-scoped', sessionId, falconClient}`) — receives `update`/`rpc-request`, sends `alive`. Reconnect = library default + re-register RPC handlers on `connect` (an `RpcHandlerManager` like Happy's).
- [ ] `POST /v1/sessions` create-or-get with `tag = cuid2()` minted per invocation; DEK generated locally, wrapped to content pubkey, sent once at create.

**Exit criteria:** `falcon auth login` pairs against local server; a stub session posts envelopes through the outbox with the server offline for 60 s mid-run and nothing is lost or duplicated.

---

## Phase 3 — Claude local mode (Week 6–8) — the fidelity path

### 3.1 Launcher script

**Reference (copy almost as-is):** `happy/packages/happy-cli/scripts/claude_local_launcher.cjs` (73 lines, read in full). The whole trick:

```js
// happy claude_local_launcher.cjs:19-64 (ACTUAL CODE, abridged) — fetch patch → fd 3
global.fetch = function(...args) {
  const id = ++fetchCounter;
  // ...parse hostname/path only (privacy)...
  writeMessage({ type: 'fetch-start', id, hostname, path, method, timestamp: Date.now() });
  const fetchPromise = originalFetch(...args);
  const sendEnd = () => writeMessage({ type: 'fetch-end', id, timestamp: Date.now() });
  fetchPromise.then(sendEnd, sendEnd);
  return fetchPromise;
};
// then: require() the globally-installed claude CLI and run it
```

- [ ] Copy with renames; resolve the Claude CLI via a `claude_version_utils`-style locator (check `which claude` realpath → package dir → `cli.js`). Set `DISABLE_AUTOUPDATER=1` (launcher line 4).

### 3.2 Spawn — the three landmines are already defused in the reference

**Reference:** `happy/packages/happy-cli/src/claude/claudeLocal.ts`. Port these verbatim:

1. **stdin blocking fix** (`claudeLocal.ts:191-207`) — the comment IS the documentation:
```ts
// Force blocking I/O on the inherited stdin fd. Node leaves O_NONBLOCK set after
// libuv-mode reads ... the visible symptom is duplicated cursors and garbled echo
// on macOS/Linux right after a remote→local switch (slopus/happy#301 family).
const stdinHandle = (process.stdin as any)._handle;
if (stdinHandle?.setBlocking) stdinHandle.setBlocking(true);
```
2. **stdio shape** (`claudeLocal.ts:312-323`): `crossSpawn('node', [launcherPath, ...args], { stdio: ['inherit','inherit','inherit','pipe'], signal: abort, cwd, env })` — fd 3 is the pipe; `cross-spawn` specifically for Windows `.cmd` resolution (issue #1082 noted at line 310).
3. **Session-flag interception** (`claudeLocal.ts:56-137`): extract `--resume [id]`, `-r`, `--continue`, `-c`, `--session-id <uuid>` from passthrough args and re-inject after resolving against Falcon's own session registry, so `falcon --resume` behaves exactly like `claude --resume` but lands in a Falcon session.
4. **Injections** (`claudeLocal.ts:232-251`): `--append-system-prompt`, `--mcp-config` (when we ship a falcon MCP later), `--settings <tempHookFile>`, exit-code handling incl. abort-signal SIGTERM = clean exit (`claudeLocal.ts:395-415`).
5. **Thinking state machine** from fd 3 (`claudeLocal.ts:326-390`): active-fetch map + 500 ms debounce on stop.

- [ ] Hook settings temp file: `{ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'curl -s http://127.0.0.1:<hookPort>/session-start?...' }] }] } }` → loopback hook server captures the **real provider session UUID** (this is how metadata.providerSessionId gets set). Also register `Notification` + `Stop` hooks for local-mode attention events (FR-3.6).

### 3.3 Transcript scanner

**Reference (port whole file):** `happy/packages/happy-cli/src/claude/utils/sessionScanner.ts` (290 lines). Everything in it exists because of a production bug; keep:

- `processedEntryKeys` dedup with type-aware keys (`sessionScanner.ts:216-228`: user/assistant/system → `uuid`; summary → `'summary: '+leafUuid+': '+summary`).
- **Multi-file watching** — after `--resume`, *"Claude Code may continue writing to it [the old file] even after creating a new session"* (`sessionScanner.ts:62-66`), so watch old + new.
- **Phantom-session blacklist** (`deadSessions`, `sessionScanner.ts:48-54,134-146`) — a session whose `.jsonl` never appears must be dropped or it spins CPU forever (*"the dead Happy instance bug"*).
- `onNewSession(id, {treatExistingAsProcessed})` (`sessionScanner.ts:167-205`) — pre-mark disk entries on reconnect so history isn't replayed as fresh prompts.
- Skip internal event types `file-history-snapshot|change|queue-operation` (`sessionScanner.ts:15-19`).
- Poll every 3 s *plus* fs-watch (`sessionScanner.ts:154`) — watchers alone miss writes on some filesystems.

- [ ] Then the **envelope mapper** (`src/claude/mapper.ts`): Claude JSONL record → `SessionEnvelope[]` per design §7.4 rules (assistant text→`text`, thinking→`text{thinking}`, non-Task `tool_use`→`tool-start`, Task→subagent registration + orphan buffer, `tool_result`→`tool-end`, sidechain user→subagent text). Reference for the rules: `happy/docs/session-protocol-claude.md` + `happy-cli/src/claude/utils/sessionProtocolMapper.ts`.
- [ ] **Coalescer** (v0.2): buffer envelopes, flush ≤300 ms/≤20 into one outbox entry.

**Exit criteria:** run `falcon claude` in a scratch repo, execute a multi-tool prompt with a Task subagent; web (or a debug tail client) shows the structured timeline live; kill/restart the CLI mid-session → no duplicates, no replay.

---

## Phase 4 — Remote mode, permissions, mode switching (Week 8–11)

### 4.1 The loop

**Reference (port as-is — it's 65 lines of logic):** `happy/packages/happy-cli/src/claude/loop.ts:76-116`:

```ts
// happy loop.ts:76-109 (ACTUAL CODE, abridged) — the entire mode machine
let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
while (true) {
  switch (mode) {
    case 'local': {
      const result = await claudeLocalLauncher(session);
      switch (result.type) {
        case 'switch': mode = 'remote'; opts.onModeChange?.(mode); break;
        case 'exit':   return result.code;
      }
      break;
    }
    case 'remote': {
      const reason = await claudeRemoteLauncher(session);
      switch (reason) {
        case 'exit':   return 0;
        case 'switch': mode = 'local'; opts.onModeChange?.(mode); break;
      }
      break;
    }
  }
}
```

- [ ] `onModeChange` additionally emits a `mode-switch` envelope (Falcon adds it to the timeline).
- [ ] Local→remote trigger: message queue non-empty or `takeControl` RPC → abort local child (the abort-signal SIGTERM path is already clean-exit, `claudeLocal.ts:404-406`). Remote→local trigger: **Ctrl-T** (single, documented) — simpler than Happy's double-space-with