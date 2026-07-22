"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getFavoriteModel,
  getFavoriteProvider,
  setFavoriteModel,
  setFavoriteProvider,
} from "@/features/new-session/favorites";
import {
  curatedModelSelectValue,
  DEFAULT_MODEL_VALUE,
  MODEL_OPTIONS,
} from "@/features/new-session/model-meta";
import { PROVIDER_OPTIONS } from "@/features/new-session/provider-meta";
import type { NewSessionProvider } from "@/features/new-session/types";
import { INITIAL_FORM } from "@/features/new-session/wizard-state";

/**
 * Settings → Agent (docs/competitive-notes-omnara.md #15 "Global default
 * provider + default model per provider"): a dedicated, discoverable place
 * to review/change the same starred provider/model `features/new-session/
 * favorites.ts` already backs the "New session" wizard's inline star
 * buttons with (`options-step.tsx`'s `FavoriteStar`, #22) — this page is
 * just a second, more prominent surface onto the exact same store, so
 * starring a model here or in the wizard stays in sync either way. Same
 * "per-device localStorage convenience, never authoritative, safe to lose"
 * reasoning as `favorites.ts`/`use-theme.ts` (design principle #3) — there's
 * no account-wide settings-sync backend for preferences like this yet, so
 * "persisted account-wide" (the feature note's phrasing) means "same device,
 * same durability as the rest of Settings," not a new server round trip.
 *
 * Model dropdowns intentionally reuse `model-meta.ts`'s curated
 * `MODEL_OPTIONS` only (no free-text "Custom…" escape hatch like the
 * wizard's own Options step has) — `OptionsStep`'s `FavoriteStar` is only
 * ever rendered next to a curated option, so a starred model is always one
 * of `MODEL_OPTIONS[provider]` or `""` ("Provider default"); this page never
 * needs to represent anything else.
 */
export default function AgentSettingsPage() {
  // Lazy `useState` initializers, same pattern as `OptionsStep`'s own
  // favorite-state (`options-step.tsx`) — `getFavoriteProvider`/
  // `getFavoriteModel` are guarded for SSR/build-time prerendering
  // (`favorites.ts`'s `hasLocalStorage`), returning `null` there rather than
  // throwing, so reading them straight from the initializer is safe.
  const [provider, setProviderState] = useState<NewSessionProvider>(
    () => getFavoriteProvider() ?? INITIAL_FORM.provider,
  );
  const [claudeModel, setClaudeModelState] = useState<string>(
    () => getFavoriteModel("claude-code") ?? INITIAL_FORM.model,
  );
  const [codexModel, setCodexModelState] = useState<string>(
    () => getFavoriteModel("codex") ?? INITIAL_FORM.model,
  );

  function selectProvider(next: NewSessionProvider) {
    setFavoriteProvider(next);
    setProviderState(next);
  }

  function selectModel(forProvider: NewSessionProvider, selectValue: string) {
    // Translate the `<Select>`'s sentinel back to the store's real value
    // (`""` for "Provider default") — same translation `OptionsStep` does
    // at its own call site.
    const model = selectValue === DEFAULT_MODEL_VALUE ? "" : selectValue;
    setFavoriteModel(forProvider, model);
    if (forProvider === "claude-code") setClaudeModelState(model);
    else setCodexModelState(model);
  }

  const modelByProvider: Record<NewSessionProvider, string> = {
    "claude-code": claudeModel,
    codex: codexModel,
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which provider "New session" starts with, and which model each provider defaults
          to.
        </p>
      </div>

      <section className="flex w-full flex-col gap-3 text-left">
        <h2 className="text-sm font-medium">Default provider</h2>
        <div className="flex gap-2">
          {PROVIDER_OPTIONS.map(([value, meta]) => (
            <Button
              key={value}
              type="button"
              variant={provider === value ? "default" : "outline"}
              aria-pressed={provider === value}
              onClick={() => selectProvider(value)}
            >
              {meta.label}
              {meta.beta ? " (beta)" : ""}
            </Button>
          ))}
        </div>
      </section>

      <section className="flex w-full flex-col gap-4 text-left">
        <h2 className="text-sm font-medium">Default model</h2>
        {PROVIDER_OPTIONS.map(([value, meta]) => (
          <label
            key={value}
            className="flex flex-col gap-1.5 text-sm font-medium"
            htmlFor={`agent-default-model-${value}`}
          >
            {meta.label}
            <Select
              value={curatedModelSelectValue(modelByProvider[value])}
              onValueChange={(selectValue) => selectModel(value, selectValue)}
            >
              <SelectTrigger id={`agent-default-model-${value}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS[value].map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ))}
      </section>
    </main>
  );
}
