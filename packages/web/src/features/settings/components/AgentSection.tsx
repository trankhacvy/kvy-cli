"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { PROVIDER_OPTIONS, shouldShowBetaBanner } from "@/features/new-session/provider-meta";
import type { NewSessionProvider } from "@/features/new-session/types";
import { INITIAL_FORM } from "@/features/new-session/wizard-state";
import { AgentIcon } from "@/features/session-list/components/agent-icon";
import {
  CODEX_EFFORT_OPTIONS,
  type CodexEffort,
  getCodexEffort,
  setCodexEffort,
} from "@/lib/codex-effort";

/**
 * Settings → Agent: default settings for how agents run, independent of
 * which session you start. Provider picker is a tab list whose active tab
 * IS the default provider (same `features/new-session/favorites.ts` store
 * the wizard's star buttons write to) — each tab's pane scopes the model
 * picker (and Codex's effort control) to that provider. Per-device
 * localStorage convenience, never authoritative, safe to lose — same
 * reasoning as `favorites.ts`/`use-theme.ts` (design principle #3). Model
 * dropdowns intentionally reuse `model-meta.ts`'s curated `MODEL_OPTIONS`
 * only (no free-text "Custom…" escape hatch like the wizard's own Options
 * step has).
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

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Default provider</h3>
        <Tabs
          value={provider}
          onValueChange={(value) => selectProvider(value as NewSessionProvider)}
          className="flex flex-col gap-4"
        >
          <TabsList className="grid w-full grid-cols-2">
            {PROVIDER_OPTIONS.map(([value, meta]) => (
              <TabsTrigger key={value} value={value} className="gap-2">
                <AgentIcon provider={value} />
                {meta.label}
                {meta.beta ? " (beta)" : ""}
              </TabsTrigger>
            ))}
          </TabsList>

          {PROVIDER_OPTIONS.map(([value, meta]) => (
            <TabsContent key={value} value={value} className="flex flex-col gap-6">
              {shouldShowBetaBanner(meta) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <Badge variant="warning">Beta</Badge>
                  <p className="text-muted-foreground">{meta.betaNote}</p>
                </div>
              )}

              <section className="flex flex-col gap-3">
                <label
                  className="flex flex-col gap-1.5 text-sm font-medium"
                  htmlFor={`agent-default-model-${value}`}
                >
                  Default model
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
                <p className="text-xs text-muted-foreground">
                  The model {meta.label} sessions start with by default.
                </p>
              </section>

              {value === "codex" && (
                <section className="flex flex-col gap-3">
                  <div>
                    <h3 className="text-sm font-medium">Codex effort</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      How much reasoning effort Codex sessions default to. Applies regardless of
                      which model you pick when starting a session.
                    </p>
                  </div>

                  <label
                    className="flex flex-col gap-1.5 text-sm font-medium"
                    htmlFor="codex-effort"
                  >
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
              )}
            </TabsContent>
          ))}
        </Tabs>
      </section>
    </div>
  );
}
