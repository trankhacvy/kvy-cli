# Plan: one Provider Registry, then fix all 5 Codex bugs on top of it

Written after reading the real code (not guessing), then independently reviewed by a
second agent that fact-checked every claim against the repo and found real mistakes.
This version fixes all of them. Simple words on purpose — this doc is for a team where
English is a second language.

**Revision note (after independent review):** the first draft's diagnosis (sections 1-2)
was accurate, but two of the five proposed fixes were actually wrong (§5.5 was a
functional no-op, §5.1 would have shipped a new dead button), one code sample didn't
compile, and the "every hardcoded spot" list missed about a dozen real spots — including
the CLI's own command parser, which is the actual front door for "can I even type this
provider's name". All of that is corrected below, and every fix in §5 was re-verified by
reading the real code again, not just trusted from the first draft.

## 1. The problem, in one sentence

Today, "which agent am I talking to" (`"claude-code"` vs `"codex"`) is a plain string that
is copy-pasted and hand-checked in **more than 30 different places** across the codebase.
There is no single list, no single interface. So:

- Every bug we found live (workspaceId not recorded, mode selector broken, wrong "Claude"
  text) is a symptom of the same root cause: some code path forgot to handle Codex the
  same way it handles Claude, because there is nothing forcing it to.
- Adding a 3rd agent (OpenCode) or a 4th (Grok) today means hunting down these places by
  grep and hoping you found them all.

The fix is not "patch each bug individually." The fix is: **build one small registry
that every part of the app reads from**, then re-express each bug fix as "this piece of
code forgot to ask the registry" — so the same fix stops future bugs for any future agent
too, automatically.

## 2. Proof this problem is real — every hardcoded spot found

**Plain type unions / zod enums (mechanical, low risk to fix):**

```
packages/wire/src/rpc.ts:34,107,224,249     z.enum(["claude-code", "codex"])   (4 places)
packages/cli/src/adapters/manifest.ts:30    type AdapterId = "claude-code" | "codex"
packages/cli/src/daemon/controlServer.ts:102 z.enum(["claude-code", "codex"])
packages/cli/src/daemon/providerAccountInfo.ts:43  provider: "claude-code" | "codex"
packages/cli/src/daemon/sessionsStore.ts:42,101    same union, + hand-written validation
packages/cli/src/daemon/types.ts:32,62       same union, twice
packages/cli/src/session/bootstrap.ts:58     type SessionProvider = "claude-code" | "codex"
packages/web/src/features/provider-accounts/types.ts:21   type ProviderAccountProvider = ...
packages/web/src/features/provider-accounts/components/ProvidersSettingsScreen.tsx:12  const PROVIDERS = [...]
packages/web/src/features/new-session/favorites.ts:49      value === "claude-code" || value === "codex"
packages/web/src/features/new-session/types.ts:32           type NewSessionProvider = ...
packages/web/src/features/new-session/provider-meta.ts:19   PROVIDER_META = { ... }
packages/web/src/features/new-session/model-meta.ts:31       MODEL_OPTIONS = { ... }
packages/web/src/features/session-list/components/agent-icon.tsx:9   AGENT_ICON_SRC_BY_PROVIDER
packages/server/src/app/routes/sessions.ts:19                z.enum(["claude-code", "codex"])
packages/server/src/db/schema.ts:178                         provider: text("provider") // no real enum
```

**The CLI's own command parser (missed in the first draft — this is the front door):**

```
packages/cli/src/args.ts:18   type Provider = "claude" | "codex"
packages/cli/src/args.ts:64   const PROVIDERS = new Set<Provider>(["claude", "codex"])
```

A new provider can't even be **typed as a command** (`falcon opencode ...`) without
editing this file. Any plan that doesn't mention `args.ts` is incomplete.

**Duplicated maps (the same map, written twice — worth fixing on its own):**

```
packages/cli/src/daemon/resumeSession.ts:52   PROVIDER_CLI_NAME = { "claude-code": "claude", codex: "codex" }
packages/cli/src/daemon/spawnEngine.ts:97     PROVIDER_CLI_NAME = { ... }   <- exact duplicate
```

**Hardcoded provider VALUES, not just types (behavioral — a wrong default here changes
what actually happens, not just what compiles):**

```
packages/web/src/features/session-list/review-spawn.ts:29   provider: "claude-code"   (Review feature always spawns Claude)
packages/cli/src/daemon/adoptTake.ts:160                     provider: "claude-code"   (adopt/take-over always assumes Claude)
packages/cli/src/daemon/resumeSession.ts:259                 persisted.provider ?? "claude-code"
packages/cli/src/acp/acpRemote.ts:188                        opts.adapterId ?? "claude-code"
packages/cli/src/acp/acpRemote.ts:250                        adapterId === "claude-code" ? {...} : null  (see §5.5)
packages/cli/src/daemon/providerAccountInfo.ts:160,176,179,233   several if/else branches per provider, not just the type at line 43
packages/web/src/features/settings/components/AgentSection.tsx:63-94  separate claudeModel/codexModel useState + an if/else branch (see §2.1)
```

**A provider-coupled list at the wire layer that nobody thought of as "provider data":**

```
packages/wire/src/rpc.ts:895   RUNNING_SESSION_MODEL_ALIASES = ["sonnet","opus","haiku",...]  -- Claude-only model names, enforced at the wire schema level
```

Two of the duplicated-map cases (`resumeSession.ts` and `spawnEngine.ts`) are literally
**the exact same map, copy-pasted**. That alone is worth fixing regardless of anything
else.

One good sign, confirmed accurate: `SessionRow.provider` in `packages/wire/src/rows.ts:19`
is already `z.string()` — a free string, not a closed enum. And the DB column
(`packages/server/src/db/schema.ts:178`) is already `text("provider")`. So the **server
and the wire row format already support any provider name today**. The closed unions are
all a client-side/CLI-side problem, which is good — it means we don't need a DB migration
or a breaking wire change to add OpenCode later.

### 2.1 Why `AgentSection.tsx` matters more than it looks

```tsx
// packages/web/src/features/settings/components/AgentSection.tsx (today)
const [claudeModel, setClaudeModelState] = useState(() => getFavoriteModel("claude-code") ?? INITIAL_FORM.model);
const [codexModel, setCodexModelState] = useState(() => getFavoriteModel("codex") ?? INITIAL_FORM.model);
// ...
if (forProvider === "claude-code") setClaudeModelState(model);
```

This is not a type union — it's *duplicated component state and branching logic*.
Adding a 3rd provider here means adding a 3rd `useState` and a 3rd `if` branch by hand,
copy-pasting the pattern. This is exactly the kind of spot a registry should replace with
a loop over `PROVIDER_IDS`, and it's called out explicitly in §6.

## 3. The design: 3 layers, capabilities live in ONE of them

Think of it like this: there are 3 places in the app that need to know about providers.
The first draft put "capabilities" (can this provider live-switch modes? live-switch
models?) in *two* different registries (CLI and web) with slightly different field names.
The independent review caught this: **that's the exact copy-paste problem this plan is
supposed to remove, just moved to a new spot.** Fix: capabilities are plain, boring,
serializable data — both CLI and web need to read the *same* answer to "can Codex
live-switch modes?" — so they belong in the wire layer, next to the id list, and CLI/web
each only add fields that are truly private to their own side.

```
┌───────────────────────────────────────────────────────────────┐
│  packages/wire/src/providers.ts                                │
│  "What are the valid provider ids, and what can each one do?"  │
│  -> ONE list + ONE capabilities table, everyone imports these  │
└───────────────────────────────────────────────────────────────┘
                    │                        │
                    ▼                        ▼
┌───────────────────────────────┐  ┌───────────────────────────────┐
│ packages/cli/src/provider/     │  │ packages/web/src/lib/          │
│ registry.ts (DATA ONLY)        │  │ providers.ts                   │
│ "How do I detect/name/spawn    │  │ "How do I show this provider   │
│  this agent from the CLI?"     │  │  in the browser?"               │
└───────────────────────────────┘  └───────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────┐
│ packages/cli/src/provider/     │
│ dispatch.ts (BEHAVIOR)         │
│ "Actually run `falcon codex`"  │
└───────────────────────────────┘
```

Why `registry.ts` and `dispatch.ts` are two separate files, not one — see §3.2 below,
this was another real problem the review found.

### 3.1 Layer 1 — shared ids + capabilities (`packages/wire/src/providers.ts`, NEW FILE)

