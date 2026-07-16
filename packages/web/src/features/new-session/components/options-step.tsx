"use client";

import type { PermissionMode } from "@falcon/wire";
import type { NewSessionForm } from "../wizard-state";

const SELECT_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const INPUT_CLASS = SELECT_CLASS;

/** Step 3: provider, permission mode, model override, and the optional `-b <branch>` / worktree option (falcon-prd.md FR-1.2, P1). */
export function OptionsStep({
  form,
  onChange,
}: {
  form: NewSessionForm;
  onChange: (patch: Partial<NewSessionForm>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Provider
        <select
          value={form.provider}
          onChange={(e) => onChange({ provider: e.target.value as NewSessionForm["provider"] })}
          className={SELECT_CLASS}
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex (beta)</option>
        </select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Permission mode
        <select
          value={form.permissionMode}
          onChange={(e) => onChange({ permissionMode: e.target.value as PermissionMode })}
          className={SELECT_CLASS}
        >
          <option value="default">Default (ask each time)</option>
          <option value="acceptEdits">Accept edits</option>
          <option value="plan">Plan (read-only)</option>
          <option value="bypassPermissions">Bypass permissions (allow all)</option>
        </select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Model <span className="font-normal text-muted-foreground">(optional)</span>
        <input
          value={form.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="provider default"
          className={INPUT_CLASS}
        />
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
