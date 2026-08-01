# Auth UX post-verification fixes

Follow-up to `docs/auth-ux-fix-verification-results.md` — three bugs that pass surfaced
(§1/F3.3, §3/F4.3, §6/Fix 10). Each section below is root cause (with file:line citations),
fix approach, then a status line once implemented and typechecked/tested.

---

## Bug A (CRITICAL) — messages sent after a dead-token re-pair don't decrypt in the web

### Root cause

The a-priori theory in the verification pass — that Fix 3's re-pair rebinds a new content
public key server-side and the browser never learns its cached key state is stale — does
**not** hold up:

- `packages/cli/src/auth/login.ts`'s `runAuthLogin` never calls `keys/bind`. CLI pairing
  (`packages/cli/src/auth/pair.ts`) only ever recovers the account's existing
  `masterSecret`, sealed by the approving browser's own worker
  (`packages/web/src/crypto/worker-handler.ts`'s `sealForPeer`, :398-420) — it is not a
  fresh key epoch.
- `deriveKeyTree` (`packages/crypto/src/keys.ts:92`) is a pure, deterministic HKDF over
  `masterSecret`. Same secret → same content keypair, on every device, forever. Since no
  `reset-keys` happened, the CLI's `contentKeyPair` after re-pair is byte-identical to
  before.
- A session's wrapped DEK is immutable once created — `packages/server/src/app/routes/
  sessions.ts`'s `POST /v1/sessions` only ever inserts it (`onConflictDoNothing`); the
  idempotent-replay path returns the *original* row, never re-wraps.

So X (what the CLI encrypts with) and Y (what the browser decrypts with) never actually
diverge cryptographically. The real bug is elsewhere: the crypto-bridge worker holds
**one mutable `activeDek` slot** (`packages/web/src/crypto/worker-handler.ts:85`,
`case "setSessionKey"` :306-314, `case "open"` :321-324) shared by whichever caller last
called `setSessionKey`, with no scoping to which session/machine that DEK belongs to.

That would be safe if `useCryptoBridge()` genuinely gave each caller (each hook that holds
an "active session key" across time) its own isolated worker — which is what nearly every
consumer's doc comments claim happens: `packages/web/src/features/session-list/
live-source.ts:67-78,267-277,421-425` explicitly says `titlesBridge`/`itemsBridge` are
"its own worker, deliberately not shared," and `packages/web/src/lib/
use-session-metadata-write.ts:96-97` makes the same claim. **That claim is false against
the current implementation.** `packages/web/src/lib/use-crypto-bridge.ts`'s `useCryptoBridge()`
is a **refcounted, app-wide singleton** (`let sharedBridge`, `acquire()`/`release()`,
:20-49) — every caller anywhere in the app gets the literal same `CryptoBridgeClient`
object, hence the same worker thread, hence the same single `activeDek`.

This was a real regression, confirmed via git history: `use-crypto-bridge.ts` was
originally (commit `6505233`) "Spins up a crypto-bridge worker for the lifetime of the
calling component... Each auth page owns its own worker instance rather than sharing a
cross-page singleton." Commit `994846a` (the account-bound-keys/re-pair overhaul) changed
it to the shared-singleton model for perf/memory ("many unrelated features each call
`useCryptoBridge()` on their own, so sharing one instance keeps a single worker... per page
load") without updating the ~6 call sites whose correctness depends on isolation, and
without adding any locking around `setSessionKey`+later-`open`/`seal` sequences.

Concretely, on the Home screen alone, `useLiveSessionListSnapshot` (`session-list/
live-source.ts:420-445`) runs **two** concurrent sequential decrypt loops — one over every
session/machine *title* (`useDecryptedTitles`), one over every session's *messages*
(`useDecryptedItems`) — each doing `await bridge.setSessionKey(dek); await bridge.open(...)`
per row, for potentially several different sessions. Since `titlesBridge === itemsBridge`
(the same shared object), and `unmanaged-sessions/live-source.ts` and `new-session/
live-source.ts` run yet more of these loops against the *same* shared worker, any two of
these can interleave: one loop's `setSessionKey(sessionB)` can land between another loop's
`setSessionKey(sessionA)` and its subsequent `open()` calls for session A's data — decrypting
A's ciphertext under B's key. `packages/web/src/features/session-control/
use-session-crypto.ts` (the open Timeline's own bridge) is exactly such a caller too: it
`setSessionKey`s once and is then read from repeatedly (by `use-live-render-items.ts`,
`use-live-session-control.ts`, `use-composer-state.ts`, `use-session-title.ts`,
`use-session-model-chip.ts`) as new message pages arrive — a long enough window for the Home
screen's still-settling decrypt loops (in flight from the page the user just navigated away
from — React effect cleanup does not cancel an already-issued `postMessage` RPC call) to
clobber `activeDek` before the Timeline's own `open()` calls run.

This matches every observed symptom exactly: **all** batches for the viewed session fail
(not just new ones — whichever loop touched the worker last wins, regardless of which
session it belonged to), the failure is silent (`decryptMessageBatches`,
`packages/web/src/sync/messages.ts:38-42`, logs and drops a bad row rather than surfacing an
error — by design, for a genuinely-foreign/corrupt row, but here masking a real, fixable
bug), and it reproduces on *every* fresh navigation (Home is visited immediately before each
repro step, per the verification pass's own methodology, so its decrypt loops are reliably
still in flight at the moment the Timeline mounts).

### Fix approach

Restore genuine per-caller isolation for every hook that sets an active session/machine key
and reads it back later, without giving up the shared-singleton's benefit for the
stateless, one-shot callers (auth pages, `getIdentity`/`init`/`bindKeysProof`/`sealForPeer`,
session-refresh via `getSharedCryptoBridge()`) that don't hold ambient per-session state and
were never at risk.

Added `useDedicatedCryptoBridge()` to `packages/web/src/lib/use-crypto-bridge.ts` —
literally the pre-`994846a` per-caller-worker implementation, kept alongside (not replacing)
`useCryptoBridge()`'s shared singleton so `getSharedCryptoBridge()` (used by
`lib/session.ts`'s `silentRefresh` and `sync/apiSocket.ts`'s proactive renew) keeps working.
Switched every call site that does `setSessionKey` then reads it back over time from
`useCryptoBridge()` to `useDedicatedCryptoBridge()`:

- `features/session-control/use-session-crypto.ts` (Timeline messages/seal/open — every
  other session-control hook already funnels through this one bridge instance)
- `lib/use-machine-crypto.ts` (git-diff/checks/preview/run-panel/new-session actions)
- `features/session-list/live-source.ts` — `titlesBridge` and `itemsBridge` (now genuinely
  two separate workers, matching what the comments already claimed)
- `features/unmanaged-sessions/live-source.ts`
- `features/new-session/live-source.ts` (`useLiveNewSessionMachines`'s own decrypt loop)
- `lib/use-session-metadata-write.ts`

This is the minimal change that makes the codebase's own stated invariant ("a crypto-bridge
worker only ever holds one active session key at once, so don't share one across
independent effects") actually true, rather than rewriting the wire protocol to pass key
material with every `open`/`seal` call (a much larger, riskier change touching ~15 files for
a correctness property `useDedicatedCryptoBridge()` already restores).

**Status: ✅ Implemented — added `useDedicatedCryptoBridge()`, switched the six call sites
above, updated the now-stale doc comments that claimed isolation without it. Full-repo
`pnpm typecheck`/`pnpm test` pass (web: 161 files/1257 tests). No `packages/web/src/crypto/
worker.ts`/`worker-handler.ts` changes here — only main-thread hook code — so the crypto-worker
bundle is unaffected and the running `next dev` does not need restarting for this fix.**

---

## Bug B — signing into an account whose key slot was overwritten-then-wiped hangs the tab

### Root cause

`packages/web/src/crypto/key-storage.ts`'s `destroy()` (:146-154) calls
`indexedDB.deleteDatabase(DB_NAME)` after clearing the record. Its own doc comment already
flags the risk: "a connection from ANOTHER context... can block the delete." Per the
IndexedDB spec, a `deleteDatabase` request that's blocked (waiting for every open
connection to close) sits in that database's per-origin operation queue — and any
**subsequent** `indexedDB.open()` against the same database name queues **behind** it, so if
the blocking connection can never close, every future `open()` (i.e. every future
`storage.load()`/`save()`) hangs forever, not just the delete.

`packages/web/src/crypto/client.ts`'s `terminate()` (:182-186) is what creates that
never-closing connection. It synchronously calls `rejectAllPending()` then
`worker.terminate?.()` with **no wait** for any request currently in flight against the
worker. `key-storage.ts`'s `openDb()`-based helpers (`save`/`load`/`clear`, :107-145) open a
connection and close it in a `finally` block **after** their transaction completes —
`Worker.terminate()` aborts the thread mid-execution and never runs that `finally`, so a
request that happens to be between `openDb()` and `db.close()` at the moment of termination
leaves a genuinely open `IDBDatabase` connection with no code path left to ever close it.

`packages/web/src/lib/logout.ts`'s teardown sequence does exactly this: step 0
(`stopSharedBridge` → `terminateSharedCryptoBridge()`, `use-crypto-bridge.ts:76-81`) kills
whatever shared worker is currently live — with no guarantee nothing is mid-flight against
it (e.g. `RequireAuth`'s `useCryptoBridgeStatus`, `packages/web/src/lib/
use-crypto-bridge-status.ts`, evaluates `describeStorage`/`ensureLoaded` on mount and on
every account-id change, exactly what F4.3's account-swap scenario triggers repeatedly in a
short window). If that evaluation is between `openDb()` and `db.close()` when logout fires,
its connection leaks. Step 1's `wipeKeyMaterialWithThrowawayBridge()` then calls
`storage.destroy()` on a **fresh** worker/connection — its own `deleteDatabase` call gets
queued behind the leaked connection and can never complete. Our `onblocked` handler still
resolves the `destroy()` promise (so logout itself finishes and the user reaches
`/signin/`), but the real delete stays permanently pending in the browser's IndexedDB
engine. The next sign-in's `indexedDB.open(DB_NAME, ...)` (inside `ensureLoaded`/`init`/
`persistKeyMaterial`) then queues behind that permanently-blocked delete and hangs — exactly
the CDP `Runtime.evaluate` timeout observed, specific to any `kvy-crypto-bridge`
transaction, recoverable only by closing the tab (which force-closes the leaked connection).

### Fix approach

Make `client.ts`'s `terminate()` wait for genuinely in-flight requests to settle (bounded by
a short timeout, so a truly stuck worker still gets killed eventually) before calling
`worker.terminate?.()`. This gives any in-flight `key-storage.ts` operation's `finally {
db.close() }` a real chance to run before the thread dies, closing this class of leak at its
actual source rather than papering over one call site.

**Status: ✅ Implemented — `terminate()` now event-drives a drain: it races `waitForDrain()`
(resolved the moment `pending` empties, hooked into the existing `onmessage`/
`rejectAllPending` paths — no polling) against a 500ms timeout, then calls
`worker.terminate?.()`. A request that genuinely answers within the window resolves with its
real result; `rejectAllPending()` only fires if the timeout wins. Added drain coverage to
`packages/web/src/crypto/__tests__/client-concurrency.test.ts` (fake-timer based: doesn't
kill the thread while unsettled, resolves a request that settles for real before killing it,
kills anyway once the grace period elapses). Full-repo `pnpm typecheck`/`pnpm test` pass. This
touches `packages/web/src/crypto/client.ts` (main-thread code) only — no
`packages/web/src/crypto/worker.ts`/`worker-handler.ts` change, so no `next dev` restart
needed for this one either.**

---

## Bug C — `kvy keys approve` fails with a misleading "not logged in" against a logged-in home dir

### Root cause

`packages/cli/src/auth/tokenProvider.ts`'s `createTokenProvider` captures `refreshToken`
**once**, at construction (`deps.refreshToken`, :52), and never re-reads it from disk. A
refresh that 401s sets `dead = true` (:68-69) and every subsequent call returns `null`
forever — there is no retry, no re-read.

`packages/cli/src/auth/resolveAccessToken.ts`'s `resolveAccessToken()` builds exactly one
such provider per call (`createTokenProviderForCredentials`, :31-45) from whatever
`credentials` its caller already read off disk, and returns its single `getAccessToken()`
result verbatim. `packages/cli/src/commands/keysApprove.ts`'s `runKeysApproveCommand`
(:81-95) reads credentials via `ensureCredentials` once, then calls `resolveAccessToken`
once; a `null` becomes the generic `NO_TTY_CANNOT_SIGN_IN` message (:92-94) — identical
wording whether nothing is signed in at all, or a live account's refresh token merely lost a
race.

The server's refresh tokens are single-use and rotating
(`packages/server/src/app/routes/refresh.ts`): each successful refresh atomically replaces
`refreshTokenHash` and records the *previous* hash with a **60-second grace window**
(`GRACE_MS`, :15) for a benign "two tabs rotated near-simultaneously" race — but presenting
a hash older than that (or more than one rotation behind) gets a clean 401 (:88-100). The
daemon's `machineClient.ts` runs its own long-lived `TokenProvider` that proactively rotates
via `armRenewTimer` (:383-410, every 10 minutes) independent of whatever a one-shot command
does, and the interactive `kvy claude` process (`commands/start.ts`) holds a *third*
independent `TokenProvider` for the life of the session. Any of these writing a fresh
rotation to `access.key` (`onRotate`, `resolveAccessToken.ts:40-42`) between the moment
`keys approve` reads the file and the moment its own `/v1/auth/refresh` call lands makes
that call present an already-superseded (or, once more than one rotation has happened,
completely unknown) hash — a real TOCTOU race between independent processes sharing one
credentials file, not a contrived test artifact, and exactly what the verification pass's
server log (`POST /v1/auth/refresh` → 401 at the moment of an otherwise-live session)
shows.

### Fix approach

`resolveAccessToken()` is the shared choke point every one-shot command already goes
through, so fix it there once rather than in `keysApprove.ts` alone. On a dead provider,
re-read `access.key` from disk — another process may have already persisted the newer
refresh token the original read raced against — and if the re-read credentials actually
differ from what was passed in, retry once with a fresh provider built from them before
giving up. This is a bounded, single retry (no loop, no backoff needed): the race window is
one file write, and if the re-read is identical to what we started with, the account really
is signed out (or the write raced again in a way retrying once more wouldn't reliably fix
either) and the existing `NO_TTY_CANNOT_SIGN_IN` failure is the honest answer.

**Status: ✅ Implemented — `resolveAccessToken()` re-reads `readCredentials(homeDir)` once
on a dead provider and retries with it if the refresh token actually changed. Added
`packages/cli/src/auth/resolveAccessToken.test.ts` (new file) covering: the happy path
unchanged, a dead token with a since-rotated file on disk now succeeding, and a dead token
with an unchanged file on disk still failing honestly. Full-repo `pnpm typecheck`/`pnpm test`
pass (`kvy`/cli: 166 files/1986 tests).**

---

## Bug D — a Kvy-managed session's own transcript re-appears as a duplicate "Unmanaged" card

Follow-up to `docs/auth-ux-fix-verification-results.md`'s Item 3 (Fix 6 — unmanaged sessions
scoping): F6.1–F6.3 all passed, but a related bug was found live and outside the checklist's
wording — a managed session's own local JSONL transcript (written by the real `claude` binary
`kvy_claude_launcher.cjs` wraps) got independently re-surfaced as a second, duplicate
"Unmanaged" card, identical in content to the session already listed correctly under
"Sessions". Confirmed not transient (persisted 10+ minutes across reloads) and confirmed it
scales (2 managed sessions in one directory produced exactly 4 duplicate unmanaged entries).

### Root cause

`packages/cli/src/daemon/transcriptIndexer.ts:100-101,117` defines an `isManaged` hook (`(providerRef:
string) => boolean | Promise<boolean>`) meant to skip a transcript that's already the backing
file for a Kvy-managed session — but `createTranscriptIndexerDeps`'s own default is `()
=> false`, and `packages/cli/src/daemon/machineIntegration.ts` (the only place that wires
`startTranscriptIndexer` into a live daemon) never overrode it — the override list at the
`createTranscriptIndexerDeps` call site was `{ logger: deps.logger }` only. So in production
**nothing was ever recognized as already managed**, regardless of Fix 6's `registeredAt` gate
(which correctly excludes *old* pre-Kvy history by mtime, but has nothing to do with a
session's own *current* transcript).

Wiring a real check required closing a second, deeper gap: the daemon's local session
registry (`packages/cli/src/daemon/sessionRegistry.ts`) never actually knew a tracked
session's real provider (Claude Code) session id. `commands/start.ts`'s terminal PTY flow
(`runLocalPty`, the flow this bug reproduces under) self-reports to the daemon
(`notifyDaemonSessionStarted`, `commands/start.ts:552-568`) once, immediately at startup —
before Claude Code's `SessionStart` hook has fired, so that report's `metadata` (`{title,
path, model}`) never carried a `providerSessionId`. The real provider session id only ever
became known later, inside the same foreground process, via the hook server's `onSessionId`
callback (`commands/start.ts:863-866`) — and was routed only to the local PTY transcript
tailer (`ptyHandle.notifyProviderSessionId`), never relayed to the daemon at all. So even a
naively-real `isManaged` would have had nothing to match against.

### Fix

Two changes, both additive:

1. **`packages/cli/src/commands/start.ts`** — once the `SessionStart` hook reports the real
   provider session id (`onSessionId`), re-send the existing `/session-started` self-report
   (`notifyDaemonSessionStarted`, now factored through a new `notifyDaemonProviderSessionId`
   helper) with `metadata: { ...sessionMetadata, providerSessionId }`, reusing the same
   `sessionEncryptionData` object so the merge in `sessionRegistry.ts`'s `onSessionStarted`
   (keyed by pid) doesn't clobber the already-persisted encryption material. Best-effort, same
   as the original report — never blocks or throws.
2. **`packages/cli/src/daemon/sessionRegistry.ts`** — new `isProviderSessionManaged(providerSessionId)`
   on `SessionRegistry`, checking both the live `pidToSession` map and the durable `resumable`
   set (seeded from `sessions.json` on `restore()`) for a tracked session whose `metadata.providerSessionId`
   matches — so a session Kvy already manages is recognized whether it's still running or
   has already ended, and survives a daemon restart.
   **`packages/cli/src/daemon/machineIntegration.ts`** wires this into the indexer for real:
   `isManaged: (providerRef) => deps.registry.isProviderSessionManaged(providerRef)`, replacing
   the permanent no-op default.

This is the actual "lineage lookup" the module's own doc comment already described as the
intended design — no new store or RPC needed, just closing the gap between what the CLI process
plaintext-knows and what the daemon's own local registry was actually told.

**Scope note (not overclaimed):** this only covers the terminal-attached PTY flow
(`runLocalPty`, the flow the reported repro used and where `kvy_claude_launcher.cjs`-wrapped
transcripts live). `runRemoteLoop` (the headless ACP `--starting-mode remote` flow) has no
equivalent `onProviderSessionId` callback wired at this composition level and still relies on
the same registry state — a session started that way that also gets independently transcript-scanned
would not yet get this same protection. Not the reported bug's flow, left as a known gap.

### Verification

- `pnpm typecheck` (root, all 6 packages) — green.
- `packages/cli` full test suite — 615 suites / 1993 tests, all passing, including new/updated
  coverage: `daemon/sessionRegistry.test.ts` (`isProviderSessionManaged` — unknown id, live
  match, no-id-yet window, survives `pruneDeadSessions`, survives a simulated daemon restart via
  `restore()`), `daemon/machineIntegration.test.ts` (`startTranscriptIndexer` is now wired with
  `isManaged` delegating to the injected registry, not the indexer's own no-op default), and
  `commands/start.test.ts` (the initial self-report never carries `providerSessionId`; the
  `SessionStart` hook triggers a second self-report that does). `daemon/transcriptIndexer.test.ts`
  (pre-existing, unmodified) already covers the indexer module itself correctly skipping
  `upsert` when `isManaged` returns true.
- **Live end-to-end** (fresh throwaway account, real CLI pairing, real `claude` binary via
  `kvy_claude_launcher.cjs`, against the already-running local `@kvy/server`/`@kvy/web`
  stack): signed up a new account, paired a fresh `kvy claude --model haiku` session in an
  isolated temp workspace/home dir, sent it a real prompt, and confirmed
  `~/.kvy/sessions.json`'s persisted metadata for the session carried
  `"providerSessionId": "a3609679-9672-48fa-8112-4781e9f3b051"` — exactly the real Claude Code
  transcript file's id (`~/.claude/projects/.../a3609679-....jsonl`). After the turn completed
  (transcript written, fs-watcher long since debounced/fired), the dashboard showed exactly one
  session card for that workspace — no "Unmanaged sessions" section, no duplicate — confirmed via
  `find` against the live DOM. Torn down cleanly afterward (verified pids/cwd before killing).

**Status: ✅ Implemented — root cause was the `isManaged` hook never being wired in production
(`machineIntegration.ts`) plus the daemon's local session registry never being told the real
provider session id (`commands/start.ts`). Both closed; unit-tested at three layers and
live-verified end-to-end.**

---

## Full-repo verification notes

`pnpm typecheck` is fully green across all 6 packages. `pnpm test` is green for every
package these fixes touch (`kvy`/cli, `@kvy/web`) and for everything else **except**
two pre-existing, unrelated issues already present before this session started (confirmed
against files this session never edited):

- `@kvy/server` — 3 failing tests in `src/app/push/channels/{ntfy,telegram}.test.ts`
  asserting a push notification's deep-link URL is `https://app.kvy.dev/session/…`; the
  actual (correct, current) route is `/dashboard/session/…`. This is fallout from the
  in-progress `(protected)/dashboard/**` route migration already uncommitted in this working
  tree before this session began (`packages/server/src/app/push/channels/messageText.ts` was
  already modified at session start) — the push-channel URL builder just hasn't been updated
  to match yet. Unrelated to auth/crypto/tokens.
- `@kvy/e2e` — fails with `ENOSPC: no space left on device`. The host filesystem is at
  100% capacity (`df -h /`), an environment issue with nothing to do with this session's
  changes.