```ts
import { z } from "zod";

/**
 * Every coding agent Falcon can drive. Add a new agent by adding ONE line
 * here — every zod schema and TypeScript union in the app derives from this
 * array, so nothing else needs a hand-written union of provider strings.
 */
export const PROVIDER_IDS = ["claude-code", "codex"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const ProviderIdSchema = z.enum(PROVIDER_IDS);

/**
 * What a provider CAN and CANNOT do. This is the important part — every
 * "should I show this button" / "should I allow this action" check in the
 * app should read from here instead of hand-checking `provider === "codex"`.
 * Lives here (not in the CLI or the web app separately) because both sides
 * need the SAME answer — duplicating it was the first draft's own mistake.
 */
export interface ProviderCapabilities {
  /** Can it run as a real, attachable local terminal (like Claude Code's TUI)? Codex: no. */
  hasLocalMode: boolean;
  /** Can a RUNNING session's permission mode be changed live from the web? */
  supportsLiveModeSwitch: boolean;
  /** Can a RUNNING session's model be changed live from the web? */
  supportsLiveModelSwitch: boolean;
  /** Does "take control" (hand a remote session back to a local terminal) mean anything for this provider? */
  supportsTakeControl: boolean;
  /** Can starting a session continue a previous provider-side conversation? See §5.5 — this is `false` for codex until that fix actually lands and is live-verified, not just planned. */
  supportsResume: boolean;
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  "claude-code": {
    hasLocalMode: true,
    supportsLiveModeSwitch: true,
    supportsLiveModelSwitch: true,
    supportsTakeControl: true,
    supportsResume: true,
  },
  codex: {
    hasLocalMode: false,
    supportsLiveModeSwitch: true,   // real, via ACP session/set_mode — see §5.1
    supportsLiveModelSwitch: false, // no ACP call for this exists
    supportsTakeControl: false,     // no local terminal to hand back to
    supportsResume: false,          // flip to true only once §5.5 is built AND live-verified
  },
};

/** Safe accessor for an unknown/old/free-form provider string (`SessionRow.provider` is `z.string()`, not this enum) — never throws, never crashes on a session created by a future Falcon version this build doesn't know about yet. */
export function getProviderCapabilities(provider: string): ProviderCapabilities {
  return (
    PROVIDER_CAPABILITIES[provider as ProviderId] ?? {
      hasLocalMode: false,
      supportsLiveModeSwitch: false,
      supportsLiveModelSwitch: false,
      supportsTakeControl: false,
      supportsResume: false,
    }
  );
}
```

Then every place that currently writes `z.enum(["claude-code", "codex"])` or
`"claude-code" | "codex"` switches to importing `ProviderIdSchema` / `ProviderId` instead.
Example, `packages/wire/src/rpc.ts:34`:

```ts
// before
provider: z.enum(["claude-code", "codex"]),

// after
import { ProviderIdSchema } from "./providers.js";
provider: ProviderIdSchema,
```

Do this at the 4 spots in `rpc.ts`, plus `controlServer.ts`, `providerAccountInfo.ts`,
`sessionsStore.ts`, `types.ts` (daemon), `bootstrap.ts`, `favorites.ts`, `new-session/
types.ts`, `provider-accounts/types.ts`, `ProvidersSettingsScreen.tsx`, and
`server/src/app/routes/sessions.ts`. This step is pure mechanical find-and-replace — no
behavior change, so it's safe to do first and land as its own PR.

### 3.2 Layer 2 — CLI provider data + dispatch (2 files, not 1 — see why below)

Today the CLI already has *some* per-provider code (`claudeProviderAdapter.ts`,
`codex/codexProviderAdapter.ts`) but there is **no shared interface** — the doc comments
even say so directly:

> "the rest of the `ProviderAdapter` interface ... is separate, not-yet-built ... it is
> deliberately not stubbed out here" (`claudeProviderAdapter.ts:9-14`)

So today "`ProviderAdapter`" is only a name mentioned in comments (design doc §7.3), it is
never an actual TypeScript type anywhere. Let's make it real — but split in two, because
of a real problem the review found: `packages/cli/src/daemon/spawnEngine.ts` and
`resumeSession.ts` run inside the **daemon**, and only need one tiny fact per provider
(what word to put in the respawned command line). If the registry also carries
`runStart` (which pulls in `commands/start.ts` — 1500+ lines of PTY/hook/launcher code —
and `commands/startCodex.ts`), then the daemon ends up importing all of that just to read
a string. So:

**`packages/cli/src/provider/registry.ts` (NEW FILE) — data only, safe for anything to import:**

```ts
import type { ProviderId } from "@falcon/wire";
import { codexProvider } from "../codex/index.js";
import { claudeCodeProvider } from "./claudeProviderAdapter.js";

export interface ProviderDetectionResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  error?: string;
}

export interface ProviderRegistryEntry {
  id: ProviderId;
  /** The word typed after `falcon` — `falcon claude`, `falcon codex`. NOT the same thing as the real binary on PATH (Claude's real binary path is resolved dynamically by `claudeCliLocator.ts`, never hardcoded as a flat string — codex's happens to be the same word today, but that's a coincidence, not a rule). Used by `spawnEngine.ts`/`resumeSession.ts` to build a respawn argv. */
  falconSubcommand: string;
  /** Local auth/config file this provider's account-info reads from. */
  accountConfigPath: (homeDir: string) => string;
  detect: (options?: unknown) => Promise<ProviderDetectionResult>;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderRegistryEntry> = {
  "claude-code": {
    id: "claude-code",
    falconSubcommand: "claude",
    accountConfigPath: () => "~/.claude.json",
    detect: claudeCodeProvider.detect,
  },
  codex: {
    id: "codex",
    falconSubcommand: "codex",
    accountConfigPath: () => "~/.codex/auth.json",
    detect: codexProvider.detect,
  },
};

/** Falcon subcommand string ("claude"/"codex", `args.ts`'s `Provider` type) -> the real `ProviderId`. Small and explicit on purpose — the two are different domains (CLI word vs. provider id) that happen to look similar for codex today. */
export function providerIdForSubcommand(subcommand: string): ProviderId | null {
  const entry = Object.values(PROVIDER_REGISTRY).find((e) => e.falconSubcommand === subcommand);
  return entry?.id ?? null;
}
```

`packages/cli/src/args.ts` now derives its provider list from this, instead of hand-typing
it a second time:

```ts
// packages/cli/src/args.ts — before
export type Provider = "claude" | "codex";
const PROVIDERS = new Set<Provider>(["claude", "codex"]);

// after
import { PROVIDER_REGISTRY } from "./provider/registry.js";
export type Provider = string; // any registered falconSubcommand
const PROVIDERS = new Set(Object.values(PROVIDER_REGISTRY).map((e) => e.falconSubcommand));
```

`spawnEngine.ts`/`resumeSession.ts` drop their copy-pasted maps:

```ts
// packages/cli/src/daemon/spawnEngine.ts — before
const PROVIDER_CLI_NAME: Record<SpawnParams["provider"], string> = {
  "claude-code": "claude",
  codex: "codex",
};
const providerCliName = PROVIDER_CLI_NAME[params.provider];

// after
import { PROVIDER_REGISTRY } from "../provider/registry.js";
const providerCliName = PROVIDER_REGISTRY[params.provider].falconSubcommand;
```

Same change in `resumeSession.ts:52` and its use at line 259
(`PROVIDER_CLI_NAME[persisted.provider ?? "claude-code"]` becomes
`PROVIDER_REGISTRY[persisted.provider ?? "claude-code"].falconSubcommand`).

**`packages/cli/src/provider/dispatch.ts` (NEW FILE) — behavior, only imported by `index.ts`:**

```ts
import type { ProviderId } from "@falcon/wire";
import { runStartClaudeCommand } from "../commands/start.js";
import { runStartCodexCommand } from "../commands/startCodex.js";
import type { Logger } from "../logger.js";
import { resolveClaudeLauncherPath } from "../claude/claudeLocalLauncher.js"; // same resolver index.ts already calls

export interface StartCommandDeps {
  homeDir: string;
  workingDirectory: string;
  providerArgs: string[];
  logger: Logger;
}

const RUN_START: Record<ProviderId, (deps: StartCommandDeps) => Promise<number>> = {
  "claude-code": (deps) =>
    runStartClaudeCommand({
      homeDir: deps.homeDir,
      workingDirectory: deps.workingDirectory,
      claudeArgs: deps.providerArgs,
      launcherPath: resolveClaudeLauncherPath(), // the first draft forgot this required field
      logger: deps.logger,
    }),
  codex: (deps) =>
    runStartCodexCommand({
      homeDir: deps.homeDir,
      workingDirectory: deps.workingDirectory,
      codexArgs: deps.providerArgs,
      logger: deps.logger,
    }),
};

export function runStart(id: ProviderId, deps: StartCommandDeps): Promise<number> {
  return RUN_START[id](deps);
}
```

