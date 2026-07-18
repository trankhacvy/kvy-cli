"use client";

import type { PermissionMode } from "@falcon/wire";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CUSTOM_MODEL_VALUE,
  curatedModelSelectValue,
  DEFAULT_MODEL_VALUE,
  isCuratedModel,
  MODEL_OPTIONS,
} from "../model-meta";
import { PROVIDER_META, PROVIDER_OPTIONS, shouldShowBetaBanner } from "../provider-meta";
import type { NewSessionForm } from "../wizard-state";

const INPUT_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default (ask each time)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan (read-only)" },
  { value: "bypassPermissions", label: "Bypass permissions (allow all)" },
];

/** Step 3: provider, permission mode, model override, and the optional `-b <branch>` / worktree option (falcon-prd.md FR-1.2, P1). */
export function OptionsStep({
  form,
  onChange,
}: {
  form: NewSessionForm;
  onChange: (patch: Partial<NewSessionForm>) => void;
}) {
  const selectedProviderMeta = PROVIDER_META[form.provider];
  const modelOptions = MODEL_OPTIONS[form.provider];
  // Whether the free-text "Custom…" field is open. Can't be derived from
  // `form.model` alone once it's `""` — that's ambiguous between "provider
  // default" and "an empty custom field the user just opened" — so this is
  // real component state, seeded from the form's initial value the one time
  // it actually is unambiguous (a genuinely-uncurated model string already
  // in the form when this step first mounts, e.g. returning to it from
  // Review).
  const [customOpen, setCustomOpen] = useState(() => !isCuratedModel(form.provider, form.model));
  const modelSelectValue = customOpen ? CUSTOM_MODEL_VALUE : curatedModelSelectValue(form.model);

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="new-session-provider">
        Provider
        <Select
          value={form.provider}
          onValueChange={(value) => onChange({ provider: value as NewSessionForm["provider"] })}
        >
          <SelectTrigger id="new-session-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map(([value, meta]) => (
              <SelectItem key={value} value={value}>
                {meta.label}
                {meta.beta ? " (beta)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {shouldShowBetaBanner(selectedProviderMeta) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <Badge variant="warning">Beta</Badge>
          <p className="text-muted-foreground">{selectedProviderMeta.betaNote}</p>
        </div>
      )}

      <label
        className="flex flex-col gap-1.5 text-sm font-medium"
        htmlFor="new-session-permission-mode"
      >
        Permission mode
        <Select
          value={form.permissionMode}
          onValueChange={(value) => onChange({ permissionMode: value as PermissionMode })}
        >
          <SelectTrigger id="new-session-permission-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="new-session-model">
        Model
        <Select
          value={modelSelectValue}
          onValueChange={(value) => {
            if (value === CUSTOM_MODEL_VALUE) {
              setCustomOpen(true);
              onChange({ model: "" });
              return;
            }
            setCustomOpen(false);
            onChange({ model: value === DEFAULT_MODEL_VALUE ? "" : value });
          }}
        >
          <SelectTrigger id="new-session-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_MODEL_VALUE}>Custom…</SelectItem>
          </SelectContent>
        </Select>
        {customOpen && (
          <input
            value={form.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder="model id"
            className={INPUT_CLASS}
          />
        )}
      </label>

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={form.branchEnabled}
            onChange={(e) => onChange({ branchEnabled: e.target.checked })}
          />
          Start on a new branch
        </label>
        {form.branchEnabled && (
          <div className="flex flex-col gap-2 pl-6">
            <input
              value={form.branchName}
              onChange={(e) => onChange({ branchName: e.target.value })}
              placeholder="branch name"
              className={INPUT_CLASS}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.createWorktree}
                onChange={(e) => onChange({ createWorktree: e.target.checked })}
              />
              Create a git worktree for this branch
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
