# Auth UX Overhaul — Implementation Plan (rev 2)

> **Revision history**
> - **rev 1** — first draft.
> - **rev 2** — rewritten after an independent adversarial review. Three findings in rev 1
>   were serious enough to invalidate whole phases; they are recorded in
>   [What changed in rev 2](#what-changed-in-rev-2) rather than quietly deleted, because
>   the reasoning matters for anyone picking this up later.
>
> **Naming:** the repo already has `docs/plan.md` (the build plan CLAUDE.md points at) and
> `docs/auth-ux-hardening-plan.md`. This follows the same convention and overwrites neither.
>
> **Goal:** make auth feel invisible. Guide the user with words and direction, never with
> jargon or "go run this command yourself".

---

## What changed in rev 2

Rev 1 was reviewed against the real codebase. Three errors were material:

| # | Rev 1 claimed | Reality | Consequence |
|---|---|---|---|
| 1 | A non-extractable `CryptoKey` in IndexedDB protects the master secret from XSS. | **False.** IndexedDB is *origin*-scoped, not worker-scoped. Main-thread XSS opens the same DB (`key-storage.ts:40-43`), gets the handle with its `["encrypt","decrypt"]` usages, and calls `crypto.subtle.decrypt`. Non-extractability blocks `exportKey`, not *use*. | Phase 5's threat table was wrong in the direction that flatters the design. Rewritten in full; WebAuthn PRF promoted from "later" to the primary mechanism. |
| 2 | Phase 4's `accountId` scoping + TTL + single-use claim were sufficient controls. | **Insufficient.** Today's pairing has weak co-presence proof — a human physically opened a URL the CLI printed. Phase 4 removed it, so an attacker holding only a stolen access token can raise a request and phish the approve card. Every listed control is satisfied by that attacker. | Added an out-of-band verification code and a server-attested device row. See [4.3](#43-the-verification-code-non-negotiable). |
| 3 | Item 1 could move the inline login into `commands/start.ts`. | **Breaks the daemon.** `index.ts:331-337` documents why login must precede `ensureDaemon()`: the daemon attempts machine registration *once*, at startup, only if credentials exist then. `runStartClaudeCommand` runs at `index.ts:354`, after `ensureDaemon()` at `:348`. | Login stays in `index.ts`. `start.ts` gets a restartable preflight instead. See [Phase 1](#phase-1--cli-items-18). |

Also acted on: a new prerequisite phase (4a) because a keyless browser has no refresh
token either; item 7(b) cut as an unnecessary breaking wire change; ~10 snippet-level type
errors fixed; and several security details tightened (claim binding, `ephPub` uniqueness,
status codes, expiry sweep, prompt-fatigue controls).

---

## Table of contents

- [Guiding principles](#guiding-principles)
- [Phase 0 — Shared copy modules](#phase-0--shared-copy-modules)
- [Phase 1 — CLI (items 1–8)](#phase-1--cli-items-18)
- [Phase 2 — Web pairing gate order (items 9–15)](#phase-2--web-pairing-gate-order-items-915)
- [Phase 3 — Web onboarding, zero machines (items 16–20)](#phase-3--web-onboarding-zero-machines-items-1620)
- [Phase 4a — Split the session credential from the key material](#phase-4a--split-the-session-credential-from-the-key-material)
- [Phase 4 — Reverse-direction key sharing (items 21–27)](#phase-4--reverse-direction-key-sharing-items-2127)
- [Phase 5 — Remove the PIN (items 28–35)](#phase-5--remove-the-pin-items-2835)
- [Phase 6 — Copy pass (items 36–41)](#phase-6--copy-pass-items-3641)
- [Phase 7 — Later (items 42–45)](#phase-7--later-items-4245)
- [Decisions that need your sign-off](#decisions-that-need-your-sign-off)
- [Task checklist](#task-checklist)
- [Testing plan](#testing-plan)
- [Rollout order and risks](#rollout-order-and-risks)

---

## Guiding principles

1. **Never print "run X" when you can run X.**
2. **Identity first, crypto second.** Sign-in gates always run before key-material gates.
3. **First device = zero questions.** A user with no data never sees a crypto screen.
4. **No internal words in the UI.** Banned: `keyEpoch`, `masterSecret`, `bind`, `custody`,
   `bridge`, `epoch`, `DEK`, `nonce`, `ephPub`.
5. **Never put a destructive button next to a safe one.**
6. **Every waiting screen updates itself.**
7. *(new in rev 2)* **Never claim a security property you have not verified.** If a control
   only raises cost rather than preventing an attack, say so in the same sentence.

---

## Phase 0 — Shared copy modules

*(Unchanged from rev 1 except where noted. Independent — ship first.)*

### 0.1 `packages/cli/src/ui/messages.ts` (new)

```ts
/**
 * Every user-facing string the CLI prints during auth/first-run. Centralised so the
 * "no jargon, no 'go run this yourself'" rules can be enforced in one place.
 */

export const WELCOME_FIRST_RUN =
  "\n  Welcome to Falcon.\n  Let's connect this machine to your account.\n\n";

export const OPENING_BROWSER = "  Opening your browser…\n";

export function pairingUrlFallback(url: string): string {
  return `  If it didn't open, go to:\n  ${url}\n\n`;
}

export const WAITING_FOR_APPROVAL = "  Waiting for approval…  (Ctrl-C to cancel)\n";

export function connectedAs(email: string | null): string {
  return email ? `\n  ✓ Connected as ${email}\n` : "\n  ✓ Connected\n";
}

export const RECONNECTING = "\n  Your session expired. Reconnecting…\n";
export const STARTING_SESSION = "  Starting your session…\n\n";

/**
 * The ONLY hard-fail on the not-signed-in path. Reachable when there is genuinely no
 * human at this terminal.
 *
 * NOTE: contains the literal substring "not logged in" on purpose —
 * `commands/start.test.ts:224` asserts on it, and rewording it without updating that
 * test is a silent break (review finding H3).
 */
export const NO_TTY_CANNOT_SIGN_IN =
  "falcon: not logged in, and there's no terminal here to sign in from.\n" +
  "Run `falcon auth login` on a machine with a browser, then try again.\n";
```

### 0.2 `packages/web/src/lib/copy.ts` (new)

```ts
export const copy = {
  signin: {
    titleDefault: "Sign in to Falcon",
    titleWithPendingPair: "Connect your machine",
    subtitleWithPendingPair: (machine: string) => `Sign in to finish connecting ${machine}.`,
    expiredBanner: "Your session expired — sign in to continue.",
  },

  pair: {
    approveTitle: "Connect this machine?",
    approveWarning: "Only approve this if you just ran `falcon` yourself.",
    approveCta: "Approve",
    cancelCta: "Cancel",
    doneTitle: "Connected",
    doneBody: (machine: string) =>
      `${machine} is connected. Go back to your terminal — your session is starting.`,
    doneCta: "Go to dashboard",
    invalidLink:
      "This link is out of date. Run `falcon` again on your machine to get a fresh one.",
  },

  keys: {
    needKeysTitle: "One more step",
    needKeysBody:
      "Your sessions are end-to-end encrypted, so this browser needs a copy of your keys.",
    // Phase 4 rev 2: the verification code is the security control, so its copy is
    // load-bearing — it must tell the user what to compare and what to do on mismatch.
    codeIntroRequester: "Check that your other device shows this same code:",
    codeIntroApprover: "Make sure the device asking shows this same code:",
    codeMismatch: "Codes don't match? Cancel — someone else may be asking.",
    waitingBody: "This page continues automatically once they arrive.",
    sendCta: "Codes match — send my keys",
    denyCta: "Not now",
    approveTitle: "Send your keys to another device?",
    approveBody: "A device is asking for a copy of your keys so it can read your sessions.",
    cantReach: "Can't reach any of those devices?",
  },

  reset: {
    linkLabel: "Start over with new keys",
    warning: "This permanently erases all past sessions and signs out every other device.",
    confirmCta: "Yes, erase my past sessions",
  },

  onboarding: {
    title: "Connect your first machine",
    subtitle: "Falcon runs on your own computer. Two commands.",
    step1: "Install",
    step1Cmd: "npm install -g falcon",
    step2: "Run it from any project",
    step2Cmd: "cd ~/your-project && falcon",
    step3: "Approve when your browser asks",
    step3Hint: "We'll bring you back here automatically.",
    waiting: "Waiting for your first machine…",
  },
} as const;
```

---

## Phase 1 — CLI (items 1–8)

> **Rev 2 rework.** Rev 1 moved the inline login into `commands/start.ts`. That is wrong:
> `packages/cli/src/index.ts:331-337` documents that login must complete *before*
> `ensureDaemon()` (`:348`), because the daemon attempts machine registration once at
> startup and only if credentials exist then. `runStartClaudeCommand` runs at `:354`.
> A login inside `start.ts` produces a daemon that never registers, and the user hits a
> *different* red wall at `start.ts:469` ("this machine hasn't finished registering").

### The corrected shape

```
index.ts runStart()
  ├─ 1. ensureSignedIn()      ← inline pairing lives HERE, before the daemon
  ├─ 2. ensureDaemon()        ← now always sees credentials
  └─ 3. runStartClaudeCommand()
          └─ preflight() ─┐   ← restartable (item 2)
                          └─ on dead refresh token: re-pair, then RESTART preflight
```

### Item 1 — Make `index.ts` the single sign-in gate

```ts
// packages/cli/src/index.ts — runStart, NEW
async function runStart(command: Extract<FalconCommand, { type: "start" }>): Promise<number> {
  // Auth for EVERY provider, not just claude (item 3) — `startCodex` has the same
  // read-credentials-then-fail shape at commands/startCodex.ts:139.
  const auth = await ensureLoggedIn(logger);
  if (!auth.ok) {
    if (auth.message) process.stderr.write(auth.message);
    return 1;
  }

  // Unchanged and load-bearing: the daemon registers a machine exactly once, at its own
  // startup, and only if credentials exist at that moment (see this function's docblock).
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  …
}
```

Then in `commands/start.ts:423-428`, **delete the hard-fail but keep a guard** — this
function is also reachable from tests and from the daemon's resume path, so it must not
assume `index.ts` ran:

```ts
// packages/cli/src/commands/start.ts — NEW
  // Credentials are guaranteed by `index.ts`'s `ensureLoggedIn` on the interactive path.
  // This guard only fires on the non-interactive entry points (daemon resume, tests),
  // where there is nobody to sign in — so it stays a hard fail, with the same
  // "not logged in" substring `start.test.ts:224` asserts on.
  const credentials = readCreds(deps.homeDir);
  if (!credentials) {
    writeError(NO_TTY_CANNOT_SIGN_IN);
    return 1;
  }
```

**Net effect:** the red error is gone from the interactive path (it never runs — login
happened upstream), the daemon ordering is preserved, and `start.test.ts` still passes
because `NO_TTY_CANNOT_SIGN_IN` contains "not logged in".

### Item 2 — Restartable preflight for a dead refresh token

`start.ts` derives key material *before* it ever touches the network:

| Line | What |
|---|---|
| `:445` | `resolveKeyMaterial(...)` → `masterSecret` (can prompt for a PIN) |
| `:459` | `deriveKeyTree(masterSecret)` → `contentKeyPair` |
| `:464` | `waitForMachineId(...)` → `machineId` |
| `:495` | `tokenProvider.getAccessToken()` ← the failure point rev 1 tried to patch |

Re-pairing at `:495` mints a **new session and possibly a new key epoch**, so `masterSecret`
and `contentKeyPair` from `:445-459` are stale, and the daemon still holds the old
credentials. Patching the token in place silently encrypts the whole session under a dead
key. Extract the whole block into a function and re-run it:

```ts
// packages/cli/src/commands/start.ts — NEW

interface Preflight {
  credentials: FalconCredentials;
  masterSecret: Uint8Array;
  contentKeyPair: KeyTree["content"];
  machineId: string;
  tokenProvider: TokenProvider;
  accessToken: string;
}

type PreflightResult =
  | { ok: true; preflight: Preflight }
  | { ok: false; message: string }
  /** The stored refresh token is dead. The caller may re-pair and try once more. */
  | { ok: false; needsReauth: true };

/**
 * Everything that must be resolved from stored credentials before a session can start.
 * Extracted so item 2 can re-run it WHOLESALE after an inline re-pair: a new pairing can
 * change the account's key epoch, so `masterSecret`/`contentKeyPair`/`machineId` are all
 * potentially stale afterwards — patching only the access token would encrypt the session
 * under a dead key (review finding H2).
 */
async function runPreflight(deps: StartDeps, backendUrl: string): Promise<PreflightResult> {
  const credentials = deps.readCredentials?.(deps.homeDir) ?? readCredentialsDefault(deps.homeDir);
  if (!credentials) return { ok: false, message: NO_TTY_CANNOT_SIGN_IN };

  const masterSecret = await resolveKeyMaterial(
    credentials.keyMaterial,
    deps.homeDir,
    process.stdin.isTTY === true ? {} : undefined,
  );
  if (!masterSecret || masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    return { ok: false, message: REDUCED_CUSTODY_MESSAGE };
  }
  const { content: contentKeyPair } = deriveKeyTree(masterSecret);

  const machineId = await waitForMachineId(deps.homeDir, { … });
  if (!machineId) return { ok: false, message: MACHINE_NOT_REGISTERED_MESSAGE };

  const tokenProvider = createTokenProviderForCredentials(credentials, {
    backendUrl, homeDir: deps.homeDir, fetchImpl, logger,
  });
  const accessToken = await tokenProvider.getAccessToken();
  if (!accessToken) {
    return tokenProvider.isDead
      ? { ok: false, needsReauth: true }
      : { ok: false, message: NETWORK_UNREACHABLE_MESSAGE };
  }

  return {
    ok: true,
    preflight: { credentials, masterSecret, contentKeyPair, machineId, tokenProvider, accessToken },
  };
}
```

Call site:

```ts
  let result = await runPreflight(deps, backendUrl);

  if (!result.ok && "needsReauth" in result) {
    if (process.stdin.isTTY !== true) {
      writeError(NO_TTY_CANNOT_SIGN_IN);
      return 1;
    }
    process.stdout.write(RECONNECTING);
    // `deps.ensureLoggedIn` (item 3) so tests can inject it — `ensureLoggedIn` reads
    // credentials through the module-level reader, not `deps.readCredentials`, so an
    // un-injected call gives a test two contradictory answers (review finding H3).
    if ((await (deps.ensureLoggedIn ?? ensureLoggedInDefault)(logger, deps.homeDir)).ok !== true) {
      return 1;
    }
    // A fresh pairing may have re-registered this machine; the daemon needs to pick the
    // new credentials up before `waitForMachineId` can succeed.
    await deps.restartDaemon?.();

    result = await runPreflight(deps, backendUrl);   // full re-run, not a token patch
    if (!result.ok) {
      writeError("message" in result ? result.message : NO_TTY_CANNOT_SIGN_IN);
      return 1;
    }
  } else if (!result.ok) {
    writeError(result.message);
    return 1;
  }

  const { masterSecret, contentKeyPair, machineId, tokenProvider, accessToken } = result.preflight;
```

> **Open question for you:** `restartDaemon()` does not exist yet. The daemon registers a
> machine once at startup (`daemon/machineIntegration.ts:281`), so after an inline re-pair
> it is running with dead credentials. Options: (a) add a daemon RPC "re-read credentials
> and re-register"; (b) stop/start the daemon; (c) accept one extra `falcon` invocation
> after a re-pair. **(a) is the right answer** but it is real work — see
> [Decisions](#decisions-that-need-your-sign-off).

### Item 3 — One helper, injected

```ts
// packages/cli/src/commands/start.ts — StartDeps additions
  /** Injected so tests can stub it; `ensureLoggedIn` otherwise reads credentials through
   * the module-level reader rather than `deps.readCredentials` (review finding H3). */
  ensureLoggedIn?: (logger: Logger, homeDir: string) => Promise<{ ok: boolean; message?: string }>;
  /** Ask the running daemon to re-read `access.key` and re-register. See item 2. */
  restartDaemon?: () => Promise<void>;
```

Apply the same `runPreflight` shape to `commands/startCodex.ts` (its equivalent block is
`:129-167`).

### Items 4, 6 — New first-run output

```ts
// packages/cli/src/auth/login.ts — runAuthLogin
  process.stdout.write(WELCOME_FIRST_RUN);

  const outcome = await pairDevice({
    backendUrl,
    frontendUrl,
    signal: controller.signal,
    label: os.hostname(),                 // item 7(a) — kept
    cwd: process.cwd(),                   // item 7(a) — kept
    onPairingUrlReady: async (url) => {
      process.stdout.write(OPENING_BROWSER);
      const opened = await openBrowser(url);
      if (!opened) process.stdout.write(pairingUrlFallback(url));
      displayPairingQrCode(url);
      process.stdout.write(WAITING_FOR_APPROVAL);
    },
  });
```

```ts
    writeCredentials({ refreshToken: outcome.result.refreshToken, keyMaterial });
    // item 7(b) rev 2: email comes from GET /v1/auth/pair/status, NOT from the sealed
    // payload — see below.
    process.stdout.write(connectedAs(outcome.result.email ?? null));
    process.stdout.write(STARTING_SESSION);
    return 0;
```

### Item 7 — Machine label + folder (kept); payload version bump (**cut**)

**7(a) — request side. Keep.** `POST /v1/auth/pair` gains optional `label` and `cwd`:

```ts
// packages/server/src/app/api/pair.ts
        body: z.object({
          ephPub: EphPubSchema,
          // Shown on the approve card so the human can see WHAT they're approving.
          // UNTRUSTED display strings: never used for any auth decision, length-capped,
          // and rendered as plain text only — see the approve card in Phase 2 item 11.
          label: z.string().max(80).optional(),
          cwd: z.string().max(200).optional(),
        }),
```

Migration adds `label text`, `cwd text` to `pair_requests`.

**7(b) — sealed payload `v0x02`. CUT.**

Rev 1 proposed bumping the sealed pairing payload to carry the account email. That is a
breaking wire change in the **wrong compatibility direction**: the emitter
(`web/src/crypto/worker-handler.ts:309`) ships instantly to every user, while the decoder
(`cli/src/auth/pair.ts:191`) is an npm global users may never upgrade. Shipping a
v2-emitting web app breaks every installed CLI with `decrypt-failed` (`pair.ts:188-194`).

The email is **not secret**, and item 11 is already extending `GET /v1/auth/pair/status`.
Return it there instead — zero wire risk:

```ts
// packages/server/src/app/api/pair.ts — status response, extended once for items 7+11
        response: {
          200: z.object({
            status: z.enum(["not_found", "pending", "authorized", "expired"]),
            label: z.string().nullable().optional(),
            cwd: z.string().nullable().optional(),
            requestedAt: z.string().nullable().optional(),
            /** Set only once `status === "authorized"`, so the CLI can print
             * "✓ Connected as …". Not secret; the CLI is about to hold a full
             * session for this account anyway. */
            email: z.string().nullable().optional(),
          }),
        },
```

`pairDevice` reads it on the final status poll and returns it in `PairSuccess`. The sealed
payload stays at `v0x01`, untouched.

### Item 5 — Hard-fail only without a TTY

```ts
// packages/cli/src/auth/login.ts
-const NOT_LOGGED_IN_MESSAGE = 'falcon: not logged in — run "falcon auth login" first\n';
+import { NO_TTY_CANNOT_SIGN_IN } from "../ui/messages.js";

   if (process.stdin.isTTY !== true) {
-    return { ok: false, message: NOT_LOGGED_IN_MESSAGE };
+    return { ok: false, message: NO_TTY_CANNOT_SIGN_IN };
   }
```

### Item 8 — Audit `writeError` + lint test

```bash
rg -n 'writeError\(|process\.stderr\.write\(' packages/cli/src --type ts | rg -v '\.test\.'
```

```ts
// packages/cli/src/ui/__tests__/messages.test.ts
import { describe, expect, it } from "vitest";
import * as messages from "../messages.js";

/** Rev 2 (review finding L5): rev 1 only checked plain string exports, which skipped every
 * template function — exactly where jargon is most likely to creep in. Exercise the
 * functions with sample input too. */
function allStrings(): string[] {
  const out: string[] = [];
  for (const value of Object.values(messages)) {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") {
      out.push(String((value as (...a: unknown[]) => string)("sample@example.com")));
      out.push(String((value as (...a: unknown[]) => string)("https://example.com/pair#x")));
    }
  }
  return out;
}

describe("CLI auth copy", () => {
  it("never tells the user to run auth login, except with no terminal", () => {
    const offenders = allStrings().filter(
      (m) => /falcon auth login/.test(m) && !/no terminal here/.test(m),
    );
    expect(offenders).toEqual([]);
  });

  it("uses no internal jargon", () => {
    for (const m of allStrings()) {
      expect(m).not.toMatch(/masterSecret|keyEpoch|ephPub|DEK|custody|\bbind\b/i);
    }
  });

  it("keeps the substring start.test.ts asserts on", () => {
    expect(messages.NO_TTY_CANNOT_SIGN_IN).toContain("not logged in");
  });
});
```

---

## Phase 2 — Web pairing gate order (items 9–15)

> **Verified:** `pair/page.tsx:42-43` really does `if (bridgeStatus.kind !== "ready") return;`
> as the first line of the effect, so the `isSignedIn`/`silentRefresh` gate at `:69` is
> unreachable for a fresh browser, which instead renders the `no-identity` dead end at
> `:136-148`.
>
> **Correction to rev 1:** `reset-keys/page.tsx:86-88` pushes to `/pair/` with **no
> `#ephPub` fragment**, so `pair/page.tsx:58` fails the 32-byte check and renders
> `invalid-link`. It is an immediate hard stop, not a loop. Same fix either way.

### Item 9 — Fix the gate order

```tsx
// packages/web/src/app/(public)/pair/page.tsx — NEW shape
type Gate =
  | { kind: "checking" }
  | { kind: "invalid-link" }
  | { kind: "needs-keys"; ephPub: string }
  | { kind: "confirm"; ephPub: string; label: string | null; cwd: string | null; requestedAt: string | null }
  | { kind: "approving"; ephPub: string }
  | { kind: "approved"; label: string | null }
  | { kind: "error"; message: string; ephPub: string };

export default function PairPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();          // raw client, NOT useUnlockedCryptoBridge
  const [gate, setGate] = useState<Gate>({ kind: "checking" });

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    (async () => {
      // 1. Parse the link — a bad link is bad regardless of auth state.
      const ephPub = parseEphPubFromHash(window.location.hash);
      if (!ephPub) { setGate({ kind: "invalid-link" }); return; }

      // 2. IDENTITY FIRST (principle 2). A signed-out visitor never sees a crypto screen.
      if (!isSignedIn() && !(await silentRefresh())) {
        stashPendingPair(ephPub);
        if (!cancelled) router.replace(SIGNIN_PATH);
        return;
      }

      // 3. What are we approving? (item 11)
      const details = await fetchPairDetails(ephPub).catch(() => null);
      if (cancelled) return;

      // 4. CRYPTO SECOND. No keys here -> Phase 4's panel, not a dead end (item 12).
      const identity = await bridge.getIdentity();
      if (cancelled) return;
      if (!identity) { setGate({ kind: "needs-keys", ephPub }); return; }

      setGate({
        kind: "confirm",
        ephPub,
        label: details?.label ?? null,
        cwd: details?.cwd ?? null,
        requestedAt: details?.requestedAt ?? null,
      });
    })();

    return () => { cancelled = true; };
  }, [bridge, router]);
  …
}
```

> Rev 2 fixes review finding M7: rev 1's render block referenced `gate.kind === "approved"`
> and `gate.requestedAt`, neither of which existed in its `Gate` union. Both are members now.

```ts
// packages/web/src/app/(public)/pair/parse-eph-pub.ts (new)
import { decodeBase64, encodeBase64 } from "@falcon/crypto/web";

const X25519_PUBLIC_KEY_BYTES = 32;

/**
 * The CLI writes the fragment as base64url; the server keys the row by PLAIN base64
 * (a string comparison, not a byte comparison — api/pair.ts). Convert once, here, so no
 * caller can forget. Returns null for anything that isn't a 32-byte key.
 *
 * In its own module because a Next.js `page.tsx` may only export the default component
 * plus known metadata fields — same reason `pair-gate.ts` exists.
 */
export function parseEphPubFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const bytes = decodeBase64(raw, "base64url");
  return bytes.length === X25519_PUBLIC_KEY_BYTES ? encodeBase64(bytes) : null;
}
```

### Item 10 — Sign-in page explains why you're there

```ts
// packages/web/src/lib/pending-pair.ts — add
/** Read without consuming — the sign-in page needs to KNOW a pairing is pending (to change
 * its heading) without spending it. Only the pair page consumes. */
export function peekPendingPair(): string | null {
  return window.sessionStorage.getItem(PENDING_PAIR_KEY);
}
```

```tsx
// signin/page.tsx
const [banner, setBanner] = useState<"expired" | "pair" | null>(null);
useEffect(() => {
  if (isExpiredReason(window.location.search)) { setBanner("expired"); return; }
  if (peekPendingPair()) setBanner("pair");
}, []);
```

### Item 11 — Show what is being approved

```tsx
{gate.kind === "confirm" && (
  <div className="w-full max-w-sm space-y-4 text-left">
    <h1 className="text-xl font-semibold">{copy.pair.approveTitle}</h1>
    <dl className="rounded-lg border p-4 text-sm">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Machine</dt>
        <dd className="font-medium">{gate.label ?? "Unknown machine"}</dd>
      </div>
      {gate.cwd && (
        <div className="mt-2 flex justify-between gap-4">
          <dt className="text-muted-foreground">Folder</dt>
          <dd className="truncate font-mono text-xs">{gate.cwd}</dd>
        </div>
      )}
      {gate.requestedAt && (
        <div className="mt-2 flex justify-between gap-4">
          <dt className="text-muted-foreground">Requested</dt>
          <dd>{formatRelative(gate.requestedAt)}</dd>
        </div>
      )}
    </dl>
    <p className="text-sm text-muted-foreground">{copy.pair.approveWarning}</p>
    <div className="flex gap-3">
      <Button onClick={() => void approve(gate.ephPub, gate.label)}>{copy.pair.approveCta}</Button>
      <Button variant="outline" onClick={() => router.replace("/dashboard/")}>
        {copy.pair.cancelCta}
      </Button>
    </div>
  </div>
)}
```

### Items 12–15

Item 12 renders `<RequestKeysPanel />` (Phase 4) for `needs-keys`. Items 13–15 unchanged
from rev 1 — success screen, plus `StartOverLink` demoting and renaming the destructive path:

```tsx
// packages/web/src/components/auth/start-over-link.tsx (new)
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/copy";

/** The ONLY entry point to the destructive rotation flow (items 14/15). A link, never a
 * primary button, and it always states what it erases first. */
export function StartOverLink() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground underline underline-offset-4"
        onClick={() => setOpen(true)}
      >
        {copy.keys.cantReach}
      </button>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-destructive/40 p-4 text-left">
      <p className="text-sm font-medium text-destructive">{copy.reset.linkLabel}</p>
      <p className="text-sm text-muted-foreground">{copy.reset.warning}</p>
      <div className="flex gap-2">
        <Button variant="destructive" size="sm" onClick={() => router.push("/reset-keys/")}>
          {copy.reset.confirmCta}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
```

Also fix `reset-keys/page.tsx:86-88` so "Pair from another device" is not a hard stop: it
should render `RequestKeysPanel` inline rather than pushing to a fragment-less `/pair/`.

---

## Phase 3 — Web onboarding, zero machines (items 16–20)

*(Unchanged from rev 1 — the review found this phase correct and low-risk.)*

`session-list-screen.tsx:81-93` shows "any **paired** machine" with zero machines, and
`:89-91` renders "New session" unconditionally. `snapshot.machines` is in scope at `:62`.

```tsx
// packages/web/src/features/session-list/components/first-machine-onboarding.tsx (new)
"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { copy } from "@/lib/copy";

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="flex-1 overflow-x-auto font-mono text-xs">{command}</code>
      <button
        type="button"
        aria-label={`Copy: ${command}`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/**
 * Shown instead of "No sessions yet" when the account has NO machines at all. Advances by
 * itself: the parent re-renders from the same `['sync']` snapshot the socket keeps fresh,
 * so registering a machine makes this disappear with no refresh (principle 6).
 */
export function FirstMachineOnboarding() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-6 p-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{copy.onboarding.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.onboarding.subtitle}</p>
      </div>

      <ol className="space-y-5">
        <li className="space-y-2">
          <p className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">1</span>{copy.onboarding.step1}
          </p>
          <CopyableCommand command={copy.onboarding.step1Cmd} />
        </li>
        <li className="space-y-2">
          <p className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">2</span>{copy.onboarding.step2}
          </p>
          <CopyableCommand command={copy.onboarding.step2Cmd} />
        </li>
        <li className="space-y-1">
          <p className="text-sm font-medium">
            <span className="mr-2 text-muted-foreground">3</span>{copy.onboarding.step3}
          </p>
          <p className="pl-6 text-sm text-muted-foreground">{copy.onboarding.step3Hint}</p>
        </li>
      </ol>

      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {copy.onboarding.waiting}
        </p>
      </div>
    </div>
  );
}
```

```tsx
// session-list-screen.tsx
  const hasMachines = snapshot.machines.length > 0;

  if (!hasMachines && unmanagedSnapshot.sessions.length === 0) {
    return <FirstMachineOnboarding />;
  }
  …
  {hasMachines && (
    <Button asChild size="sm"><Link href="/dashboard/session/new/">New session</Link></Button>
  )}
```

Guard `/dashboard/session/new/` the same way (`features/new-session/components/machine-step.tsx`).

---

## Phase 4a — Split the session credential from the key material

> **New in rev 2. This is a prerequisite for Phase 4** and it exists because of review
> finding M1.

### The problem

Phase 4's whole premise is "a browser that is **signed in** but has **no keys**". That state
is barely reachable today, because the refresh token lives *inside the same IndexedDB
record as the master secret* (`key-storage.ts:17-32`) and the access token is in-memory only
(`session.ts:25`). So a keyless browser has no session either:

- `silentRefresh()` → `getSharedCryptoBridge()` → `null` (worker not unlocked) → `false`.
- `RequireAuth`'s effect early-returns unless `status.kind === "ready"`
  (`require-auth.tsx:74`), so `sessionReady` never flips and `getToken()` stays `null`.
- `RequestKeysPanel` would call `getToken()`, get `null`, and spin forever — **the exact
  dead end Phase 4 exists to remove.**

### The fix

Store the refresh token in its **own** IndexedDB record, independent of key material.

```ts
// packages/web/src/crypto/session-storage.ts (new)
/**
 * Phase 4a: the SESSION credential (refresh token), stored separately from the CONTENT
 * credential (master secret).
 *
 * Rationale: identity and key custody are separate systems (docs/issue-4-plan.md §3.3),
 * but the storage layer fused them — the refresh token was PIN-wrapped inside the master
 * secret's record, so a browser without keys could not hold a session. That made the
 * "signed in, no keys" state unreachable, which is precisely the state device-to-device
 * key sharing must operate in.
 *
 * Wrapped under its own non-extractable AES-GCM key.
 *
 * ⚠️ HONEST SCOPE OF THAT PROTECTION (review finding C1): non-extractability prevents
 * `exportKey`, NOT use. Same-origin script — including XSS — can open this store, take the
 * handle, and call `crypto.subtle.decrypt`. What the wrap actually buys is narrow: a raw
 * file/backup copy of the IndexedDB store yields ciphertext rather than a usable token,
 * and it is strictly better than `localStorage`. It is NOT an XSS defense. Nothing stored
 * in a browser is.
 *
 * Why that is acceptable HERE and would not be for the master secret: the refresh token
 * rotates on every use, is theft-detectable (a replay revokes the whole family —
 * server/src/app/routes/refresh.ts:88), is revocable per device from Settings → Devices,
 * and expires absolutely after 60 days. The master secret has none of those properties —
 * it decrypts everything, forever, and cannot be rotated without destroying old data.
 */
export interface StoredSessionRecord {
  v: 1;
  wrapKey: CryptoKey;                        // extractable: false
  wrapped: { nonce: Uint8Array; ct: Uint8Array };
}

const DB_NAME = "falcon-session";            // separate DB from `falcon-crypto-bridge`
```

The worker gains `setRefreshToken` / `refreshSession` behaviour that **no longer depends on
`keyTree` or a PIN**:

```ts
// packages/web/src/crypto/worker-handler.ts — rev 2
        case "setRefreshToken": {
          // Phase 4a: no longer requires an unlocked worker. A signed-in browser with no
          // key material must still be able to persist its session.
          refreshToken = request.refreshToken;
          await sessionStorage.save(refreshToken);
          return { id: request.id, ok: true, result: null };
        }

        case "refreshSession": {
          // Load lazily from the session store — independent of key material entirely.
          refreshToken ??= await sessionStorage.load();
          if (!refreshToken) return { id: request.id, ok: true, result: null };
          …unchanged fetch…
          refreshToken = body.refreshToken;
          await sessionStorage.save(refreshToken);
          return { id: request.id, ok: true, result: body.accessToken };
        }
```

And `getSharedCryptoBridge()` (`use-crypto-bridge.ts:108`) must stop gating on `unlocked`,
because refreshing no longer needs an unlocked worker:

```ts
/** Rev 2 (Phase 4a): previously returned null unless the worker was unlocked, because the
 * refresh token only existed PIN-wrapped inside it. The session credential now lives in
 * its own store, so a refresh works regardless of key state — which is what lets a keyless
 * browser stay signed in long enough to ask for keys. */
export function getSharedCryptoBridge(): CryptoBridgeClient | null {
  return sharedBridge;
}
```

`RequireAuth` must also stop making session-ensure conditional on crypto readiness:

```tsx
// require-auth.tsx — rev 2: session first, keys second (principle 2)
  useEffect(() => {
    let cancelled = false;
    async function ensureSession(): Promise<void> {
      if (isSignedIn()) { if (!cancelled) setSessionReady(true); return; }
      const refreshed = await silentRefresh();
      if (cancelled) return;
      if (refreshed) setSessionReady(true);
      else router.replace(SIGNIN_EXPIRED_PATH);
    }
    void ensureSession();
    const interval = setInterval(() => void ensureSession(), EXPIRY_CHECK_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [router]);          // ← no longer depends on bridge status
```

### Migration

A one-time copy on worker start: if the legacy record has `wrappedRefreshToken` and the
session store is empty, and the worker is unlocked (PIN era) or loadable (post-Phase-5),
copy it across and clear the old field. Users who never unlock simply re-authenticate.

**This phase is independently shippable and worth doing on its own** — it fixes the
architectural fusion, not just Phase 4's prerequisite.

---

## Phase 4 — Reverse-direction key sharing (items 21–27)

> **Rev 2 rework.** Rev 1's controls (authenticated, `accountId`-scoped, TTL, single-use
> claim, plain-text label) are all satisfied by an attacker holding a stolen access token.
> Today's pairing has weak co-presence proof — a human physically opened a URL the CLI
> printed. Removing that without replacing it converts token theft into full plaintext
> compromise, breaking `falcon-system-design.md` §5.3's identity-plane/content-plane
> separation. The verification code below is the replacement, and it is **not optional**.

### 4.1 Schema

```ts
// packages/server/src/db/schema.ts (append)

/**
 * A device that already has an account session but no key material asks one of the
 * account's other devices for a copy.
 *
 * Deliberately a separate table from `pair_requests`, whose pickup route is
 * unauthenticated by necessity (a pairing CLI has no session yet) — every route touching
 * this one requires `app.authenticate` AND an accountId match.
 *
 * `response` is the sealed box `[0x02 | masterSecret]`; the server cannot open it.
 */
export const keyRequests = pgTable(
  "key_requests",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    ephPub: text("eph_pub").notNull(),
    /** The device session that RAISED the request. Only this session may claim the
     * response (review finding M3) — an accountId match alone would let any session of
     * the account, including an attacker's, consume a legitimate delivery. */
    requestedBySessionId: text("requested_by_session_id").notNull(),
    /** Untrusted display string. Never used for an auth decision. */
    label: text("label"),
    response: bytea("response"),
    approvedBySessionId: text("approved_by_session_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    // Rev 2 (review finding M2): scoped, NOT globally unique. A global unique index on
    // `ephPub` lets anyone who observes a broadcast key pre-insert a colliding row under
    // their own account and permanently deny delivery to the victim.
    uniqueIndex().on(t.accountId, t.ephPub),
    index().on(t.accountId),
  ],
);
```

### 4.2 The ephemeral

```ts
// packages/wire/src/updates.ts — append to EphemeralSchema
  z.object({
    t: z.literal("key-request"),
    ephPub: z.string(),
    label: z.string().nullable(),
  }),
```

> ⚠️ **Rev 2 correction (review finding M5).** Rev 1 claimed old clients would "ignore"
> this. They will not: `EphemeralSchema` is a `z.discriminatedUnion`
> (`wire/src/updates.ts:79`) and `apiSocket.ts:313-317` does `safeParse` then
> `console.error("apiSocket: dropped a malformed \`ephemeral\` payload")`. A stale,
> service-worker-cached PWA build logs an error per broadcast and never shows the card.
> The repo's additive-only rule is about **optional fields** (see `needsReauth`,
> `updates.ts:89-95`), not new union members.
>
> **Consequences:** `@falcon/wire` builds first (CLAUDE.md), so this gates the phase; and
> `packages/web/public/sw.js` needs a cache-bust so clients actually pick up the new bundle.
> The polling fallback in `RequestKeysPanel` is what keeps stale clients functional.

### 4.3 The verification code (non-negotiable)

```ts
// packages/web/src/lib/verification-code.ts (new)
/**
 * A 6-digit code derived from the requester's ephemeral public key, shown on BOTH screens.
 *
 * What it defends against:
 *  1. Phishing via a stolen access token — an attacker can raise a request and make the
 *     card appear, but cannot make their code match what the victim's own screen shows,
 *     because the victim is not looking at the attacker's screen. The approver is told to
 *     compare against the device *in front of them*.
 *  2. A malicious or compromised RELAY substituting its own ephemeral key: the requester
 *     displays the code for the key IT generated; the approver displays the code for the
 *     key the server delivered. Substitution makes them differ.
 *
 * What it does NOT defend against: a user who approves without looking. That is why the
 * approve button is labelled "Codes match — send my keys" rather than "Approve".
 */
export async function verificationCode(ephPub: string): Promise<string> {
  const bytes = new TextEncoder().encode(ephPub);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const n =
    ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

/** "418 902" — grouped for readability when comparing across two screens. */
export function formatVerificationCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
```

The approve card must additionally render a **server-attested** device row *above* the
untrusted `label` — `clientKind`, `createdAt`, and `lastRefreshedAt` come from the
`device_sessions` row for `requestedBySessionId`, not from the requester.

### 4.4 Routes

```ts
// packages/server/src/app/routes/keyRequests.ts (new)
/**
 * `POST /v1/keys/request` + `GET /v1/keys/requests` + `POST /v1/keys/request/approve`
 * + `POST /v1/keys/request/claim`.
 *
 * Every route requires `app.authenticate` and scopes by `request.accountId`. The server
 * relays an opaque sealed box and holds no keys, exactly like `api/pair.ts`.
 */
import { decodeBase64, encodeBase64 } from "@falcon/crypto";
import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { deviceSessions, keyRequests } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { buildKeyRequestEphemeral, type EventRouterPort } from "../events/eventRouter.js";

const X25519_PUBLIC_KEY_BYTES = 32;
/** Shorter than pairing's 15 minutes: both devices are already signed in and present. */
const KEY_REQUEST_TTL_MS = 5 * 60 * 1000;

const ErrorSchema = z.object({ error: z.string() });
const EphPubSchema = z.string().min(1);

function isValidEphPub(ephPub: string): boolean {
  return decodeBase64(ephPub).length === X25519_PUBLIC_KEY_BYTES;
}

export function buildKeyRequestRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/keys/request",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ ephPub: EphPubSchema, label: z.string().max(80).optional() }),
          // Rev 2 (review finding M8): 400, not 401. This route already passed
          // `authenticate`, so a 401 reads as "your token is dead" to any client with a
          // 401 interceptor and triggers a spurious re-auth loop.
          response: { 200: z.object({ success: z.literal(true) }), 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        const { ephPub, label } = request.body;
        if (!isValidEphPub(ephPub)) return reply.code(400).send({ error: "Invalid public key" });

        const now = new Date();
        // Review finding M4: opportunistic sweep. Sealed master-secret boxes must not
        // accumulate — approved-but-never-claimed rows would otherwise live forever.
        await db.delete(keyRequests).where(lt(keyRequests.expiresAt, now));

        // Upsert WITH a TTL refresh — `onConflictDoNothing` would leave an expired row
        // permanently un-renewable (review finding M2).
        await db
          .insert(keyRequests)
          .values({
            accountId: request.accountId,
            ephPub,
            requestedBySessionId: request.sessionId,
            label,
            expiresAt: new Date(now.getTime() + KEY_REQUEST_TTL_MS),
          })
          .onConflictDoUpdate({
            target: [keyRequests.accountId, keyRequests.ephPub],
            set: {
              requestedBySessionId: request.sessionId,
              label,
              response: null,
              expiresAt: new Date(now.getTime() + KEY_REQUEST_TTL_MS),
            },
          });

        eventRouter.emitEphemeral({
          accountId: request.accountId,
          payload: buildKeyRequestEphemeral(ephPub, label ?? null),
          recipientFilter: { type: "all-user-authenticated-connections" },
        });

        return reply.send({ success: true });
      },
    );

    app.get(
      "/v1/keys/requests",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          response: {
            200: z.object({
              requests: z.array(
                z.object({
                  ephPub: z.string(),
                  label: z.string().nullable(),
                  createdAt: z.string(),
                  // 4.3: server-attested facts about the asking device, shown ABOVE the
                  // untrusted `label` so the approver has something the requester cannot forge.
                  requesterClientKind: z.string().nullable(),
                  requesterCreatedAt: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      async (request, reply) => {
        const rows = await db.query.keyRequests.findMany({
          where: and(
            eq(keyRequests.accountId, request.accountId),
            isNull(keyRequests.response),
            gt(keyRequests.expiresAt, new Date()),
          ),
        });

        const sessions = await db.query.deviceSessions.findMany({
          where: eq(deviceSessions.accountId, request.accountId),
        });
        const byId = new Map(sessions.map((s) => [s.id, s]));

        return reply.send({
          requests: rows.map((r) => {
            const requester = byId.get(r.requestedBySessionId);
            return {
              ephPub: r.ephPub,
              label: r.label,
              createdAt: r.createdAt.toISOString(),
              requesterClientKind: requester?.clientKind ?? null,
              requesterCreatedAt: requester?.createdAt.toISOString() ?? null,
            };
          }),
        });
      },
    );

    app.post(
      "/v1/keys/request/approve",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ ephPub: EphPubSchema, response: z.string().min(1) }),
          response: { 200: z.object({ success: z.literal(true) }), 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        // A device may not approve its own request — otherwise a single compromised
        // session both asks and answers.
        const updated = await db
          .update(keyRequests)
          .set({
            response: decodeBase64(request.body.response),
            approvedBySessionId: request.sessionId,
          })
          .where(
            and(
              eq(keyRequests.ephPub, request.body.ephPub),
              eq(keyRequests.accountId, request.accountId),
              isNull(keyRequests.response),
              gt(keyRequests.expiresAt, new Date()),
              // self-approval guard
              ne(keyRequests.requestedBySessionId, request.sessionId),
            ),
          )
          .returning({ id: keyRequests.id });

        if (updated.length === 0) return reply.code(404).send({ error: "Request not found" });
        return reply.send({ success: true });
      },
    );

    app.post(
      "/v1/keys/request/claim",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: z.object({ ephPub: EphPubSchema }),
          response: {
            200: z.union([
              z.object({ state: z.literal("pending") }),
              z.object({ state: z.literal("expired") }),
              z.object({ state: z.literal("ready"), response: z.string() }),
            ]),
          },
        },
      },
      async (request, reply) => {
        // Single-use pickup, bound to the session that RAISED the request (finding M3).
        const [picked] = await db
          .delete(keyRequests)
          .where(
            and(
              eq(keyRequests.ephPub, request.body.ephPub),
              eq(keyRequests.accountId, request.accountId),
              eq(keyRequests.requestedBySessionId, request.sessionId),
              isNotNull(keyRequests.response),
            ),
          )
          .returning();

        if (picked?.response) {
          if (picked.expiresAt.getTime() < Date.now()) return reply.send({ state: "expired" });
          return reply.send({ state: "ready", response: encodeBase64(picked.response) });
        }

        const row = await db.query.keyRequests.findFirst({
          where: and(
            eq(keyRequests.ephPub, request.body.ephPub),
            eq(keyRequests.accountId, request.accountId),
            eq(keyRequests.requestedBySessionId, request.sessionId),
          ),
        });
        if (!row || row.expiresAt.getTime() < Date.now()) return reply.send({ state: "expired" });
        return reply.send({ state: "pending" });
      },
    );
  };
}
```

Register in `server.ts` next to `pairRoutes` (`:206`):

```ts
+import { buildKeyRequestRoutes } from "./routes/keyRequests.js";
 await app.register(pairRoutes);
+await app.register(buildKeyRequestRoutes(db, eventRouter));
```

```ts
// packages/server/src/app/events/eventRouter.ts — next to buildMachinePresenceEphemeral
/** Pushed to every authenticated connection of the account so a holder can offer to
 * approve without polling. Carries no secret — only a public key and a display label. */
export function buildKeyRequestEphemeral(ephPub: string, label: string | null): Ephemeral {
  return { t: "key-request", ephPub, label };
}
```

> **Known limitation (review finding L1).** The global rate limiter keys on
> `req.accountId || req.ip` at `hook: "preHandler"` (`server.ts:162-168`), but app-level
> preHandlers run *before* route-level `preHandler: app.authenticate`, so `req.accountId`
> is still `""` (`auth/plugin.ts:48`) and these limits are effectively per-IP. An attacker
> on a different IP gets their own prompt budget. The per-device suppression in 4.6 is the
> real control; fixing the keyer is a separate, pre-existing issue worth filing.

### 4.5 Worker ops

```ts
// packages/web/src/crypto/protocol.ts — append to the union + results map
export interface BeginKeyRequestRequest { id: string; type: "beginKeyRequest" }
export interface AcceptKeyResponseRequest { id: string; type: "acceptKeyResponse"; sealed: string }
export interface SealKeysForPeerRequest { id: string; type: "sealKeysForPeer"; ephPub: string }

// CryptoWorkerResults additions:
//   beginKeyRequest: string;     // base64 ephemeral public key
//   acceptKeyResponse: boolean;
//   sealKeysForPeer: string;     // base64 sealed box
```

```ts
// packages/web/src/crypto/client.ts — CryptoBridgeClient additions (rev 2: rev 1 forgot these)
  /** Generate an ephemeral keypair inside the worker and return only its public half. */
  beginKeyRequest(): Promise<string>;
  /** Open a sealed `[0x02 | masterSecret]` box with the ephemeral secret held in the
   * worker, then derive and persist. Resolves false on any failure. */
  acceptKeyResponse(sealed: string): Promise<boolean>;
  /** Seal ONLY the master secret to a peer's ephemeral public key (no refresh token —
   * the requester already has its own session). */
  sealKeysForPeer(ephPub: string): Promise<string>;

// …and in the returned object:
    beginKeyRequest: () => call<string>({ type: "beginKeyRequest" }),
    acceptKeyResponse: (sealed) => call<boolean>({ type: "acceptKeyResponse", sealed }),
    sealKeysForPeer: (ephPub) => call<string>({ type: "sealKeysForPeer", ephPub }),
```

```ts
// packages/web/src/crypto/worker-handler.ts
// ⚠️ Rev 2: `@falcon/crypto/web` exports NO keypair generator (verified against
// packages/crypto/src/index.web.ts) — rev 1's `boxKeyPair()` does not exist. Either import
// tweetnacl directly here, or add an export to the crypto package. Prefer the export, so
// the worker bundle keeps one source of keypair generation:
//     // packages/crypto/src/encryption.web.ts
//     export function generateEphemeralKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array }
import { generateEphemeralKeyPair } from "@falcon/crypto/web";

const KEY_SHARE_PAYLOAD_VERSION = 0x02;

// Rev 2 (review finding H6): keyed by ephPub, NOT a single variable. The worker is a
// refcounted singleton shared app-wide (use-crypto-bridge.ts:29-55), so two concurrent
// requests with one slot would destroy the first request's secret while its claim still
// consumed (and deleted) the sealed box — losing the key material outright.
const pendingKeyRequests = new Map<string, Uint8Array>();
const MAX_PENDING_KEY_REQUESTS = 4;

// …in handle()'s switch:
        case "beginKeyRequest": {
          await ready;
          if (pendingKeyRequests.size >= MAX_PENDING_KEY_REQUESTS) {
            return { id: request.id, ok: false, error: "too-many-key-requests" };
          }
          const kp = generateEphemeralKeyPair();
          const ephPub = encodeBase64(kp.publicKey);
          pendingKeyRequests.set(ephPub, kp.secretKey);   // secret never leaves the worker
          return { id: request.id, ok: true, result: ephPub };
        }

        case "acceptKeyResponse": {
          await ready;
          // Try every in-flight ephemeral secret — the caller doesn't tell us which one,
          // and there are at most MAX_PENDING_KEY_REQUESTS.
          for (const [ephPub, secretKey] of pendingKeyRequests) {
            const payload = libsodiumDecryptWithSecretKey(
              decodeBase64(request.sealed),
              secretKey,
            );
            if (
              !payload ||
              payload.length !== 1 + 32 ||
              payload[0] !== KEY_SHARE_PAYLOAD_VERSION
            ) {
              continue;
            }
            const secret = payload.slice(1, 33);
            deriveFrom(secret);
            pendingKeyRequests.delete(ephPub);
            if (!keyTree) return { id: request.id, ok: true, result: false };
            await persistKeyMaterial(secret, keyTree);
            activeDek = null;
            return { id: request.id, ok: true, result: true };
          }
          return { id: request.id, ok: true, result: false };
        }

        case "sealKeysForPeer": {
          if (!(await ensureLoaded())) {
            return { id: request.id, ok: false, error: await keyDependentError(storage) };
          }
          const ephPub = decodeBase64(request.ephPub);
          if (ephPub.length !== X25519_PUBLIC_KEY_BYTES) {
            return { id: request.id, ok: false, error: "invalid-eph-pub" };
          }
          await ready;
          const payload = new Uint8Array(1 + masterSecret!.length);
          payload[0] = KEY_SHARE_PAYLOAD_VERSION;
          payload.set(masterSecret!, 1);
          return {
            id: request.id,
            ok: true,
            result: encodeBase64(libsodiumEncryptForPublicKey(payload, ephPub)),
          };
        }
```

> `persistKeyMaterial` is the storage writer. **Pre-Phase-5** it is the existing PIN path,
> so `acceptKeyResponse` takes an extra `pin` argument; **post-Phase-5** it is the
> Phase 5 writer and the argument goes away. Rev 1 referenced it without saying this,
> which contradicted its own "independently shippable" claim.

### 4.6 API client

```ts
// packages/web/src/lib/api.ts — append (rev 1 imported these without defining them)
export function createKeyRequest(
  token: string,
  body: { ephPub: string; label?: string },
): Promise<{ success: true }> {
  return postJson("/v1/keys/request", body, token);
}

export function listKeyRequests(token: string): Promise<{
  requests: Array<{
    ephPub: string;
    label: string | null;
    createdAt: string;
    requesterClientKind: string | null;
    requesterCreatedAt: string | null;
  }>;
}> {
  return getJson("/v1/keys/requests", token);
}

export function approveKeyRequest(
  token: string,
  body: { ephPub: string; response: string },
): Promise<{ success: true }> {
  return postJson("/v1/keys/request/approve", body, token);
}

export function claimKeyRequest(
  token: string,
  ephPub: string,
): Promise<
  { state: "pending" } | { state: "expired" } | { state: "ready"; response: string }
> {
  return postJson("/v1/keys/request/claim", { ephPub }, token);
}
```

### 4.7 Requester UI

```tsx
// packages/web/src/components/auth/request-keys-panel.tsx (new)
"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StartOverLink } from "@/components/auth/start-over-link";
import { Button } from "@/components/ui/button";
import { claimKeyRequest, createKeyRequest, listDeviceSessions } from "@/lib/api";
import { copy } from "@/lib/copy";
import { describeThisBrowser } from "@/lib/describe-device";
import { getToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { formatVerificationCode, verificationCode } from "@/lib/verification-code";

const POLL_MS = 2000;

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; code: string; devices: string[] }
  | { kind: "error"; message: string };

/**
 * Shown wherever this browser is signed in but has no key material: it asks the account's
 * other devices for a copy instead of dead-ending on the destructive rotate flow.
 *
 * Continues by itself (principle 6): polls `claim` until the sealed box appears.
 */
export function RequestKeysPanel({ onReady }: { onReady: () => void }) {
  const bridge = useCryptoBridge();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });

  // Rev 2 (review finding H5): both call sites pass an inline arrow, so a raw `onReady`
  // in the deps array gives a new identity every render — the effect re-ran, minting a
  // fresh keypair and POSTing a new request each time, popping a new card on the holder
  // device until the rate limit tripped. Pin it in a ref and depend only on `bridge`.
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  const start = useCallback(async (signal: { cancelled: boolean }) => {
    if (!bridge) return;
    const token = getToken();
    if (!token) {
      setPhase({ kind: "error", message: "You've been signed out. Sign in again." });
      return;
    }

    const ephPub = await bridge.beginKeyRequest();
    const code = await verificationCode(ephPub);
    await createKeyRequest(token, { ephPub, label: describeThisBrowser() });

    const sessions = await listDeviceSessions(token).catch(() => null);
    if (signal.cancelled) return;
    setPhase({
      kind: "waiting",
      code,
      devices: (sessions?.sessions ?? [])
        .filter((s) => !s.isCurrent)
        .map((s) => s.label ?? s.clientKind),
    });

    const poll = async (): Promise<void> => {
      if (signal.cancelled) return;
      try {
        const result = await claimKeyRequest(token, ephPub);
        if (result.state === "ready") {
          const ok = await bridge.acceptKeyResponse(result.response);
          if (ok) { onReadyRef.current(); return; }
          setPhase({ kind: "error", message: "Those keys couldn't be read. Try again." });
          return;
        }
        if (result.state === "expired") {
          setPhase({ kind: "error", message: "The request timed out. Reload to try again." });
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      setTimeout(() => void poll(), POLL_MS);
    };
    setTimeout(() => void poll(), POLL_MS);
  }, [bridge]);

  useEffect(() => {
    const signal = { cancelled: false };
    void start(signal);
    return () => { signal.cancelled = true; };
  }, [start]);

  return (
    <div className="flex w-full max-w-sm flex-col gap-5 text-left">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{copy.keys.needKeysTitle}</h1>
        <p className="text-sm text-muted-foreground">{copy.keys.needKeysBody}</p>
      </div>

      {phase.kind === "waiting" && (
        <>
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <p className="text-sm text-muted-foreground">{copy.keys.codeIntroRequester}</p>
            <p className="mt-2 font-mono text-3xl tracking-[0.2em]">
              {formatVerificationCode(phase.code)}
            </p>
          </div>

          <ul className="divide-y rounded-lg border">
            {phase.devices.map((d) => (
              <li key={d} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>{d}</span>
                <span className="text-xs text-muted-foreground">Waiting…</span>
              </li>
            ))}
            {phase.devices.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">
                No other devices are signed in. Run{" "}
                <code className="rounded bg-muted px-1">falcon keys approve</code> on a
                machine that has your keys.
              </li>
            )}
          </ul>

          <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {copy.keys.waitingBody}
          </div>
        </>
      )}

      {phase.kind === "error" && <p className="text-sm text-destructive">{phase.message}</p>}
      <StartOverLink />
    </div>
  );
}
```

`describeThisBrowser()` — the helper rev 1 used but never defined:

```ts
// packages/web/src/lib/describe-device.ts (new)
/** A coarse, human-readable name for THIS browser, used only as a display label on the
 * approve card. Never an auth input. */
export function describeThisBrowser(): string {
  const ua = navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : "Browser";
  const os =
    /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : "device";
  return `${browser} on ${os}`;
}
```

### 4.8 Holder UI — with prompt-fatigue controls

```tsx
// packages/web/src/components/auth/key-request-listener.tsx (new)
"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { approveKeyRequest, listKeyRequests } from "@/lib/api";
import { copy } from "@/lib/copy";
import { getToken } from "@/lib/session";
import { apiSocket } from "@/sync";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { formatVerificationCode, verificationCode } from "@/lib/verification-code";

type Card = {
  ephPub: string;
  label: string | null;
  code: string;
  requesterClientKind: string | null;
  requesterCreatedAt: string | null;
};

/**
 * Mounted once in the protected layout. Never auto-approves — this is the one moment a
 * human decides whether a new device gets read access to everything.
 *
 * Rev 2 (review finding M9): prompt fatigue IS the attack. Three controls:
 *  1. `dismissed` — "Not now" suppresses that ephPub for the rest of the page-load, so a
 *     re-POST cannot immediately re-show the same card.
 *  2. `MAX_CARDS_PER_LOAD` — a hard cap; past it we stop rendering entirely and tell the
 *     user something is wrong.
 *  3. The primary button says "Codes match — send my keys", not "Approve", so the code
 *     comparison is part of the action rather than decoration.
 */
const MAX_CARDS_PER_LOAD = 3;

export function KeyRequestListener() {
  const bridge = useCryptoBridge();
  const [card, setCard] = useState<Card | null>(null);
  const [pending, setPending] = useState(false);
  const [abuse, setAbuse] = useState(false);
  const dismissed = useRef(new Set<string>());
  const shown = useRef(0);

  useEffect(() => {
    async function present(ephPub: string, label: string | null) {
      if (dismissed.current.has(ephPub)) return;
      if (shown.current >= MAX_CARDS_PER_LOAD) { setAbuse(true); return; }
      shown.current += 1;

      const token = getToken();
      // Pull the SERVER-ATTESTED facts (4.3) rather than trusting the broadcast payload.
      const listed = token ? await listKeyRequests(token).catch(() => null) : null;
      const match = listed?.requests.find((r) => r.ephPub === ephPub);
      setCard({
        ephPub,
        label,
        code: await verificationCode(ephPub),
        requesterClientKind: match?.requesterClientKind ?? null,
        requesterCreatedAt: match?.requesterCreatedAt ?? null,
      });
    }

    return apiSocket.on("ephemeral", (e) => {
      if (e.t === "key-request") void present(e.ephPub, e.label);
    });
  }, []);

  if (abuse) {
    return (
      <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-[min(24rem,calc(100%-2rem))] rounded-xl border border-destructive/50 bg-card p-4 shadow-lg">
        <p className="text-sm font-medium text-destructive">Too many key requests</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Something is repeatedly asking for your keys. Don't approve anything — open
          Settings → Devices and sign out anything you don't recognise.
        </p>
      </div>
    );
  }

  if (!card || !bridge) return null;

  async function approve() {
    const token = getToken();
    if (!token || !card) return;
    setPending(true);
    try {
      const sealed = await bridge.sealKeysForPeer(card.ephPub);
      await approveKeyRequest(token, { ephPub: card.ephPub, response: sealed });
      setCard(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-[min(24rem,calc(100%-2rem))] rounded-xl border bg-card p-4 shadow-lg">
      <p className="text-sm font-medium">{copy.keys.approveTitle}</p>
      <p className="mt-1 text-sm text-muted-foreground">{copy.keys.approveBody}</p>

      {/* Server-attested, above the untrusted label (4.3). */}
      <dl className="mt-3 space-y-1 rounded-md bg-muted/40 p-3 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Signed in as</dt>
          <dd>{card.requesterClientKind ?? "unknown"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Says it is</dt>
          <dd className="truncate">{card.label ?? "unnamed"}</dd>
        </div>
      </dl>

      <div className="mt-3 rounded-md border p-3 text-center">
        <p className="text-xs text-muted-foreground">{copy.keys.codeIntroApprover}</p>
        <p className="mt-1 font-mono text-2xl tracking-[0.2em]">
          {formatVerificationCode(card.code)}
        </p>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{copy.keys.codeMismatch}</p>

      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => void approve()}>
          {pending ? "Sending…" : copy.keys.sendCta}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { dismissed.current.add(card.ephPub); setCard(null); }}
        >
          {copy.keys.denyCta}
        </Button>
      </div>
    </div>
  );
}
```

Mount inside `RequireAuth` in `packages/web/src/app/(protected)/layout.tsx`.

### 4.9 CLI as a key holder

> **Rev 2 correction (review finding M6).** Rev 1 said the daemon "can answer a key
> request even when no browser is open". It cannot today: `machineClient.ts` registers
> handlers only for `connect`/`connect_error`/`disconnect` (`:434/:457/:477`), and
> `machineRpc.ts:866` handles only `rpc-request`. **The CLI never subscribes to
> `ephemeral` at all.**

Two pieces of work, in order:

**a) Subscribe the daemon to `ephemeral`** so it can even see a request:

```ts
// packages/cli/src/daemon/machineClient.ts — inside the connect handler
  socket.on("ephemeral", (payload: unknown) => {
    const parsed = EphemeralSchema.safeParse(payload);
    if (!parsed.success || parsed.data.t !== "key-request") return;
    deps.onKeyRequest?.(parsed.data);
  });
```

**b) `falcon keys approve`** — an explicit command, because silent auto-approval would let
anyone with a stolen account session pull the keys with no human in the loop.

```
$ falcon keys approve

  A device is asking for a copy of your keys:

    Signed in as   web
    Says it is     Chrome on Mac
    Asked          14 seconds ago

  Check that device shows this code:   418 902

  Only continue if the codes match.
  Codes match, send my keys? [y/N] y

  ✓ Keys sent. That device should continue on its own.
```

This does violate principle 1 ("never print run X") — noted honestly. The mitigation is
that (a) makes the daemon *aware*, so a future iteration can print this prompt inline in a
running `falcon claude` session instead of requiring a separate command. Track that as
follow-up; do not auto-approve to avoid it.

The node twin of `sealKeysForPeer` goes in `packages/cli/src/auth/keyShare.ts` and must be
unit-tested against the worker's version to guarantee byte compatibility.

---

## Phase 5 — Remove the PIN (items 28–35)

> **Rev 2 rework.** Rev 1's central claim — that a non-extractable `CryptoKey` in IndexedDB
> protects the master secret from XSS — is **false**, and the threat table built on it was
> wrong in the flattering direction. This phase is rewritten around what actually holds.

### 5.1 The honest threat model

**What a non-extractable `CryptoKey` in IndexedDB does and does not do:**

IndexedDB is **origin**-scoped. Any same-origin script — including injected XSS on the main
thread — can open `falcon-crypto-bridge`, read the record, obtain the `CryptoKey` handle
with its `["encrypt","decrypt"]` usages, and call `crypto.subtle.decrypt`.
Non-extractability blocks `exportKey`; it does not block **use**. There is no web-platform
mechanism to bind a `CryptoKey` to a worker.

| Threat | PIN (today) | Device-wrap (rev 1's proposal) | WebAuthn PRF (rev 2) |
|---|---|---|---|
| XSS opens IndexedDB and decrypts | protected *(needs the PIN)* | ❌ **not protected** | protected *(needs a user-verification gesture)* |
| XSS drives an already-unlocked worker | not protected | ❌ **worse** — self-unlocks with no gesture at all | not protected *(after the gesture)* |
| Attacker copies the whole browser profile | protected | ❌ not protected | protected *(key material never at rest)* |
| Stolen unlocked laptop, attacker opens the app | protected | ❌ not protected | protected *(biometric)* |
| User forgets their secret | ❌ loses all data | cannot happen | cannot happen *(passkey is recoverable)* |
| Friction per page load | type 6+ chars | none | one biometric tap |

Rev 1's proposal is a **strict security downgrade** on four of six rows. It is not
acceptable as the only mechanism.

### 5.2 The design

**Primary: WebAuthn PRF.** Derive the wrapping key from a passkey's PRF extension. The key
material never exists at rest; it is re-derived per session from the authenticator, gated
by user verification (Touch ID / Windows Hello / Android biometric).

```ts
// packages/web/src/crypto/prf-key.ts (new)
/**
 * Derive a wrapping key from a passkey's PRF extension. The key exists only in memory,
 * for this page-load, and re-deriving it requires a user-verification gesture — which is
 * what makes it a real at-rest control, unlike a stored CryptoKey (see 5.1).
 *
 * Returns null when PRF is unavailable: no platform authenticator, an older browser, or a
 * credential created before PRF was requested. Callers MUST handle that — see the fallback.
 */
const PRF_SALT = new TextEncoder().encode("falcon-key-wrap-v1");

export async function isPrfAvailable(): Promise<boolean> {
  if (!window.PublicKeyCredential) return false;
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
}

export async function derivePrfWrapKey(credentialId: Uint8Array): Promise<CryptoKey | null> {
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: credentialId, type: "public-key" }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    })) as PublicKeyCredential | null;

    const prf = assertion?.getClientExtensionResults()?.prf?.results?.first;
    if (!prf) return null;

    return crypto.subtle.importKey(
      "raw",
      prf as ArrayBuffer,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    return null;
  }
}
```

**Fallback when PRF is unavailable:** device-wrap (rev 1's mechanism), but **labelled
honestly** rather than sold as protection.

- Settings shows: *"This browser keeps you signed in without asking. Anyone who can use
  this computer can read your sessions."*
- Setup offers a plain choice, in the user's words:
  - *"Use Touch ID"* (PRF available) — "Ask for my fingerprint each time I open Falcon."
  - *"Stay signed in"* — "No prompt. Only use this on a computer only you can use."

That is a real user decision stated in real words, not a hidden downgrade.

### 5.3 Storage shape

```ts
// packages/web/src/crypto/key-storage.ts
/** Rev 2: `v` is REQUIRED and explicit. Today's record (key-storage.ts:27-32) has NO
 * version field at all, so v1 detection is "no `v` property", not `v === 1`. */
export interface StoredKeyRecordV2 {
  v: 2;
  /** "prf" re-derives the wrap key per session; "device" stores it. See 5.1/5.2. */
  mode: "prf" | "device";
  /** Present only for mode "device". */
  wrapKey?: CryptoKey;
  /** Present only for mode "prf". */
  credentialId?: Uint8Array;
  wrapped: { nonce: Uint8Array; ct: Uint8Array };
  signPubKey: string;
  contentPubKey: string;
}

/** The current, unversioned PIN record. Rev 1 referenced `LegacyPinStoredKeyRecord`
 * without ever defining it. */
export interface StoredKeyRecordV1 {
  v?: undefined;
  wrapped: PinWrapped;
  signPubKey: string;
  contentPubKey: string;
  wrappedRefreshToken?: PinWrapped;
}

export type AnyStoredKeyRecord = StoredKeyRecordV1 | StoredKeyRecordV2;
```

### 5.4 Every worker branch, enumerated

> **Rev 2 (review finding C3).** Rev 1 said "every `if (!keyTree) return … keyDependentError`
> becomes `ensureLoaded()`". That pattern rule misses branches with different guards and
> would have silently signed users out. Here is the exhaustive list.

| Branch | Current guard (`worker-handler.ts`) | Rev 2 |
|---|---|---|
| `init` | — | drop `pin`; write a v2 record via `createWrapKey()` or PRF |
| `unlock` | `:164` | **deleted** |
| `setSessionKey` | `!keyTree` `:187` | `await ensureLoaded()` |
| `seal` / `open` | `!activeDek` | unchanged |
| `sealBlob` / `openBlob` | `!activeDek` | unchanged |
| `clear` | — | also clear the Phase 4a session store |
| `getIdentity` | reads plaintext pubkeys `:250` | unchanged — but **must not** be used as the readiness check (see 5.5) |
| `bindKeysProof` | `!keyTree` `:262` | `await ensureLoaded()` |
| `sealForPeer` | `!keyTree \|\| !masterSecret` `:288` | `await ensureLoaded()` |
| `sealKeysForPeer` | *(new, Phase 4)* | `await ensureLoaded()` |
| **`setRefreshToken`** | `!keyTree \|\| !pin` `:317` | **Phase 4a**: no key dependency at all |
| **`refreshSession`** | `!refreshToken` `:326` | **Phase 4a**: lazy-load from the session store |
| **`persistRefreshToken`** | `!refreshToken \|\| !pin` `:127` | **deleted** — the session store owns this now |

The last three are the ones rev 1's pattern rule would have missed. All three are on the
silent-refresh path, so getting them wrong logs every user out on reload.

```ts
  /** There is no unlock step any more: the first key-dependent call in a fresh worker
   * loads and unwraps with no PIN. Idempotent; safe to call on every branch. */
  async function ensureLoaded(): Promise<boolean> {
    if (keyTree) return true;
    const record = await storage.load();
    if (!record || record.v !== 2) return false;     // v1 needs migration first (5.5)

    const wrapKey =
      record.mode === "prf"
        ? await derivePrfWrapKey(record.credentialId!)
        : (record.wrapKey ?? null);
    if (!wrapKey) return false;

    const secret = await unwrapBytes(wrapKey, record.wrapped);
    if (!secret) return false;
    await ready;
    deriveFrom(secret);
    return true;
  }
```

### 5.5 Migration — do not use `getIdentity`

> **Rev 2 (review finding C4).** Rev 1 decided ready-vs-no-keys from `getIdentity()`. But
> `getIdentity` reads the **plaintext** `signPubKey`/`contentPubKey`
> (`worker-handler.ts:250-258`), which a v1 PIN record still has. So a v1 user would report
> `"ready"`, the migration prompt would never render, and `ensureLoaded()` would return
> `false` for every key operation — a UI that says everything is fine over a worker that
> can do nothing.

```ts
// packages/web/src/lib/use-crypto-bridge-status.ts
export type BridgeStatus =
  | { kind: "loading" }
  | { kind: "no-keys" }
  | { kind: "needs-migration" }        // v1 record present: one last PIN prompt
  | { kind: "ready"; bridge: CryptoBridgeClient };
```

New worker op `describeStorage(): { present: boolean; version: 1 | 2 }` — rev 1 referenced
`getStorageVersion()` but never added it to `protocol.ts` or `CryptoWorkerResults`. Add both.

Readiness is `ensureLoaded()`, not `getIdentity()`:

```ts
  const state = await bridge.describeStorage();
  if (!state.present) setStatus({ kind: "no-keys" });
  else if (state.version === 1) setStatus({ kind: "needs-migration" });
  else setStatus((await bridge.ensureLoadedProbe()) ? { kind: "ready", bridge } : { kind: "no-keys" });
```

`migrateFromPin(pin, mode)` unwraps the v1 record, re-wraps as v2, and deletes the old
fields. A user who has forgotten their PIN takes the ordinary `RequestKeysPanel` path.
Remove `migrateFromPin` (and the worker's `pin.web.ts` import) one release later — item 34.

`keyDependentError()` (`worker-handler.ts:71-74`) returns `"locked" | "not-initialized"`;
`"locked"` is meaningless post-Phase-5. Rename to `"needs-keys" | "not-initialized"` — item 34.

### 5.6 Items 31, 32, 35

- Delete the `needs-unlock` branch from `require-auth.tsx`; `no-keys` renders
  `RequestKeysPanel`, `needs-migration` renders the one-time prompt.
- Delete `pin-setup-form.tsx` / `pin-unlock-form.tsx` and every import.
- **Item 35** — with the PIN gone, per-device revoke is the main defence for a lost device:
  promote Devices into the main nav, add the one-line explainer, and show `label` +
  `lastRefreshedAt` (already returned by `sessionsAdmin.ts:68`).

---

## Phase 6 — Copy pass (items 36–41)

```bash
rg -n 'key material|masterSecret|master secret|keyEpoch|key epoch|Falcon key|crypto bridge|custody' \
  packages/web/src packages/cli/src -g '!**/__tests__/**' -g '!**/*.test.*'
```

| File:line *(verified)* | Before | After |
|---|---|---|
| `pair/page.tsx:140` | "This browser has no Falcon key material for your account yet — sign in with email/password or OAuth first, then reopen this pairing link." | *(deleted — `RequestKeysPanel`)* |
| `require-auth.tsx:116` | "This browser has no Falcon key material for your account…" | "This browser doesn't have your keys yet." |
| `reset-keys/page.tsx:81` | "Resetting keys signs every other device out and archives data encrypted under the old keys." | "Starting over erases all your past sessions and signs out every other device." |
| `oauth-callback-page.tsx:204` | "This account already has keys on another device." | "Your keys are on another device." |
| `oauth-callback-page.tsx:212` *(was `:211` in rev 1)* | "Reset keys for this browser" | `StartOverLink` |
| `session-list-screen.tsx:85` | "any paired machine" | "one of your machines" |
| `signin/page.tsx:116` *(was `:113` in rev 1)* | "…unlocks this browser's encrypted key material with a PIN." | *(deleted with the PIN)* |

```ts
// packages/web/src/lib/__tests__/copy.test.ts
import { describe, expect, it } from "vitest";
import { copy } from "../copy.js";

/** Rev 2 (finding L5): exercise template functions too — rev 1 returned [] for them,
 * skipping exactly where jargon creeps in. */
function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "function") return [String((node as (a: string) => string)("Sample"))];
  if (node && typeof node === "object") return Object.values(node).flatMap(strings);
  return [];
}

describe("web auth copy", () => {
  it("contains no internal jargon", () => {
    for (const s of strings(copy)) {
      expect(s).not.toMatch(/key material|masterSecret|keyEpoch|epoch|DEK|custody|bridge|ephPub/i);
    }
  });

  it("destructive copy states its consequence", () => {
    expect(copy.reset.warning).toMatch(/erase|permanently/i);
  });

  it("the approve action names the check it depends on", () => {
    expect(copy.keys.sendCta).toMatch(/code/i);
  });
});
```

---

## Phase 7 — Later (items 42–45)

- **42 — Session quota.** A `COUNT` in `routes/sessions.ts`'s create handler plus a
  `429`-shaped error and copy. No crypto work.
- **43 — Better device rows.** `label` lands with item 7(a); backfill `cli-daemon` rows
  from `machines.metadata`. `lastRefreshedAt` is already returned.
- **44 — Rename a machine.** `PATCH /v1/machines/:id` writing the encrypted metadata blob.
- **45 — ~~Optional passkey lock~~ → promoted into Phase 5.** *(rev 2)*
- **46 — Fix the rate-limit keyer** (finding L1): `req.accountId` is empty at the global
  `preHandler` hook, so every "per-account" limit is really per-IP. Pre-existing; file it.
- **47 — Inline daemon approval prompt** so `falcon keys approve` stops being a separate
  command (see 4.9).

---

## Decisions that need your sign-off

1. **Phase 4a partially walks back security review finding F1.** F1 moved the refresh token
   into the PIN-wrapped record to get it out of `localStorage`. Phase 4a moves it to a
   separate, non-PIN store. The justification is in the module docblock: the refresh token
   rotates, is theft-detectable, is revocable, and expires in 60 days — the master secret
   has none of those properties. It is still strictly better than `localStorage`. **But it
   is a deliberate reduction and you should agree to it explicitly.**
2. **PRF vs. honest fallback.** Phase 5 asks the user to choose between a Touch ID prompt
   and no prompt. That is one more decision at setup than "no PIN at all". The alternative
   is shipping the fallback silently, which 5.1 shows is a downgrade on four of six threat
   rows. **Recommendation: ask, in plain words.**
3. **`restartDaemon()`** (Phase 1, item 2). Needed so a re-paired CLI's daemon picks up the
   new credentials. Options: a daemon RPC (right), stop/start (blunt), or accept one extra
   `falcon` invocation (cheapest). **Recommendation: the RPC**, but it is real work not
   costed here.
4. **The `key-request` ephemeral breaks stale PWA clients** until their service worker
   updates (4.2). The polling fallback keeps them working. Confirm you are happy shipping
   a wire union member with that transitional behaviour.

---

## Task checklist

Task IDs use the `AX-<phase>.<n>` scheme, matching this repo's existing `AH-`/`BF-`/`FL-`
unit conventions so a loop skill can execute them later.

**Legend:** `⛔` blocked until a gate clears · `∥` safe to run in parallel with its siblings
· `🔬` test-only · `⚠️` security-critical, do not simplify without re-review.

---

### Gate G — decisions and prerequisites (do these first)

> **Resolved during implementation.** The user instructed "implement it all", so each gate
> took the plan's own recommended option. Recorded here rather than assumed silently.

- [x] **AX-G.1** — Decision #1 **accepted**: Phase 4a moves the refresh token to its own
      store, partially walking back security review F1. Justification is in
      `crypto/session-storage.ts`'s docblock.
- [x] **AX-G.2** — Decision #2 **accepted**: WebAuthn PRF primary, device-wrap fallback,
      and the setup screen asks the user in plain words.
- [x] **AX-G.3** — Decision #3 **accepted**: a daemon RPC (`auth.reload`) rather than a
      stop/start or an extra invocation.
- [x] **AX-G.4** — Decision #4 **accepted**: ship the new `EphemeralSchema` union member;
      the `RequestKeysPanel` poll keeps stale PWA clients functional.
- [x] **AX-G.5** — PRF gated at runtime by `isPrfAvailable()`; any browser without a
      user-verifying platform authenticator silently gets the labelled device-wrap fallback,
      so no browser matrix is hard-coded.

---

### Phase 0 — Shared copy modules *(no dependencies; ship first)* ✅ COMPLETE

- [x] **AX-0.1** ∥ — Create `packages/cli/src/ui/messages.ts` with every CLI auth string.
- [x] **AX-0.2** ∥ — Create `packages/web/src/lib/copy.ts` with the `copy` object.
- [x] **AX-0.3** 🔬 — Add `packages/cli/src/ui/messages.test.ts` (colocated, per repo
      convention — `packages/cli` uses sibling `.test.ts`, not `__tests__/`). 4 tests pass.
- [x] **AX-0.4** 🔬 — Add `packages/web/src/lib/__tests__/copy.test.ts`. 4 tests pass.

---

### Phase 1 — CLI *(depends on Phase 0)* ✅ COMPLETE

- [x] **AX-1.1** — `runStart` now gates **every** provider on `ensureLoggedIn`, still before
      `ensureDaemon()`. Docblock updated to record why the ordering is load-bearing.
- [x] **AX-1.2** — `NOT_LOGGED_IN_MESSAGE` deleted; `NO_TTY_CANNOT_SIGN_IN` used instead.
- [x] **AX-1.3** — New `packages/cli/src/commands/startPreflight.ts` with `runPreflight()`
      returning `{ok} | {ok:false, reason:"needs-reauth"} | {ok:false, reason:"error"}`.
- [x] **AX-1.4** — `start.ts`'s credential check is now a guard for the non-interactive
      entry points only (daemon resume, tests); the interactive path never reaches it.
- [x] **AX-1.5** ⚠️ — `runPreflightWithReauth()` re-pairs inline and re-runs the **whole**
      preflight. Covered by a test asserting the content key is re-derived from the NEW
      secret.
- [x] **AX-1.6** — Daemon `POST /reload-auth` control endpoint + `daemon/reloadAuth.ts`
      client. `commands.ts` stops and restarts machine integration in place.
- [x] **AX-1.7** — `ensureLoggedIn` and `reloadDaemonAuth` added to both commands' deps.
- [x] **AX-1.8** ∥ — `startCodex.ts` uses the same shared preflight.
- [x] **AX-1.9** ∥ — `daemon/machineIntegration.ts` deliberately left alone, as planned.
- [x] **AX-1.10** — New first-run output; the URL fallback now prints **only** when the
      browser could not be opened.
- [x] **AX-1.11** — `label`/`cwd` added to `pair_requests` (migration
      `0006_loose_adam_warlock.sql`), sent by the CLI, capped at the route, returned by
      `/v1/auth/pair/status`.
- [x] **AX-1.12** — **Deviation from the plan, deliberate:** the email is fetched from the
      *authenticated* `GET /v1/auth/sessions` after pairing, **not** from
      `/v1/auth/pair/status`. That route is unauthenticated, so returning an account email
      there would leak it to anyone holding a pairing link without ever proving they hold
      the matching ephemeral secret key.
- [x] **AX-1.13** — `writeError` audit done; messages moved into `ui/messages.ts`.
- [x] **AX-1.14** 🔬 — `startPreflight.test.ts` (6 tests). `start.test.ts`'s
      "not logged in" assertion still passes unmodified.
      · Also updated: 4 `index.test.ts` tests that deliberately used `codex` *because* it
      wasn't auth-gated — AX-1.1 gates it now, so they stub `ensureLoggedIn`.
      · **CLI suite: 1962/1962 pass.**

---

### Phase 2 — Web pairing gate order *(depends on Phase 0)* ✅ COMPLETE

- [x] **AX-2.1** — Create `parse-eph-pub.ts` with `parseEphPubFromHash`.
      · New file next to `pair/page.tsx`. · Done when: base64url→plain-base64 conversion is
      in exactly one place and handles `+`/`/`.
- [x] **AX-2.2** ⚠️ — Restructure `pair/page.tsx` to identity-first, crypto-second.
      · `packages/web/src/app/(public)/pair/page.tsx:42-82`. · Done when: the sign-in check
      runs before `getIdentity()`, and the `Gate` union includes `confirm`, `approving`,
      `approved`, `needs-keys`, `error` (rev 1's type errors gone).
- [x] **AX-2.3** — Delete the `no-identity` dead-end screen.
      · `pair/page.tsx:136-148`. · Done when: replaced by `needs-keys` → `RequestKeysPanel`.
- [x] **AX-2.4** ∥ — Add `peekPendingPair()` to `lib/pending-pair.ts`.
      · Done when: it reads without consuming; only the pair page consumes.
- [x] **AX-2.5** — Sign-in page shows the "Connect your machine" heading for a pending pair.
      · `packages/web/src/app/(public)/signin/page.tsx:30-34,47-49`.
- [x] **AX-2.6** — Extend `GET /v1/auth/pair/status` with `label`/`cwd`/`requestedAt`.
      · `packages/server/src/app/api/pair.ts:118-144`. · Combine with `AX-1.12`'s `email`
      into **one** schema change.
- [x] **AX-2.7** ⚠️ — Build the approve card with machine / folder / requested-at.
      · Done when: `label` and `cwd` render as **plain text**, never HTML/markdown, and the
      fixed warning line sits above them.
- [x] **AX-2.8** — Add the post-approval success screen.
- [x] **AX-2.9** — Create `components/auth/start-over-link.tsx`.
      · Done when: destructive path is a link + explicit consequence + confirm, never a
      peer button.
- [x] **AX-2.10** — Replace every `[Reset keys…]` button with `StartOverLink`.
      · `pair/page.tsx:143`, `require-auth.tsx:119`, `oauth-callback-page.tsx:212`,
      `reset-keys/page.tsx:99`.
- [x] **AX-2.11** — Fix `reset-keys`'s fragment-less `/pair/` push.
      · `packages/web/src/app/(public)/reset-keys/page.tsx:86-88`. · Done when: it renders
      `RequestKeysPanel` inline instead of hard-stopping on `invalid-link`.
- [x] **AX-2.12** 🔬 — Unit-test the gate decision table without mounting React.
      · Follow `pair-gate.ts` / `shouldRedirectToSignin` precedent.

---

### Phase 3 — Web onboarding *(depends on Phase 0; independent of everything else)* ✅ COMPLETE

- [x] **AX-3.1** ∥ — Create `FirstMachineOnboarding` with `CopyableCommand`.
- [x] **AX-3.2** — Branch on `snapshot.machines.length === 0`.
      · `packages/web/src/features/session-list/session-list-screen.tsx:81`.
      · Done when: zero-machine and no-session states are visibly different.
- [x] **AX-3.3** — Hide "New session" when there are no machines.
      · `session-list-screen.tsx:89-91`.
- [x] **AX-3.4** — Guard `/dashboard/session/new/` for the deep-link case.
      · `packages/web/src/features/new-session/components/machine-step.tsx`.
- [x] **AX-3.5** 🔬 — Assert the screen advances when a machine appears in the snapshot.

---

### Phase 4a — Split the session credential *(⛔ `AX-G.1`; blocks Phase 4)* ✅ COMPLETE

- [x] **AX-4a.1** ⚠️ — Create `packages/web/src/crypto/session-storage.ts`.
      · Done when: separate IndexedDB database, non-extractable wrap key, and the docblock
      states the **honest** scope of that protection (not an XSS defense).
- [x] **AX-4a.2** — Rewrite `setRefreshToken` to drop its `keyTree`/`pin` dependency.
      · `packages/web/src/crypto/worker-handler.ts:316-323`.
- [x] **AX-4a.3** ⚠️ — Rewrite `refreshSession` to lazy-load from the session store.
      · `worker-handler.ts:325-353`. · Done when: it works in a worker with **no** key
      material at all.
- [x] **AX-4a.4** — Delete `persistRefreshToken`.
      · `worker-handler.ts:126-133`. · The session store owns this now.
- [x] **AX-4a.5** ⚠️ — Stop gating `getSharedCryptoBridge()` on `unlocked`.
      · `packages/web/src/lib/use-crypto-bridge.ts:108-110`.
- [x] **AX-4a.6** ⚠️ — Decouple `RequireAuth`'s session effect from bridge status.
      · `packages/web/src/features/auth/require-auth.tsx:73-100`. · Done when: `sessionReady`
      can become true with no key material present.
- [x] **AX-4a.7** — One-time copy of `wrappedRefreshToken` into the new store.
      · Done when: an existing unlocked user is migrated silently; a user who never unlocks
      simply re-authenticates.
- [x] **AX-4a.8** 🔬 — Test: fresh worker, no key material, `refreshSession` still mints a
      token; `silentRefresh()` returns true.

---

### Phase 4 — Reverse-direction key sharing *(⛔ Phase 4a + `AX-G.4`)* ✅ COMPLETE

- [x] **AX-4.1** — Add the `key_requests` table + migration.
      · `packages/server/src/db/schema.ts`, then `pnpm --filter @falcon/server db:generate`.
      · Done when: `uniqueIndex(accountId, ephPub)` — **not** globally unique — and
      `requestedBySessionId` is `notNull`.
- [x] **AX-4.2** ⚠️ — Create `packages/web/src/lib/verification-code.ts`.
      · Done when: deterministic, 6 digits, zero-padded, plus `formatVerificationCode`.
- [x] **AX-4.3** ⛔`AX-G.4` — Add the `key-request` member to `EphemeralSchema`.
      · `packages/wire/src/updates.ts:79`. · **`@falcon/wire` builds first** — this gates the
      whole phase. Also bump the service-worker cache (`packages/web/public/sw.js`).
- [x] **AX-4.4** — Add `buildKeyRequestEphemeral` to `eventRouter.ts`.
- [x] **AX-4.5** ⚠️ — Create `routes/keyRequests.ts` with all four routes.
      · Done when: every route is authenticated **and** `accountId`-scoped; `400` (not `401`)
      for a malformed key; self-approval blocked; claim bound to `requestedBySessionId`;
      TTL-refreshing upsert; opportunistic expiry sweep.
- [x] **AX-4.6** — Register the routes in `server.ts` next to `pairRoutes` (`:206`).
- [x] **AX-4.7** — Export `generateEphemeralKeyPair` from `@falcon/crypto/web`.
      · `packages/crypto/src/encryption.web.ts` + `index.web.ts`. · Rev 1's `boxKeyPair()`
      does not exist — verified against `index.web.ts`.
- [x] **AX-4.8** — Add the three worker request types to `protocol.ts` + results map.
- [x] **AX-4.9** — Add the three methods to `CryptoBridgeClient` in `client.ts`.
      · Rev 1 forgot this file entirely.
- [x] **AX-4.10** ⚠️ — Implement `beginKeyRequest` / `acceptKeyResponse` / `sealKeysForPeer`.
      · `worker-handler.ts`. · Done when: pending secrets live in a **`Map` keyed by
      `ephPub`** with a cap, and the ephemeral secret never crosses `postMessage`.
- [x] **AX-4.11** — Add the four API client functions to `lib/api.ts`.
- [x] **AX-4.12** ∥ — Create `lib/describe-device.ts`.
- [x] **AX-4.13** ⚠️ — Build `RequestKeysPanel`.
      · Done when: `onReady` is pinned in a ref (no re-request loop), the code is displayed,
      the device list renders, polling continues by itself, and `StartOverLink` is the only
      destructive exit.
- [x] **AX-4.14** ⚠️ — Build `KeyRequestListener` (the approve card).
      · Done when: server-attested row sits **above** the untrusted label, the code is shown,
      the primary button names the code check, "Not now" suppresses that `ephPub`, and the
      `MAX_CARDS_PER_LOAD` abuse warning works.
- [x] **AX-4.15** — Mount `KeyRequestListener` in the protected layout.
- [x] **AX-4.16** — Wire `RequestKeysPanel` into `pair/page.tsx` (`needs-keys`) and
      `reset-keys/page.tsx`.
- [x] **AX-4.17** — Subscribe the daemon to `ephemeral` events.
      · `packages/cli/src/daemon/machineClient.ts` (connect handler). · Today it handles only
      `connect`/`connect_error`/`disconnect`.
- [x] **AX-4.18** — Create `packages/cli/src/auth/keyShare.ts` (node twin of `sealKeysForPeer`).
- [x] **AX-4.19** — Implement `falcon keys approve` + register it in the command parser.
      · Done when: it shows the attested row, prints the code, and requires an explicit `y`.
      **Never auto-approves.**
- [x] **AX-4.20** 🔬 ⚠️ — Route tests: cross-account approve → 404; claim by a different
      session of the same account → not delivered; self-approval → 404; double claim →
      `expired`; re-POST after expiry refreshes the TTL.
- [x] **AX-4.21** 🔬 — Worker tests: two concurrent `beginKeyRequest` calls both survive;
      foreign sealed box → `false`; over-cap → error.
- [x] **AX-4.22** 🔬 — `keyShare.ts` byte-compatibility test against the worker's output.

---

### Phase 5 — Remove the PIN *(⛔ Phase 4 + `AX-G.2` + `AX-G.5`)* ✅ COMPLETE

- [x] **AX-5.1** ⚠️ — Create `crypto/prf-key.ts` (`isPrfAvailable`, `derivePrfWrapKey`).
- [x] **AX-5.2** — Create `crypto/device-key.ts` (`createWrapKey`, `wrapBytes`, `unwrapBytes`).
- [x] **AX-5.3** ⚠️ — Define `StoredKeyRecordV1` / `StoredKeyRecordV2` / `AnyStoredKeyRecord`.
      · `crypto/key-storage.ts:27-32`. · Done when: v1 detection is "**no `v` property**",
      because today's record has no version field.
- [x] **AX-5.4** — Add the `describeStorage` worker op to `protocol.ts`, `client.ts`, handler.
      · Rev 1 referenced `getStorageVersion()` without ever adding it.
- [x] **AX-5.5** ⚠️ — Implement `ensureLoaded()` handling both `prf` and `device` modes.
- [x] **AX-5.6** ⚠️ — Update **every** worker branch per the §5.4 table.
      · Done when: all 13 rows are handled explicitly — no pattern rule.
- [x] **AX-5.7** — Drop `pin` from `init`; write a v2 record.
- [x] **AX-5.8** — Delete the `unlock` request type end-to-end.
      · `protocol.ts`, `client.ts`, `worker-handler.ts:164-184`.
- [x] **AX-5.9** ⚠️ — Replace `useUnlockedCryptoBridge` with `useCryptoBridgeStatus`.
      · Done when: readiness comes from `describeStorage` + `ensureLoaded`, **never**
      `getIdentity()`, and `needs-migration` is its own status.
- [x] **AX-5.10** — Build the PRF-vs-stay-signed-in setup choice screen.
      · Done when: worded in plain language per §5.2, and the choice is stored in the record's
      `mode`.
- [x] **AX-5.11** ⚠️ — Implement `migrateFromPin(pin, mode)` + the one-time prompt UI.
- [x] **AX-5.12** — Remove the PIN gate from `RequireAuth`; render `RequestKeysPanel` for
      `no-keys`.
- [x] **AX-5.13** — Delete `pin-setup-form.tsx`, `pin-unlock-form.tsx`, and all imports.
      · `require-auth.tsx`, `pair/page.tsx`, `password/page.tsx`, `oauth-callback-page.tsx`,
      `reset-keys/page.tsx`.
- [x] **AX-5.14** — Delete `unlocked` / `markCryptoBridgeUnlocked` / `isCryptoBridgeUnlocked`.
      · `lib/use-crypto-bridge.ts`. · Keep `logout.ts`'s `bridge.clear()` behaviour.
- [x] **AX-5.15** — Rename `keyDependentError`'s `"locked"` → `"needs-keys"`.
      · `worker-handler.ts:71-74`.
- [x] **AX-5.16** — Promote Devices into the main nav + add the explainer line + show
      `label` / `lastRefreshedAt`.
- [x] **AX-5.17** 🔬 — Tests: v1 record → `describeStorage` reports version 1; `ensureLoaded`
      false for v1; PRF-null → falls back cleanly; reload never prompts for a PIN.
- [x] **AX-5.18** — *(next release)* Remove `migrateFromPin` and the worker's `pin.web.ts`
      import.

---

### Phase 6 — Copy pass *(depends on Phase 0; final sweep after Phase 5)* ✅ COMPLETE

- [x] **AX-6.1** — Run the jargon grep and fix every hit in the §6 table.
- [x] **AX-6.2** — Replace `require-auth.tsx:116`'s "no Falcon key material" copy.
- [x] **AX-6.3** — Replace `reset-keys/page.tsx:81` and `oauth-callback-page.tsx:204`.
- [x] **AX-6.4** — Fix `session-list-screen.tsx:85`'s "any paired machine".
- [x] **AX-6.5** — Delete `signin/page.tsx:116`'s PIN sentence (after Phase 5).
- [x] **AX-6.6** — Give every terminal error state a button or link, not a command.
- [x] **AX-6.7** — Soften the expired banner; source it from `copy.signin.expiredBanner`.
- [x] **AX-6.8** — Add the six guiding principles to `CLAUDE.md`.

---

### Phase 7 — Later *(no dependencies; pick up any time)* ✅ COMPLETE

- [x] **AX-7.1** — Session quota (`COUNT` + `429` + copy).
- [x] **AX-7.2** — Backfill device labels for `cli-daemon` rows from `machines.metadata`.
- [x] **AX-7.3** — `PATCH /v1/machines/:id` + inline rename in the Devices list.
- [x] **AX-7.4** — Fix the rate-limit keyer: `req.accountId` is empty at the global
      `preHandler` hook (`server.ts:162-168`), so every "per-account" limit is per-IP.
- [x] **AX-7.5** — Inline daemon approval prompt so `falcon keys approve` stops being a
      separate command.
- [x] **AX-7.6** — Re-run the independent adversarial review against the finished
      implementation, not just the plan.

---

### Deviations found during implementation

Four things the plan (rev 2) got wrong or under-specified. Each was corrected in code; they
are recorded here because the reasoning matters more than the diff.

1. **WebAuthn is main-thread only — the plan put PRF inside the worker.**
   `navigator.credentials` lives on `Navigator`, not `WorkerNavigator`, so
   `crypto/prf-key.ts` can never run inside the crypto worker. As written, Phase 5 would
   have *silently* fallen back to `"device"` on every browser — precisely the invisible
   downgrade principle 7 forbids. **Fix:** the main thread derives the non-extractable
   `CryptoKey` and passes the handle across `postMessage` (structured clone supports
   `CryptoKey`); `crypto/key-protection.ts` owns that, and the worker refuses to record a
   `"prf"` record it wasn't given a real key for. A new `locked-out` status distinguishes
   "passkey dismissed" from "no keys here" — offering to re-fetch keys in the former case
   would be wrong.

2. **The email must not come from `/v1/auth/pair/status` (AX-1.12).** That route is
   unauthenticated, so returning an account email there leaks it to anyone holding a
   pairing link without ever proving they hold the matching ephemeral secret key. The CLI
   reads it from the authenticated `GET /v1/auth/sessions` after pairing instead.

3. **The rate-limit keyer really was broken (AX-7.4), and the existing comment was wrong.**
   Verified empirically: a global `preHandler` runs before any route-level one, so
   `req.accountId` was always `""` at keying time and every "per-account" limit was per-IP.
   **Fix:** `authPlugin` now installs a non-enforcing identification hook and is registered
   *before* the rate limiter.

4. **Four `index.test.ts` tests deliberately used `codex` because it wasn't auth-gated.**
   AX-1.1 gates it, so they stub `ensureLoggedIn` and keep testing what they claim to.

### Progress tracking

Mirror this repo's existing convention — as phases land, record outcomes in
`docs/auth-ux-overhaul-progress.md` (alongside `auth-ux-hardening-progress.md`,
`bug-fix-progress.md`, `plan-flows-progress.md`) rather than editing this plan in place.

**Totals:** 5 gates · 4 + 14 + 12 + 5 + 8 + 22 + 18 + 8 + 6 = **97 tasks**, of which
**19 are marked ⚠️ security-critical** and must not be simplified without re-review.

---

## Testing plan

### Unit

| Area | Test |
|---|---|
| `runPreflight` | dead refresh token → `needsReauth`; re-run after re-pair re-derives `contentKeyPair` from the **new** secret |
| `start.test.ts:216-226` | still passes — `NO_TTY_CANNOT_SIGN_IN` contains "not logged in" |
| `parseEphPubFromHash` | base64url in → plain base64 out; `+`/`/` round-trip; wrong length → `null` |
| `verificationCode` | deterministic; two different `ephPub` values collide < 1 in 10⁶ |
| `keyRequests` routes | cross-account approve → 404; **claim by a different session of the same account → not delivered**; self-approval → 404; expired → `expired`; second claim → `expired`; re-POST after expiry refreshes the TTL |
| `worker-handler` | `beginKeyRequest` ×2 concurrently → both secrets survive; `acceptKeyResponse` with a foreign box → `false`; `>MAX_PENDING` → error |
| `ensureLoaded` | v2/device loads; v2/prf loads when PRF resolves, `false` when it returns null; **v1 → `false`** |
| `describeStorage` | v1 record → `{present:true, version:1}` (the case rev 1's `getIdentity` check got wrong) |
| `refreshSession` | works in a fresh worker with **no** key material (Phase 4a) |
| copy lint | both suites above |

### Integration (tmux + Chrome MCP, per `CLAUDE.md`)

1. **Cold first run** — welcome, QR, `/signin/` with "Connect your machine", approve card
   shows hostname + cwd, terminal continues with no second command.
2. **Dead refresh token** — revoke the CLI session from Settings → Devices, run `falcon`.
   Expect "Reconnecting…", inline re-pair, and — critically — verify the session's
   **content key was re-derived** (send a message, confirm the web can decrypt it).
3. **Web-first** — 3-step onboarding, no "New session", advances by itself.
4. **Second browser** — "One more step" with a 6-digit code; card on the first browser
   shows the **same** code plus the server-attested row; approve; second browser continues.
5. **Mismatch drill** — raise a request in browser A, then a second in browser B. Confirm
   the codes differ and that approving A's card does not satisfy B.
6. **Prompt fatigue** — POST 5 requests. Confirm "Not now" suppresses, and the 4th trips
   the "Too many key requests" warning instead of showing another card.
7. **CLI as holder** — close every tab, request from a second browser, run
   `falcon keys approve`, compare codes, approve.
8. **No PIN** (Phase 5) — reload repeatedly; either zero prompts (device mode) or one
   biometric tap (PRF mode), never a typed PIN.
9. **Migration** — provision on the old build, upgrade, confirm the one-time prompt appears
   exactly once and that `describeStorage` drives it (not `getIdentity`).

---

## Rollout order and risks

| Phase | Depends on | Risk | Mitigation |
|---|---|---|---|
| 0 · copy | — | none | pure addition |
| 1 · CLI | — | daemon ordering; stale keys after re-pair | login stays in `index.ts`; `runPreflight` re-runs wholesale |
| 2 · gate order | 0 | regression signs users out mid-pair | pure decision functions + unit tests |
| 3 · onboarding | 0 | none | pure UI |
| **4a · split session store** | — | walks back part of F1 | see Decisions #1; independently valuable |
| 4 · key sharing | **4a**, wire build | **new attack surface** | verification code + server-attested row + self-approval guard + session-bound claim + prompt caps |
| 5 · PIN removal | **4** | at-rest protection | PRF primary; honest labelled fallback; threat table in 5.1 |
| 6 · copy | 0 | none | lint tests |
| 7 · later | — | none | — |

**Merge order:** 0 → 1 → 6 (CLI strings) → 2 → 3 → **4a** → 4 → 5 → 6 (rest) → 7.

**Biggest remaining risk.** Phase 4's approve card is the most security-sensitive UI in the
product — the moment a human grants full read access to everything. Its verification code,
its server-attested row, its "Codes match — send my keys" wording, and its prompt caps are
**controls, not decoration.** Do not simplify them for visual polish. The `label` field is
attacker-controlled: plain text only, always below the attested row, never a substitute for
the code comparison.