`packages/cli/src/index.ts:393` stops being an `if/else`. Note `command.provider` here is
the falcon-subcommand string (`args.ts`'s `Provider`, e.g. `"claude"`), not a `ProviderId`
(`"claude-code"`) — the first draft's code sample skipped this mapping and would not have
compiled. Fixed:

```ts
// before (packages/cli/src/index.ts:393-407)
if (command.provider === "claude") {
  return runStartClaudeCommand({ ... });
}
return runStartCodexCommand({ ... });

// after
import { providerIdForSubcommand } from "./provider/registry.js";
import { runStart } from "./provider/dispatch.js";

const providerId = providerIdForSubcommand(command.provider);
if (!providerId) {
  process.stderr.write(`falcon: unknown provider "${command.provider}"\n`);
  return 1;
}
return runStart(providerId, {
  homeDir: resolveHomeDir(),
  workingDirectory: workingDirectory.directory,
  providerArgs: command.providerArgs,
  logger,
});
```

### 3.3 Layer 3 — web display registry (`packages/web/src/lib/providers.ts`, NEW FILE)

This merges what today is spread across `new-session/provider-meta.ts`,
`new-session/model-meta.ts`, `session-list/components/agent-icon.tsx`, and
`provider-accounts/types.ts`. Capabilities are NOT redeclared here — they're imported
from `@falcon/wire` (§3.1), fixing the review's duplication finding. The "Provider
default" sentinel option that the first draft accidentally dropped is kept.

```ts
import { getProviderCapabilities, type ProviderId } from "@falcon/wire";

export interface ModelOption {
  value: string;
  label: string;
}

export const DEFAULT_MODEL_VALUE = "__default__";
const DEFAULT_MODEL_OPTION: ModelOption = { value: DEFAULT_MODEL_VALUE, label: "Provider default" };

export interface WebProviderMeta {
  id: ProviderId;
  label: string;
  iconSrc: string;
  beta: boolean;
  betaNote?: string;
  /** Curated `--model` choices shown at NEW-session time (spawn-time). Always starts with "Provider default". */
  spawnModels: ModelOption[];
  /**
   * Curated choices for a session ALREADY running. Empty array = "no live
   * switch UI at all" (§5.3) — today only claude-code's values are also
   * enforced by the wire-level `RUNNING_SESSION_MODEL_ALIASES` enum
   * (`packages/wire/src/rpc.ts:895`); if a second provider ever gets live
   * model-switch support, that enum needs to grow (or become a plain
   * `z.string()`) at the same time this list does — flagged here so it
   * isn't forgotten again.
   */
  runningSessionModels: ModelOption[];
}

const UNKNOWN_PROVIDER_META: WebProviderMeta = {
  id: "codex", // placeholder id, never read — see getProviderMeta's doc comment
  label: "Agent",
  iconSrc: "",
  beta: false,
  spawnModels: [DEFAULT_MODEL_OPTION],
  runningSessionModels: [],
};

export const PROVIDER_META: Record<ProviderId, WebProviderMeta> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    iconSrc: "/icons/claude.svg",
    beta: false,
    spawnModels: [
      DEFAULT_MODEL_OPTION,
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet[1m]", label: "Sonnet (1M)" },
      { value: "opus[1m]", label: "Opus (1M)" },
    ],
    runningSessionModels: [
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet[1m]", label: "Sonnet (1M)" },
      { value: "opus[1m]", label: "Opus (1M)" },
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    iconSrc: "/icons/codex.svg",
    beta: true,
    betaNote:
      "Codex support is in beta: no local TUI attach, and feature parity with Claude Code may lag.",
    spawnModels: [
      DEFAULT_MODEL_OPTION,
      { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
    ],
    runningSessionModels: [], // no live switch — see §5.3
  },
};

/**
 * Safe accessor. `SessionRow.provider` (`@falcon/wire`) is a free `z.string()`,
 * not this file's `ProviderId` enum — a session from an old build, or a
 * provider this particular web build doesn't know about yet, must render
 * SOMETHING instead of crashing on `.capabilities` / `.label`.
 */
export function getProviderMeta(provider: string): WebProviderMeta {
  return PROVIDER_META[provider as ProviderId] ?? { ...UNKNOWN_PROVIDER_META, label: provider || "Agent" };
}

export { getProviderCapabilities } from "@falcon/wire";
```

`agent-icon.tsx` becomes a thin wrapper (kept, because its own doc comment already
requires leniency for raw/unknown provider strings from old sessions):

```ts
import { getProviderMeta } from "@/lib/providers";

export function agentIconSrc(provider: string): string | null {
  const src = getProviderMeta(provider).iconSrc;
  return src || null;
}
```

## 4. Why this design, and not something bigger

- We do **not** invent a plugin system, a config file, or dynamic provider loading. The
  user's own project rules say: don't build machinery you don't need yet. A `Record`
  keyed by a handful of ids is enough for "a few agents," and is the simplest thing that
  removes the copy-paste problem.
- We keep 3 files (wire, CLI, web) instead of 1, because the CLI needs to know things the
  browser never does (how to spawn a process, which config file to read) and the web
  needs things the CLI never does (icon path, display label, beta banner text). Mixing
  them would force browser code to import Node-only CLI modules. Capabilities are the one
  thing genuinely shared, so — after the review's correction — they live in exactly one
  place (`@falcon/wire`), and CLI/web each only add fields truly private to their side.
- Splitting `registry.ts` (data) from `dispatch.ts` (behavior) on the CLI side isn't
  extra ceremony for its own sake — it's the direct fix for a real coupling bug the review
  found: without the split, the **daemon** (`spawnEngine.ts`, `resumeSession.ts`) would
  transitively import `commands/start.ts`'s entire PTY/hook/launcher subsystem just to
  read one string.
- Every list above is a plain object/array, not a class, not a DI container — matches
  this codebase's existing style (`claudeCodeProvider`/`codexProvider` are already plain
  objects, `ADAPTER_MANIFEST` in `adapters/manifest.ts` is already a plain `Record`).
- A `Record<ProviderId, X>` already fails to *compile* if a provider is missing a key —
  that's the main protection against drift, for free, from TypeScript itself. A runtime
  guard test (§8) is a cheap backstop on top, not the main defense.

## 5. Now fix the 5 real bugs, using the registry

### 5.1 Bug: mode selector is dead for Codex sessions (and a second bug hiding behind it)

**Root cause** (confirmed live): `deriveControlMode` in
`packages/web/src/features/session-control/session-state.ts:12-18` starts every session
at `"local"` and only flips to `"remote"` when it sees a `mode-switch` wire event. Only
`packages/cli/src/claude/claudeLocalLauncher.ts:190` and `claudeRemoteLauncher.ts:298`
ever emit that event — because those are the only two files that implement Claude's
local↔remote hand-off loop. `startCodex.ts` has no such loop, so it never emits one, so
Codex sessions are permanently stuck reading as `"local"`.

**Fix, in 3 parts** (the review caught that the first draft only had 2, and the missing
third part would have shipped a new dead button).

**Part A — make every remote-only provider announce itself once, at session start.**

```ts
// packages/cli/src/session/announceRemoteControl.ts (NEW FILE)
import { createEnvelope, type SessionEnvelope } from "@falcon/wire";

/**
 * Providers with no local terminal mode (`capabilities.hasLocalMode === false`)
 * never go through Claude's local<->remote hand-off loop, so `deriveControlMode`
 * on the web never learns this session is "remote" (see known-issues.md, the
 * Codex mode-selector bug). Call this once, right after the provider's remote
 * loop is up, so the web starts these sessions in the correct control state
 * from envelope #1 instead of defaulting to "local" forever.
 */
export function announceRemoteControl(): SessionEnvelope {
  return createEnvelope("agent", { t: "mode-switch", control: "remote", by: "client" });
}
```

In `startCodex.ts`, right after `startAcpRemote(...)` is created (around line 310, before
`registerRpc`), enqueue it:

```ts
const remote = startAcpRemote({ ... });
outbox.enqueue([announceRemoteControl()]);
```

Known, accepted side effect: this renders a "Switched to remote mode (by client)" service
line at the top of every Codex timeline (`TimelineRow.tsx:39-42`), same as it already does
for Claude's own remote hand-off. Acceptable — it's honest, not a bug.

**Part B — gate the mode-mutate check on the capability, not just controlMode.**
After Part A, Codex sessions correctly report `controlMode === "remote"`. Making the
capability check explicit here protects a FUTURE provider that is remote-only but
genuinely can't live-switch modes from getting a working button just by accident:

```ts
// packages/web/src/components/timeline/mode-switch-state.ts
export function canMutateMode(
  controlMode: "local" | "remote",
  supportsLiveModeSwitch: boolean,
  ptySetModeEnabled = false,
): boolean {
  if (!supportsLiveModeSwitch) return false;
  return controlMode === "remote" || (controlMode === "local" && ptySetModeEnabled);
}
```

**Part C — the bug Part A introduces if left alone, and its fix.** `shouldShowTakeControl`
(`mode-switch-state.ts:8-10`) only checks `controlMode`:

```ts
// today
export function shouldShowTakeControl(controlMode: "local" | "remote"): boolean {
  return controlMode === "remote";
}
```

Once Part A makes Codex sessions read as `"remote"`, this starts returning `true` for
them too — rendering a "Take control" button whose RPC handler is a hardcoded
`{ok:false}` (`startCodex.ts:359-362`, "Codex has no local mode to return to"). **This
must ship in the same PR as Part A**, not as a follow-up:

```ts
export function shouldShowTakeControl(controlMode: "local" | "remote", supportsTakeControl: boolean): boolean {
  return supportsTakeControl && controlMode === "remote";
}
```

Both callers in `ComposerControls.tsx` (line 160 and line 180) now pass
`getProviderCapabilities(provider).supportsLiveModeSwitch` /
`.supportsTakeControl` — which means `provider` needs to be threaded down from
`SessionTimelineScreen.tsx` into `ComposerControls`, the same way `modelChip`/`mode`
already are (`SessionTimelineScreen.tsx:339-345`). Use `provider: string` (matching
`SessionRow.provider`), not a narrowed `ProviderId` — `getProviderCapabilities` is the
safe/lenient accessor from §3.1 specifically so an unknown provider string degrades to
"nothing is mutable" instead of a crash.

### 5.2 Bug: hardcoded "Claude exit" text on a Codex session

**Root cause** (confirmed live): `packages/web/src/features/session-list/components/
session-card-actions.tsx:288` and `packages/web/src/components/timeline/
SessionActionsMenu.tsx:252` both hardcode the word "Claude" in the stop-confirmation
dialog, with no `provider` prop at all.

**Fix:** thread `provider` in (both components already receive `sessionId`/`title` from
a parent that has the full `SessionRow`, so this is one more prop, not a new plumbing
path), then read the label from the registry:

