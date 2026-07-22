"use client";

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CODEX_EFFORT_OPTIONS,
  type CodexEffort,
  getCodexEffort,
  setCodexEffort,
} from "@/lib/codex-effort";

/**
 * Settings → Agent (docs/competitive-notes-omnara.md #14 "Codex 'Effort'
 * setting"): a persisted global default for Codex's reasoning effort level,
 * independent of any per-session model choice (`new-session`'s `OptionsStep`
 * picks the model; this is a separate, standing preference set once here).
 * Read once on mount and updated locally on change, same pattern
 * `NotificationSettingsPage`/`AppearanceSettingsPage` already use for their
 * own simple preference toggles.
 */
export default function AgentSettingsPage() {
  const [effort, setEffortState] = useState<CodexEffort>(() => getCodexEffort());

  function handleChange(value: string) {
    const next = value as CodexEffort;
    setCodexEffort(next);
    setEffortState(next);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Default settings for how agents run, independent of which session you start.
        </p>
      </div>

      <section className="flex w-full flex-col gap-3 text-left">
        <div>
          <h2 className="text-lg font-medium">Codex effort</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            How much reasoning effort Codex sessions default to. Applies regardless of which model
            you pick when starting a session.
          </p>
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="codex-effort">
          Effort
          <Select value={effort} onValueChange={handleChange}>
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
    </main>
  );
}
