import { PROVIDER_IDS } from "@kvy/wire";
import type { NewSessionProvider } from "./types";

/**
 * Starred defaults for the New Session pickers (docs/competitive-notes-omnara.md
 * #22 "Favorite/star a default machine, provider, and model"): at most one
 * starred machine, one starred provider, and one starred model per provider
 * (a starred model only makes sense within the provider it belongs to —
 * "sonnet" isn't a valid `--model` for Codex, same reasoning `model-meta.ts`'s
 * `MODEL_OPTIONS` is keyed by provider for). `localStorage` is the right
 * store here, same reasoning as `features/session-control/last-seen.ts`:
 * purely a per-device "pre-select this next time" convenience that seeds
 * `new-session-screen.tsx`'s initial form — never authoritative, safe to
 * lose (design principle #3). Guarded for SSR/build time the same way
 * `last-seen.ts`/`lib/session.ts` are — Next prerenders these routes at
 * build time (static export), where `window` doesn't exist.
 *
 * Also the backing store for Settings → Agent (docs/competitive-notes-omnara.md
 * #15 "Global default provider + default model per provider") —
 * `features/settings/components/AgentSection.tsx` (in the settings dialog)
 * is a second, more discoverable surface onto these same getters/setters,
 * so a star set from either place is honored by the other.
 */

const MACHINE_KEY = "kvy:new-session-favorite-machine";
const PROVIDER_KEY = "kvy:new-session-favorite-provider";
const MODEL_KEY_PREFIX = "kvy:new-session-favorite-model:";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** `null` means "no starred machine yet". */
export function getFavoriteMachineId(): string | null {
  if (!hasLocalStorage()) return null;
  return window.localStorage.getItem(MACHINE_KEY);
}

/** Stars `machineId` as the default machine, or clears the star when passed `null`. */
export function setFavoriteMachineId(machineId: string | null): void {
  if (!hasLocalStorage()) return;
  if (machineId === null) {
    window.localStorage.removeItem(MACHINE_KEY);
    return;
  }
  window.localStorage.setItem(MACHINE_KEY, machineId);
}

function isNewSessionProvider(value: string | null): value is NewSessionProvider {
  return value !== null && PROVIDER_IDS.includes(value as NewSessionProvider);
}

/** `null` means "no starred provider yet" — `new-session-screen.tsx` falls back to `INITIAL_FORM.provider`. */
export function getFavoriteProvider(): NewSessionProvider | null {
  if (!hasLocalStorage()) return null;
  const raw = window.localStorage.getItem(PROVIDER_KEY);
  return isNewSessionProvider(raw) ? raw : null;
}

/** Stars `provider` as the default provider, or clears the star when passed `null`. */
export function setFavoriteProvider(provider: NewSessionProvider | null): void {
  if (!hasLocalStorage()) return;
  if (provider === null) {
    window.localStorage.removeItem(PROVIDER_KEY);
    return;
  }
  window.localStorage.setItem(PROVIDER_KEY, provider);
}

/**
 * `null` means "no starred model for this provider yet"; `""` is itself a
 * valid starred value meaning "Provider default" was starred (the same
 * `""`-means-default convention `NewSessionForm.model`/`wizard-state.ts`'s
 * `buildSpawnRequest` already use) — so callers must check for `null`
 * specifically, not falsiness, before falling back to `INITIAL_FORM.model`.
 */
export function getFavoriteModel(provider: NewSessionProvider): string | null {
  if (!hasLocalStorage()) return null;
  return window.localStorage.getItem(MODEL_KEY_PREFIX + provider);
}

/** Stars `model` (the form's real value — `""` for "Provider default") as `provider`'s default model, or clears the star when passed `null`. */
export function setFavoriteModel(provider: NewSessionProvider, model: string | null): void {
  if (!hasLocalStorage()) return;
  const key = MODEL_KEY_PREFIX + provider;
  if (model === null) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, model);
}

/**
 * Layers this device's starred provider/model on top of `defaults`
 * (`wizard-state.ts`'s `INITIAL_FORM`) — what `new-session-screen.tsx`
 * actually seeds the wizard's form with. The starred model only applies
 * once resolved against the (possibly-starred) provider itself — a starred
 * Codex model should never leak in as Claude Code's initial model just
 * because Claude Code happens to be `defaults.provider`.
 */
export function applyFavoriteDefaults(defaults: { provider: NewSessionProvider; model: string }): {
  provider: NewSessionProvider;
  model: string;
} {
  const provider = getFavoriteProvider() ?? defaults.provider;
  const model = getFavoriteModel(provider) ?? defaults.model;
  return { provider, model };
}