```tsx
// packages/web/src/components/timeline/SessionActionsMenu.tsx
import { getProviderMeta } from "@/lib/providers";

// add `provider: string` to the props type, then:
const providerLabel = getProviderMeta(provider).label || "the agent";

// in the dialog:
<DialogDescription>
  Ends the CLI process on the machine. The terminal user will see {providerLabel} exit.
</DialogDescription>
```

Same change in `session-card-actions.tsx`. Small, boring, but real — a support ticket
from a Codex user reading "you will see Claude exit" is a trust problem.

### 5.3 Bug: model selector — make it correct on purpose, not by accident

Live testing found no bug here (verified: no dropdown renders for Codex, only a
read-only chip) — but only because `RUNNING_SESSION_MODEL_OPTIONS` in
`ComposerControls.tsx:39` is hardcoded to `MODEL_OPTIONS["claude-code"]` regardless of
which provider is actually running. Fix it now so it's correct **on purpose**, using the
lenient `getProviderMeta`/`getProviderCapabilities` accessors (not a direct `PROVIDER_
META[provider]` index — `provider` is an open string, and a direct index would crash on
an unrecognized value):

```tsx
// packages/web/src/components/timeline/ComposerControls.tsx
// before:
const RUNNING_SESSION_MODEL_OPTIONS = MODEL_OPTIONS["claude-code"].filter(
  (option) => option.value !== DEFAULT_MODEL_VALUE,
);
// after: compute per-render from the actual session's provider
const runningSessionModelOptions = getProviderMeta(provider).runningSessionModels;
// ...
{canMutateModel(controlMode, getProviderCapabilities(provider).supportsLiveModelSwitch, PTY_SET_MODEL_ENABLED) && (
  <PromptInputSelect ...>
    {runningSessionModelOptions.map((option) => (
      <PromptInputSelectItem key={option.value} value={option.value}>{option.label}</PromptInputSelectItem>
    ))}
  </PromptInputSelect>
)}
```

`model-switch-state.ts`'s `canMutateModel` gets the same treatment as §5.1's
`canMutateMode`:

```ts
export function canMutateModel(
  controlMode: "local" | "remote",
  supportsLiveModelSwitch: boolean,
  ptySetModelEnabled = false,
): boolean {
  if (!supportsLiveModelSwitch) return false;
  return controlMode === "local" && ptySetModelEnabled;
}
```

Also update `packages/web/src/features/new-session/model-meta.ts`'s
`model-meta.test.ts` drift-guard (it currently checks `MODEL_OPTIONS["claude-code"]`
against `RUNNING_SESSION_MODEL_ALIASES`) to point at `PROVIDER_META["claude-code"].
runningSessionModels` instead, once `model-meta.ts` is folded into `lib/providers.ts`.

### 5.4 Bug: `workspaceId` never recorded for Codex sessions (issue #6)

**Root cause:** `packages/cli/src/commands/start.ts:541-557` has a "3.5. Register (or
resolve) this directory as a workspace" step that calls `registerWorkspace()` and threads
the result into `bootstrapSession`. `startCodex.ts` has no equivalent step at all.

**Fix — don't just copy-paste the block into `startCodex.ts`.** Pull it into one shared
helper both commands call — this logic has nothing to do with Claude specifically:

```ts
// packages/cli/src/session/registerSessionWorkspace.ts (NEW FILE)
import { registerWorkspace as registerWorkspaceDefault } from "../workspace/registry.js";
import type { Logger } from "../logger.js";

export interface RegisterSessionWorkspaceDeps {
  registerWorkspace?: typeof registerWorkspaceDefault;
  logger: Logger;
}

/**
 * Register-or-resolve `workingDirectory` as a workspace so the session row
 * gets a real `workspaceId` (known-issues.md #6 — git diff / Repo files /
 * Checks / timeline file-open all gate on this). Best-effort: a registry
 * write failure (e.g. lock contention) must never block starting a session
 * — it just leaves `workspaceId` unset, same as before this fix existed.
 * Shared by every provider's start command so a future one doesn't have to
 * remember to re-implement this.
 */
export async function registerSessionWorkspace(
  workingDirectory: string,
  deps: RegisterSessionWorkspaceDeps,
): Promise<string | null> {
  const doRegisterWorkspace = deps.registerWorkspace ?? registerWorkspaceDefault;
  try {
    const entry = await doRegisterWorkspace(workingDirectory);
    return entry.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("[register-session-workspace] failed, continuing without workspaceId", {
      message,
    });
    return null;
  }
}
```

`start.ts:541-557` becomes `const workspaceId = await registerSessionWorkspace(deps.
workingDirectory, { logger });`. `startCodex.ts` gets the same line added right before
its `doBootstrapSession(...)` call (around line 189), and `workspaceId` gets added to the
params object at line 196-203:

```ts
const workspaceId = await registerSessionWorkspace(deps.workingDirectory, { logger });

bootstrap = await doBootstrapSession(
  createBootstrapSessionDeps({ serverUrl: backendUrl, fetchImpl, getAuthToken: () => accessToken, logger }),
  {
    machineId,
    workspacePath: deps.workingDirectory,
    workspaceId,              // <- the fix
    nonce: createId(),
    provider: "codex",
    contentKeyPair,
    metadata: sessionMetadata,
  },
);
```

One test-plumbing note the review caught: `StartCodexCommandDeps` has no
`registerWorkspace` injectable today (unlike `start.ts`, which already has one at line
331). Add it to `StartCodexCommandDeps` too, or `startCodex.test.ts`'s existing tests will
hit the real on-disk registry the first time this fix lands.

### 5.5 Bug: Codex "continue this session" silently starts a fresh conversation

**This section was rewritten after the independent review found the first draft's fix
was a no-op. Everything below was re-verified by reading the code again.**

**What's actually true, verified:**

1. `--continue-from <id>` is a **write-only flag today, for both providers** —
   `spawnEngine.ts:210` and `commands/adopt.ts:184` both *produce* it (push it onto a
   respawned/detached argv), but nothing anywhere in `packages/cli/src` ever reads it back
   out of `providerArgs`/`claudeArgs`/`codexArgs`. Grep confirms zero consumers. (The
   first draft claimed `adopt.ts` "consumes" it — wrong; it's a producer, on a different
   spawn path than the one that would need to read it.)
2. `args.ts:105-107` forwards *everything* after the provider name to `providerArgs`
   verbatim and Falcon "never interprets provider flags" by design — so a consumer has to
   be added deliberately, it won't happen by accident.
3. `AcpRemoteOptions.resume` (`acpRemote.ts:96`) IS real, but only for `claude-code`: it
   flows into `_meta.claudeCode.options.resume` (`acpRemote.ts:245-261`), which only the
   Claude ACP adapter reads — `sessionMeta` is hardcoded `null` for every other adapter
   id (line 249-261). Worse: `startAcpRemote`'s startup sequence
   (`acpRemote.ts:266-275`) **always** calls `connection.createSession(...)` — a brand
   NEW session — and unconditionally overwrites `providerSessionId` with the fresh id
   returned. There is no code path, for any provider, that calls `AcpConnection.
   loadSession` (`acpConnection.ts:467-484`) — the ACP protocol-level "resume an existing
   session" call. So passing `resume` through to `startAcpRemote` for Codex, as the first
   draft proposed, changes nothing: `sessionMeta` stays `null`, `createSession` still runs,
   the old conversation is never touched.
4. `AcpConnection.loadSession` exists but is capability-gated:
   `supportsSessionLoad()` (`acpConnection.ts:264-266`) returns
   `agentCapabilities?.loadSession === true` — a fact only known AFTER connecting to the
   real adapter process. **Whether `codex-acp` actually advertises this capability is not
   knowable by reading the code — it must be checked against a real running adapter.**

**The real fix has two parts, and is bigger than the first draft scoped it.**

**Part A — actually read the flag, in `startCodex.ts`:**

```ts
function extractContinueFromFlag(args: string[]): string | null {
  const idx = args.indexOf("--continue-from");
  return idx === -1 ? null : (args[idx + 1] ?? null);
}
// ...
const resumeProviderSessionId = extractContinueFromFlag(deps.codexArgs);
```

**Part B — make `startAcpRemote` able to actually resume, for adapters that support it,
falling back safely when they don't:**

```ts
// packages/cli/src/acp/acpRemote.ts — replace the `ready` IIFE (lines 266-275)
const ready: Promise<string> = (async () => {
  await connection.connect();
  let session: { sessionId: string };
  if (opts.resume && connection.supportsSessionLoad()) {
    try {
      session = await connection.loadSession(opts.resume, opts.workingDirectory);
    } catch (error) {
      // Capability was advertised but the specific session id couldn't be
      // restored (e.g. expired, deleted provider-side) — fall back to a
      // fresh session rather than fail the whole start.
      logger.warn("[acp-remote] loadSession failed, starting a fresh session instead", {
        error: error instanceof Error ? error.message : String(error),
      });
      session = await connection.createSession({ cwd: opts.workingDirectory, meta: sessionMeta });
    }
  } else {
    session = await connection.createSession({ cwd: opts.workingDirectory, meta: sessionMeta });
  }
  providerSessionId = session.sessionId;
  opts.onProviderSessionId?.(session.sessionId);
  return session.sessionId;
})();
```

