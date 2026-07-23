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
import {
  CODEX_EFFORT_OPTIONS,
  type CodexEffort,
  getCodexEffort,
  setCodexEffort,
} from "@/lib/codex-effort";

/**
 * Settings → Agent: default settings for how agents run, independent of
 * which session you start. Moved verbatim out of the deleted
 * `app/(protected)/settings/agent/page.tsx` route when the settings catalog
 * became the dialog (`components/settings-dialog.tsx`) — only the page
 * chrome (`<main>` wrapper + h1) was dropped; every behavior below is
 * unchanged:
 *
 * - "Default provider" / "Default model" (docs/competitive-notes-omnara.md
 *   #15): a second, more prominent surface onto the same
 *   `features/new-session/favorites.ts` store the wizard's inline star
 *   buttons write to. Per-device localStorage convenience, never
 *   authoritative, safe to lose — same reasoning as
 *   `favorites.ts`/`use-theme.ts` (design principle #3).
 *
 *   Model dropdowns intentionally reuse `model-meta.ts`'s curated
 *   `MODEL_OPTIONS` only (no free-text "Custom…" escape hatch like the
 *   wizard's own Options step has).
 *
 * - "Codex effort" (docs/competitive-notes-omnara.md #14): a persisted
 *   global default for Codex's reasoning effort level, independent of any
 *   per-session model choice.
 */
export function AgentSection() {
  // Lazy `useState` initializers — `getFavoriteProvider`/`getFavoriteModel`
  // are guarded for SSR/build-time prerendering (`favorites.ts`'s
  // `hasLocalStorage`), returning `null` there rather than throwing.
  const [provider, setProviderState] = useState<NewSessionProvider>(
    () => getFavoriteProvider() ?? INITIAL_FORM.provider,
  );
  const [claudeModel, setClaudeModelState] = useState<string>(
    () => getFavoriteModel("claude-code") ?? INITIAL_FORM.model,
  );
  const [codexModel, setCodexModelState] = useState<string>(
    () => getFavoriteModel("codex") ?? INITIAL_FORM.model,
  );
  const [effort, setEffortState] = useState<CodexEffort>(() => getCodexEffort());

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

  function handleEffortChange(value: string) {
    const next = value as CodexEffort;
    setCodexEffort(next);
    setEffortState(next);
  }

  const modelByProvider: Record<NewSessionProvider, string> = {
    "claude-code": claudeModel,
    codex: codexModel,
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Default settings for how agents run, independent of which session you start.
      </p>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Default provider</h3>
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

      <section className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">Default model</h3>
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

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">Codex effort</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            How much reasoning effort Codex sessions default to. Applies regardless of which model
            you pick when starting a session.
          </p>
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="codex-effort">
          Effort
          <Select value={effort} onValueChange={handleEffortChange}>
            <SelectTrigger id="codex-effort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODEX_EFFORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </section>
    </div>
  );
}