This is additive and safe for Claude: `claude-code`'s existing resume mechanism
(`_meta.claudeCode.options.resume`) is untouched — this new branch only activates when
`opts.resume` is set AND `supportsSessionLoad()` is true, which today is decided per
connected adapter, not per hardcoded provider id.

**Before shipping this, live-verify (not just unit-test) that `codex-acp` actually
advertises `loadSession` and that `session/load` genuinely restores conversation history
— not just the working directory.** If it turns out unsupported, the honest fix is: keep
`supportsResume: false` in `PROVIDER_CAPABILITIES.codex` (§3.1), and have the "continue
this session" UI action explicitly say "starts a fresh Codex conversation in the same
directory" instead of implying continuity it can't deliver — matching this project's own
rule ("never claim a security/behavior property you haven't verified").

**Do not** write a unit test that only asserts `startAcpRemote` was called with
`resume: "xyz"` — that would pass against the exact broken behavior this section
describes. The real regression check is an E2E one: start a Codex session, have it learn
a fact, kill it, resume it via `--continue-from`, and confirm the fact is still known.

### 5.6 Bug: plan/todo list never shows up for Codex

**Root cause:** `packages/cli/src/acp/acpToEnvelope.ts` (see its own doc comment, lines
20-32) explicitly drops ACP's `plan`/`plan_update`/`plan_removed` updates — there is no
wire event for them. This is provider-agnostic infrastructure (`acpToEnvelope.ts` is
shared by every ACP-driven provider), so fixing it here benefits Codex AND any future
ACP-based agent (a real OpenCode ACP adapter would be too) automatically.

**Fix — add a real wire event.** In `packages/wire/src/session.ts`, add one more member
to the `SessionEventSchema` discriminated union (after `usage`, around line 98):

```ts
z.object({
  t: z.literal("plan"),
  steps: z.array(
    z.object({
      text: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
}),
```

In `acpToEnvelope.ts`, replace the "drop it" branch with a real mapping — including
`plan_removed`, which the first draft's fix cited as a root cause but forgot to actually
handle:

```ts
case "plan":
case "plan_update":
  return [
    createEnvelope("agent", {
      t: "plan",
      steps: update.entries.map((entry) => ({ text: entry.content, status: entry.status })),
    }, { turn: turnId }),
  ];
case "plan_removed":
  return [createEnvelope("agent", { t: "plan", steps: [] }, { turn: turnId })];
```

(Field names above are simplified — verify against a real captured ACP trace the same way
this file's other mappings were verified, per its own header comment's existing
convention.)

Web side: add a `PlanItem` to `packages/web/src/sync/reducer/types.ts` (same shape as the
existing `UsageItem` at line 86-92 — a simple "one snapshot replaces the last one" item,
not a start/end pair), a `case "plan":` in `packages/web/src/sync/reducer/reduce.ts`
next to the existing `case "usage":` at line 162, and a small checklist-style renderer in
`packages/web/src/components/timeline/TimelineRow.tsx` next to its existing
`case "mode-switch":` (line 39).

This is the largest single fix in this document, so it should be its own PR, tested
against a real Codex run the same way §5.1-§5.4 were live-verified in this session.

## 6. Worked example — adding OpenCode, step by step

This is the real test of whether the registry design above is actually "abstract and
easy to extend." Below is a realistic accounting — the first draft undercounted this by
skipping `args.ts`, the settings screen, and the genuine difficulty of provider
detection/auth, which the review flagged.

1. **`packages/wire/src/providers.ts`** — add one line to `PROVIDER_IDS`, one entry to
   `PROVIDER_CAPABILITIES` (real capabilities, not guessed — if OpenCode has a real local
   TUI, `hasLocalMode: true` means porting or generalizing Claude's PTY/hook/launcher
   subsystem (`packages/cli/src/claude/`), which is NOT provider-agnostic today and is
   real work, not a registry entry).
2. **`packages/cli/src/opencode/opencodeProviderAdapter.ts`** (NEW FILE) — `detect()` +
   whatever spawn logic OpenCode needs. This is the hard part the first draft hand-waved:
   Claude's own detection (`claudeCliLocator.ts`, 400+ lines) resolves a real binary path,
   checks auth state, handles multiple install methods. Budget real time for this, don't
   assume "copy the shape" means "copy-paste and rename."
3. **`packages/cli/src/commands/startOpenCode.ts`** (NEW FILE, if OpenCode is ACP-based
   and has no local mode — likely closer to `startCodex.ts`'s shape) OR extend the local
   PTY path (if it has a real TUI — closer to `start.ts`'s shape, and a bigger lift, per
   step 1's note).
4. **`packages/cli/src/provider/registry.ts`** — add one entry to `PROVIDER_REGISTRY`
   (`falconSubcommand`, `accountConfigPath`, `detect`).
5. **`packages/cli/src/provider/dispatch.ts`** — add one entry to `RUN_START`.
6. **`packages/cli/src/adapters/manifest.ts`** — if ACP-based: add OpenCode's npm package
   name, pinned version, and integrity hash, same shape as the existing `codex` entry —
   this requires actually vetting and pinning a real npm package, not just writing a
   string.
7. **`packages/web/src/lib/providers.ts`** — add one entry to `PROVIDER_META` (label,
   icon — `/icons/opencode.svg` **already exists** in this repo, someone anticipated
   this), model list.
8. **`packages/web/src/features/settings/components/AgentSection.tsx`** — this file's
   `claudeModel`/`codexModel` pair of `useState`s and its `if (forProvider === ...)`
   branch (see §2.1) need to become a loop over `PROVIDER_IDS` instead of a 3rd hand-added
   branch — worth doing as its own small refactor before OpenCode lands, not as part of
   adding it.
9. **`packages/web/src/features/session-list/review-spawn.ts:29`** and
   **`packages/cli/src/daemon/adoptTake.ts:160`** — both currently hardcode
   `provider: "claude-code"` for their respective spawn flows. Decide deliberately what
   these should do for a 3rd provider (probably: use the CURRENT session's own provider,
   not always Claude) — this is an actual product decision, not a mechanical registry
   addition, so call it out in the PR description rather than silently picking one.

That's a real 2-3 new files + several registry entries + two small pre-existing refactors
— smaller than hunting through 30+ hardcoded spots by grep, but genuinely more than "2
files and 5 one-liners." Detection/auth (step 2) and the settings screen (step 8) are the
two places actual engineering judgment is still needed, not just data entry.

## 7. Suggested order of work (each step is a separate, shippable PR)

Reordered after review: ship the bug fixes that don't depend on the registry FIRST — no
reason to make users wait on a refactor for a fix that doesn't need it.

1. **§5.4 (workspaceId)** — smallest, highest-impact real bug fix, zero dependency on
   anything else in this doc. Ship first.
2. **§5.2 (hardcoded "Claude" text)** — smallest UI fix, also zero dependency. Ship
   alongside or right after #1.
3. **§3.1** — introduce `packages/wire/src/providers.ts` (ids + capabilities), migrate the
   4 `rpc.ts` spots + `controlServer.ts` + `sessions.ts` (server) + the rest of §2's plain
   union list to use it. Pure refactor, no behavior change. Safe, easy to review.
4. **§3.2** — introduce `registry.ts` + `dispatch.ts`, fold `args.ts`'s provider list in,
   remove the two copy-pasted `PROVIDER_CLI_NAME` maps. Still a refactor, but touches the
   daemon's spawn/resume paths — needs the live re-spawn/resume tests re-run, not just
   `pnpm test`.
5. **§3.3** — introduce the web registry, migrate `provider-meta.ts`/`model-meta.ts`/
   `agent-icon.tsx`/`provider-accounts/types.ts` to it.
6. **§5.1 (mode/take-control) + §5.3 (model selector)** — depends on §3.1 + §3.3 both
   existing. Ship together, all 3 parts of §5.1 in the SAME PR (Part A without Part C
   ships a new bug, per the review's finding).
7. **§5.5 (resume wiring)** — do NOT treat this as small. Requires the `acpRemote.ts`
   startup-sequence change (§5.5 Part B) plus real live verification against a running
   `codex-acp` process before trusting it. Budget it as its own investigation-plus-fix
   cycle, not a quick follow-up.
8. **§5.6 (plan/todo rendering)** — biggest, do last, needs its own careful live
   verification against a real Codex (and ideally a real Claude) run, the same way this
   whole investigation was done: reproduce for real, not just read the code.

Do NOT do §6 (add OpenCode) as part of this plan — it's a worked example to prove the
design, not a task to execute yet. Do it as a separate follow-up once OpenCode support is
actually prioritized, and treat how smoothly it goes as the real test of whether this
plan worked.

## 8. Testing notes

- Every new/changed pure function above (`canMutateMode`, `canMutateModel`,
  `shouldShowTakeControl`, `registerSessionWorkspace`, `announceRemoteControl`,
  `getProviderMeta`, `getProviderCapabilities`) is a small, dependency-injected
  function — keep unit-testing them the way this codebase already does (see
  `mode-switch-state.test.ts`'s existing precedent), no new test infrastructure needed.
- §5.4, §5.1, and §5.5 should be **re-verified live** the same way they were found: real
  `falcon codex` process, real web browser, not just `pnpm test` passing. This project's
  own `CLAUDE.md` rule applies directly here: "reproduce the bug in an E2E setting... this
  makes sure your fix actually solves it." §5.5 in particular must not be marked done off
  a unit test alone — see that section's own warning about a false-positive test shape.
- After §3.1-§3.3 land, add one guard test (e.g.
  `packages/wire/src/providers.test.ts`) that fails loudly if `PROVIDER_IDS`,
  `PROVIDER_CAPABILITIES`'s keys, `PROVIDER_REGISTRY`'s keys (CLI), and `PROVIDER_META`'s
  keys (web) ever drift apart. This is a backstop, not the primary defense — the `Record<
  ProviderId, X>` types already make a missing key a compile error in each of the 3 files;
  this test only catches drift between files that all individually compile.

## 9. Detailed task checklist

Not implemented yet — this is the breakdown to work from, one phase at a time, in the
order from §7. Each phase is small enough to be its own PR. Check items off as they land.

### Phase 1 — §5.4 workspaceId fix (ship first, no dependencies) — ✅ DONE

- [x] Re-read `packages/cli/src/workspace/registry.ts`'s `registerWorkspace()` return
      shape before writing the helper (confirm `entry.path` is still the right field)
- [x] Create `packages/cli/src/session/registerSessionWorkspace.ts` with
      `RegisterSessionWorkspaceDeps` + `registerSessionWorkspace()`
- [x] Create `packages/cli/src/session/registerSessionWorkspace.test.ts`: success case
      returns `entry.path`; failure case (mocked `registerWorkspace` throws) returns
      `null`, logs a warning, never throws
- [x] Refactor `start.ts:541-557` to call the new helper instead of its inline try/catch
- [x] Run `start.test.ts`, confirm no regression from the refactor
- [x] Add `registerWorkspace?: typeof registerWorkspaceDefault` to
      `StartCodexCommandDeps` in `startCodex.ts` (it has no such injectable today —
      needed or tests will hit the real on-disk registry)
- [x] Call `registerSessionWorkspace()` in `startCodex.ts` before
      `doBootstrapSession(...)`; add `workspaceId` to the bootstrap params object
- [x] Add test cases to `startCodex.test.ts`: workspaceId populated on success;
      workspaceId `null` on failure; `bootstrapSession` called with the right value
- [x] `pnpm --filter falcon typecheck` and `pnpm --filter falcon test`
- [x] **Live-verify**: real `falcon codex` session in a fresh directory — confirmed:
      the session now appears under "Workspaces" (not "Other sessions") on Home, and the
      session detail page's right panel switched from "no machine/workspace recorded
      yet" to actually attempting to load git status, instead of showing the gate
      message unconditionally
- [x] Update `docs/known-issues.md` issue #6 per its own "remove once resolved and
      verified" convention — done in the cross-cutting phase below, after the full live
      checklist re-run confirmed the fix

### Phase 2 — §5.2 hardcoded "Claude" text (ship first, no dependencies) — ✅ DONE

- [x] Trace `SessionCardActions`'s and `SessionActionsMenu`'s call sites to confirm
      `provider` (or the full `SessionRow`) is already available in each parent's scope
- [x] Add `provider: string` prop to `SessionCardActions`, thread it from its caller
- [x] Add `provider: string` prop to `SessionActionsMenu`, thread it from its caller
      (via `SessionTimelineScreen`/`SessionTimelineBody`, which now also carries
      `provider` down for Phase 6's `ComposerControls` wiring)
- [x] Since `lib/providers.ts` doesn't exist until Phase 5, added a small temporary
      `packages/web/src/lib/provider-label.ts` (`providerLabel()`) for now — replaced by
      `getProviderMeta` in Phase 5
- [x] Replaced the hardcoded "Claude" string in both dialogs with the looked-up label +
      `?? "the agent"` fallback
- [x] Added `provider-label.test.ts` (unit coverage for the lookup logic itself); the
      dialogs' OPEN-state text isn't unit-testable in this package (no RTL/jsdom setup —
      Radix `Dialog` doesn't render closed content into static markup), so that's covered
      by live-verify instead, matching this codebase's existing testing conventions
- [x] `pnpm --filter @falcon/web typecheck` and `pnpm --filter @falcon/web test`
- [x] **Live-verify**: opened the stop-confirmation dialog on a real running codex
      session — confirmed it reads "Ends the CLI process on the machine. The terminal
      user will see Codex exit." (not "Claude")

### Phase 3 — §3.1 wire provider registry (pure refactor, no behavior change) — ✅ DONE

- [x] Create `packages/wire/src/providers.ts`: `PROVIDER_IDS`, `ProviderId`,
      `ProviderIdSchema`, `ProviderCapabilities`, `PROVIDER_CAPABILITIES`,
      `getProviderCapabilities()`
- [x] Export the new module from `packages/wire/src/index.ts`
- [x] Create `packages/wire/src/providers.test.ts`: schema round-trips,
      `getProviderCapabilities` fallback for unknown strings, capability values match
      what's documented in §3.1
- [x] Migrate `packages/wire/src/rpc.ts` (4 spots: lines 34, 107, 224, 249) to
      `ProviderIdSchema`
- [x] Migrate `packages/cli/src/daemon/controlServer.ts:102`
- [x] Migrate `packages/cli/src/daemon/providerAccountInfo.ts:43` (the type only —
      its logic branches at lines 160/176/179/233 are Phase 4/6 territory)
- [x] Migrate `packages/cli/src/daemon/sessionsStore.ts:42,101`
- [x] Migrate `packages/cli/src/daemon/types.ts:32,62`
- [x] Migrate `packages/cli/src/session/bootstrap.ts:58` (dropped the redundant local
      `SessionProvider` alias entirely — it had no other consumers — instead of keeping
      a second name for the same type)
- [x] Migrate `packages/server/src/app/routes/sessions.ts:19`
- [x] Migrate `packages/web/src/features/provider-accounts/types.ts:21` (kept the
      `ProviderAccountProvider` name, now aliased to `ProviderId` — ~5 call sites use it,
      full consolidation is Phase 5's job)
- [x] Migrate `packages/web/src/features/new-session/types.ts:32` (same: kept
      `NewSessionProvider`, now aliased to `ProviderId` — ~11 call sites)
- [x] Migrate `packages/web/src/features/new-session/favorites.ts:49`
- [x] Bonus (mechanical, same pattern): migrated
      `ProvidersSettingsScreen.tsx:12`'s hardcoded `PROVIDERS` array to
      `[...PROVIDER_IDS]` while in the neighborhood — Phase 5's checklist item for this
      file is now just re-pointing its type imports at `lib/providers.ts`
- [x] `pnpm --filter @falcon/wire build`, then `pnpm typecheck` on all 4 packages
      (wire/cli/server/web) — all clean
- [x] Full `pnpm test` on all 4 packages: 193 (wire) + 2143 (cli) + 422 (server) + 1564
      (web) = 4322 tests, all green
- [x] Confirmed zero runtime behavior change — every touched file is a type/schema swap
      to an equivalent value, verified by the full test suite staying green with no test
      changes needed on the consuming side beyond the schema/type migration itself

### Phase 4 — §3.2 CLI `registry.ts` + `dispatch.ts` — ✅ DONE

- [x] Create `packages/cli/src/provider/registry.ts`: `ProviderRegistryEntry`,
      `PROVIDER_REGISTRY`, `providerIdForSubcommand()` (note: `detect` ended up typed
      `() => Promise<ProviderDetectionResult>`, no options param — matches how
      `daemon/doctor.ts` already calls these functions in production; the options
      parameter on the underlying `detectClaudeCode`/`detectCodex` is a test-only seam)
- [x] Create `packages/cli/src/provider/registry.test.ts`: every `ProviderId` has an
      entry, `providerIdForSubcommand` round-trips, an unknown subcommand returns `null`
- [x] Create `packages/cli/src/provider/dispatch.ts`: `StartCommandDeps`, `RUN_START`,
      `runStart()` (added a `launcherPath?: string` field to `StartCommandDeps` — the
      first plan draft's dispatch table called a `resolveClaudeLauncherPath()` helper
      directly, but that helper's `import.meta.url`-based resolution is only correct
      when it runs from `index.ts` itself, not a nested module post-bundle-vs-dev path
      difference; `index.ts` now resolves it and passes it in instead)
- [x] Create `packages/cli/src/provider/dispatch.test.ts`: routes to the right
      `runStartClaudeCommand`/`runStartCodexCommand` using `vi.mock`-based fakes, never a
      real process; also covers the missing-`launcherPath` guard throwing
- [x] Refactor `packages/cli/src/args.ts`: derive `PROVIDERS`/`isProvider` from
      `PROVIDER_REGISTRY` instead of a hand-typed union; `Provider` is now `string`
- [x] Refactor `packages/cli/src/index.ts:393-407`: replaced the if/else with
      `providerIdForSubcommand()` + `dispatchStart()`, with an honest "unknown provider"
      error path (structurally unreachable today since `args.ts` already validates, but
      no longer a silent type-level guarantee once `Provider` became `string`)
- [x] Remove `PROVIDER_CLI_NAME` from `spawnEngine.ts`, use
      `PROVIDER_REGISTRY[...].falconSubcommand`
- [x] Remove `PROVIDER_CLI_NAME` from `resumeSession.ts` (both the definition at line 52
      and its use at line 259)
- [x] Confirmed `spawnEngine.ts`/`resumeSession.ts`/`args.ts` only ever import
      `registry.ts`, never `dispatch.ts` (grep-verified directly, not just "it compiles")
- [x] `index.test.ts`, `spawnEngine.test.ts`, `resumeSession.test.ts`, `args.test.ts` all
      still pass unmodified — the refactor preserved every existing observable behavior
- [x] `pnpm --filter falcon typecheck` and `pnpm --filter falcon test`: 2149 tests green
- [x] **Live-verify**: rebuilt the CLI, ran a real `falcon codex` session through the new
      dispatch path (session started, ACP remote connected) and a real `falcon claude`
      session (real Claude Code TUI rendered its trust-folder prompt) — both providers'
      startup routing confirmed working end to end through `registry.ts`/`dispatch.ts`

### Phase 5 — §3.3 web provider registry — ✅ DONE

- [x] Create `packages/web/src/lib/providers.ts`: `ModelOption`, `WebProviderMeta`,
      `PROVIDER_META`, `getProviderMeta()`, re-export `getProviderCapabilities`
- [x] Create `packages/web/src/lib/providers.test.ts`: every `ProviderId` has a
      `PROVIDER_META` entry, `getProviderMeta` fallback for unknown strings,
      `spawnModels` always starts with the "Provider default" sentinel
- [x] Refactor `agent-icon.tsx` to wrap `getProviderMeta` (note: this dropped the file's
      pre-existing, premature `opencode: "/icons/opencode.svg"` entry — `opencode` isn't
      a real registered provider anywhere else in the app yet, so that mapping was dead
      code; it comes back naturally once §6's worked example actually adds `opencode` to
      `PROVIDER_META`)
- [x] Refactor `new-session/provider-meta.ts` to re-export from `lib/providers.ts` — kept
      as a thin wrapper (not deleted) since it has 3 real call sites; its own `ProviderMeta`
      type is now `Pick<WebProviderMeta, "label"|"beta"|"betaNote">` rather than a full
      alias, because the existing test suite constructs minimal `{label, beta}` object
      literals that a full-`WebProviderMeta` parameter type would reject
- [x] Refactor `new-session/model-meta.ts` the same way (`MODEL_OPTIONS` derived from
      `PROVIDER_META[id].spawnModels`; `DEFAULT_MODEL_VALUE` re-exported from
      `lib/providers.ts`, `CUSTOM_MODEL_VALUE` stays local — a UI-only sentinel, not
      provider data)
- [x] `ProvidersSettingsScreen.tsx:12`'s `PROVIDERS` array — already migrated to
      `[...PROVIDER_IDS]` in Phase 3
- [x] Grepped for every remaining import of the old `MODEL_OPTIONS`/`PROVIDER_META`
      exports (`AgentSection.tsx`, `ProviderAccountCard.tsx`, `provider-picker.tsx`,
      `model-picker.tsx`) — all compatible with the re-exports, zero call-site changes
      needed
- [x] Replaced Phase 2's temporary `lib/provider-label.ts` with `getProviderMeta` in both
      `session-card-actions.tsx` and `SessionActionsMenu.tsx`; deleted
      `provider-label.ts`/`provider-label.test.ts`
- [x] Existing `model-meta.test.ts` and `provider-meta.test.ts` needed zero changes (both
      test through the public API, not the internal implementation) — left in place rather
      than folded into `lib/providers.test.ts`, since they cover feature-specific
      contracts (`RUNNING_SESSION_MODEL_ALIASES` drift-guard, `PROVIDER_OPTIONS` ordering)
      `lib/providers.test.ts` doesn't need to know about
- [x] `pnpm --filter @falcon/web typecheck` and `pnpm --filter @falcon/web test`: 1567
      tests green (1564 + 6 new in `providers.test.ts` − 3 removed with
      `provider-label.test.ts`)
- [x] **Live-verify**: new-session wizard — provider picker shows "Claude Code"/"Codex
      (beta)", switching to Codex shows the exact beta-note banner text and the
      GPT-5.1-Codex/GPT-5.1-Codex-Mini model list; Settings → Agent shows both provider
      buttons + per-provider model dropdowns; Settings → Providers renders both
      "Claude Code"/"Codex" account cards; session list icons render correctly

### Phase 6 — §5.1 mode/take-control + §5.3 model selector (ship all 3 parts of §5.1 together) — ✅ DONE

- [x] Create `packages/cli/src/session/announceRemoteControl.ts` with
      `announceRemoteControl()`
- [x] Add its test: envelope shape matches `SessionEventSchema`'s `mode-switch` variant
- [x] Wire `outbox.enqueue([announceRemoteControl()])` into `startCodex.ts` right after
      `startAcpRemote(...)`
- [x] Update `startCodex.test.ts`: assert the announce envelope is enqueued exactly
      once at startup (spy on `Outbox.prototype.enqueue`; also had to give `baseDeps()`
      a real tmp `homeDir` — the announce envelope makes `Outbox`'s dispose-time flush a
      genuine unconditional disk write now, which the placeholder `/fake/home` can't
      survive; `maxRetries`/`retryDelay` on every `rm()` cleanup absorbs the same
      fire-and-forget-write-races-cleanup pattern this codebase already has precedent
      for in `sessionRegistry.test.ts`/`durability.chaos.test.ts`)
- [x] Update `mode-switch-state.ts`: added `supportsLiveModeSwitch` param to
      `canMutateMode`, added `supportsTakeControl` param to `shouldShowTakeControl`
      (both signature changes shipped together with the announce-control change, so
      Part A never ships without Part C's guard)
- [x] Update `session-controls.test.ts` (the real home of these tests — not a separate
      `mode-switch-state.test.ts`) for both new signatures, plus new capability-false
      coverage
- [x] Update `model-switch-state.ts`: added `supportsLiveModelSwitch` param to
      `canMutateModel`
- [x] Updated the same test file for `canMutateModel`'s new signature
- [x] Update `ComposerControls.tsx`: added `provider: string` prop, replaced the
      `MODEL_OPTIONS["claude-code"]` hardcode with
      `getProviderMeta(provider).runningSessionModels`, updated all 3 call sites
      (`canMutateMode`, `canMutateModel`, `shouldShowTakeControl`) to pass capability
      flags from `getProviderCapabilities(provider)`
- [x] Update `SessionTimelineScreen.tsx`: threaded `provider` through
      `SessionTimelineBody` into `ComposerControls` (the same prop Phase 2 already added
      for `SessionActionsMenu`)
- [x] Added 3 new `ComposerControls.test.tsx` cases: mode selector interactive for
      codex, take-control absent for codex, model selector absent for codex
- [x] `pnpm --filter falcon typecheck && pnpm --filter falcon test` (2152 tests) and
      `pnpm --filter @falcon/web typecheck && pnpm --filter @falcon/web test` (1573 tests)
- [x] **Live-verify**: confirmed the mode chip is now a real interactive dropdown for a
      codex session (not plain text) — **and this surfaced a genuine, previously
      unreachable bug**: switching modes failed with a JSON-RPC "Invalid params" error.
      Root cause: `acpRemote.ts`'s doc comment claiming "ACP session-mode ids are
      literally the four wire `PermissionMode` strings" is true for `claude-code` but
      **false for `codex`** — the installed `codex-acp` package's real mode ids are
      `read-only`/`agent`/`agent-full-access` (verified by reading its own `_AgentMode`
      class), nothing like the wire strings. This was never caught before because the
      mode selector was never reachable for codex until this fix. Added
      `CODEX_MODE_ID_BY_PERMISSION_MODE` + `providerModeId()` to `acpRemote.ts` to map
      wire modes to codex's real ids (`default`/`acceptEdits`→`agent`, `plan`→
      `read-only`, `bypassPermissions`→`agent-full-access`) before every
      `session/set_mode` call; `claude-code` keeps its existing identity mapping
      unchanged. Re-verified live afterward: all 4 modes (Default/Accept edits/Plan/
      Bypass permissions) switch cleanly with no error, confirmed via the daemon's own
      log showing no further `[session-rpc] handler threw` entries. Also confirmed live:
      no "Take control" button, no model selector — only the read-only "Model unknown"
      chip — for the whole session.

### Phase 7 — §5.5 resume wiring (do not underestimate this one) — ✅ DONE

- [x] **Before writing any code**: read the installed `codex-acp` package's own compiled
      source directly (`adapters/node_modules/@agentclientprotocol/codex-acp/dist/
      index.js`) — confirmed `agentCapabilities: { ..., loadSession: true, ... }` in its
      `initialize()` response, AND that its `loadSession()` implementation genuinely
      calls `streamThreadHistory(sessionId, thread)` (real conversation replay, not just
      a directory re-attach). Fix is viable.
- [x] Implemented the `acpRemote.ts` startup-sequence change (§5.5 Part B) — branches on
      `opts.resume && connection.supportsSessionLoad()`, calls `connection.loadSession(
      opts.resume, opts.workingDirectory)` and reports `opts.resume` itself as the
      provider session id (`session/load` loads an existing id, it doesn't mint a new
      one — confirmed against the ACP SDK's own `LoadSessionResponse` schema, which
      carries no `sessionId` field), falls back to `createSession` on failure. Added
      `loadSession`/`supportsSessionLoad` to the `AcpRemoteConnection` seam interface.
- [x] Added `packages/cli/src/session/continueFromFlag.ts` (`extractContinueFromFlag()`,
      matching `modelFlag.ts`'s existing space/`=`-separated, last-occurrence-wins
      convention) + its test file; wired into `startCodex.ts`'s
      `startAcpRemote({ resume: ... })` call
- [x] **Found and fixed a second, blocking gap while implementing this**: `startCodex.ts`
      never wired `onProviderSessionId` at all — the real ACP session id was never
      captured or persisted anywhere, so nothing could ever discover what id to pass to
      a future `--continue-from` in the first place. Added
      `notifyDaemonProviderSessionId()`, mirroring `start.ts`'s existing identical
      pattern for Claude, re-reporting session metadata with the real
      `providerSessionId` once known.
- [x] Updated `startCodex.test.ts`: `--continue-from xyz` → `startAcpRemote` receives
      `resume: "xyz"` (and `resume: null` when absent); the provider-session-id
      re-notify fires with the right id once `onProviderSessionId` fires
- [x] Updated `acpRemote.test.ts`: added `loadSession`/`supportsSessionLoad` to
      `FakeConnection`, 3 new tests (resumes via `session/load` when supported + resume
      id given; falls back to `session/new` when `loadSession` throws; goes straight to
      `session/new` when no resume id was given even if supported)
- [x] **Real E2E resume check, live** (not just unit-tested): started a fresh `falcon
      codex` session, told it a secret code ("PINEAPPLE-7284") via the web composer,
      confirmed the ACK, grabbed the real ACP provider session id from the CLI's debug
      log (`FALCON_DEBUG=1`), killed the CLI process outright, restarted `falcon codex
      --continue-from <that-id>` (a genuinely new Falcon session row, empty transcript
      of its own), then asked it "what was the secret code?" — it answered
      **"PINEAPPLE-7284"** correctly. Definitive proof the underlying Codex conversation
      was actually resumed, not just a directory re-attach.
- [x] `PROVIDER_CAPABILITIES.codex.supportsResume` flipped to `true` (verified-true, not
      hoped-for) — updated its test in `providers.test.ts`
- [x] `pnpm --filter falcon typecheck && pnpm --filter falcon test` (2167 tests) and
      `pnpm --filter @falcon/wire build/test`, `pnpm --filter @falcon/web typecheck`,
      `pnpm --filter @falcon/server typecheck` all clean

### Phase 8 — §5.6 plan/todo rendering (biggest, do last) — ✅ DONE

- [x] Read the installed `codex-acp` package's own compiled source directly instead of
      guessing field names — found the real shape: `updatePlan(event)` emits
      `{sessionUpdate: "plan", entries: [{status, content, priority}]}`, matching ACP's
      stable `zPlan` schema. (The experimental, ID-addressed `plan_update`/
      `plan_removed` extension the plan grouped alongside it is a separate, still-
      unstable ACP feature nothing installed actually emits — left dropped.)
- [x] Added the `plan` variant to `SessionEventSchema` (`{t:"plan", steps:[{text,
      status}]}`) in `packages/wire/src/session.ts`
- [x] Added schema tests in `session.test.ts` (accepts empty/populated steps, rejects
      missing `steps` and an unrecognized status value)
- [x] Implemented the `"plan"` case in `acpToEnvelope.ts` (`handlePlan()` +
      `pickPlanSteps()`), replacing the drop branch; skips malformed entries
      defensively instead of dropping the whole update; requires an open turn, same as
      text chunks
- [x] Added 5 tests to `acpToEnvelope.test.ts`: maps entries to steps scoped to the
      open turn; a later update fully replaces the steps (not a diff); skips
      malformed/unrecognized entries without dropping the update; tolerates a missing/
      malformed `entries` field as an empty plan; drops with no active turn
- [x] Added `PlanItem` to `packages/web/src/sync/reducer/types.ts` and its `RenderItem`
      union; re-exported from `reducer/index.ts` (was initially missing from the
      barrel — caught by typecheck)
- [x] Added `case "plan":` to `reduce.ts`; added 2 tests to `reduce.test.ts` (maps
      straight through; a later envelope's item fully replaces the earlier one's steps)
- [x] **Found a second gap while wiring the renderer**: `TimelineRow.tsx` (where
      `plan`'s compile-time exhaustiveness check lives) turned out to be dead code —
      grepped for every call site and found zero; the real transcript renderer is
      `RenderItemGroups.tsx`, which has its own separate, narrower
      `MessageGroupItem`/`StandaloneGroupItem` categorization that `plan` also had to
      be added to (as a `StandaloneGroupItem`, same category as `service`/
      `subagent-group` — a status snapshot, not conversational prose), or the checklist
      would never actually reach the browser despite `TimelineRow` "handling" it.
      (Confirmed, in passing: `usage`/`UsageChip` has the exact same problem already —
      pre-existing, out of scope for this phase, not touched.)
- [x] Created `packages/web/src/components/timeline/PlanChecklist.tsx` (reuses the
      checkbox/strikethrough visual pattern already established by Claude's own
      `TodoCard.tsx`, for visual consistency) and wired it into both `TimelineRow.tsx`
      (the dead-but-still-typechecked path) and `RenderItemGroups.tsx` (the real one)
- [x] Added tests: `TimelineRow.test.ts` (dispatch), `RenderItemGroups.test.ts` (groups
      a `plan` item standalone between messages; actually renders step text into HTML
      via `renderToStaticMarkup`)
- [x] `pnpm --filter @falcon/wire build && pnpm --filter falcon typecheck && pnpm --filter falcon test`
      (2173 tests) and `pnpm --filter @falcon/web typecheck && pnpm --filter @falcon/web test`
      (1578 tests) all clean (one unrelated, pre-existing timing-based flaky test in
      `transcriptIndexer.test.ts` observed once under heavy parallel load, confirmed
      passing reliably in isolation and on a clean full-suite retry — unrelated
      subsystem, not touched)
- [x] **Live-verify**: gave a real Codex session a 4-step task with an explicit
      instruction to use its plan tool — the plan checklist rendered as its own card,
      updating live through multiple snapshots (steps in progress → later steps in
      progress with earlier ones struck through → all 4 struck through/completed),
      exactly the feature the original live-testing session found silently absent
- [x] Skipped: Claude's own ACP remote path already renders todos via its existing
      `TodoCard`/todo-tool path (different, pre-existing wire event), so there was no
      gap to close there — not applicable, not a deferral

### Cross-cutting / final

- [x] Drift-guard already in place, no new test needed: `PROVIDER_CAPABILITIES`,
      `PROVIDER_REGISTRY` (CLI), and `PROVIDER_META` (web) are each typed as
      `Record<ProviderId, ...>`, so TypeScript's excess/missing-property checking on
      that literal assignment already forces exact key parity with `PROVIDER_IDS` in
      both directions at compile time; each package additionally has its own runtime
      "has an entry for every `PROVIDER_IDS` member" test
      (`wire/providers.test.ts`, `cli/provider/registry.test.ts`,
      `web/lib/providers.test.ts`). No package imports both `cli` and `web`, so a
      single cross-package assertion isn't possible/meaningful; per-package coverage
      against the shared `PROVIDER_IDS` source of truth is the correct shape here.
- [x] Full monorepo `pnpm build && pnpm typecheck && pnpm test && pnpm lint` clean pass —
      build/typecheck clean on the first try. `pnpm lint` (biome) found 9 real errors:
      6 in files touched this session (formatting in `acpToEnvelope.test.ts`,
      `registerSessionWorkspace.test.ts`, `ComposerControls.test.tsx`; `useImportType` in
      `startCodex.ts`; a `noArrayIndexKey` in the new `PlanChecklist.tsx`) and 3 pre-
      existing, unrelated to this diff (`credentialsLock.ts`, `resolveAccessToken.ts`,
      `tokenProvider.test.ts`) — fixed all 9 (8 auto-fixed via `biome check --write`, the
      `noArrayIndexKey` fixed with an explicit ignore comment matching the precedent
      already established in `RenderItemGroups.tsx` for the same shape of problem: a
      wholesale-replaced, never-reordered list with no other stable id). Re-ran
      build/typecheck/test/lint after the fixes — all clean. `pnpm test` itself was flaky
      under this run's heavy parallel load (a different unrelated pre-existing test file
      failed on 3 separate full-suite attempts — `bootstrap.integration.test.ts`,
      `pin.test.ts`, `sessionRegistry.test.ts`, `transcriptIndexer.test.ts`,
      `controlServer.test.ts`, none touched this session), each confirmed passing in
      isolation; a `turbo run test --concurrency=1` pass came back fully clean across
      every package (5438 tests total) — resource contention, not a regression.
- [x] Re-ran the live E2E checklist's four ⚠ items against the final state (workspaceId,
      mode switching, plan/todo rendering, resume) — all four confirmed fixed during their
      respective phases (1, 6, 8, 7) with real live evidence already captured in each
      phase's own notes above; updated `docs/codex-e2e-test-checklist.md`'s ⚠ sections and
      its provider-comparison table to record the resolution and evidence trail rather
      than deleting the history.
- [x] Updated `docs/known-issues.md`: removed issue #6's index row and section entirely
      (its own convention: remove once resolved-and-verified, not marked "Fixed" and kept).
      Reviewed every other open entry (#1, #11, #12, #13-#19) — none reference codex
      workspaceId, mode-switching, resume, or plan/todo rendering (#11/#12 are Claude's
      PTY-injection mechanism, an unrelated code path from the ACP capability-gating this
      work used for codex) — no other entries needed reconciling.
