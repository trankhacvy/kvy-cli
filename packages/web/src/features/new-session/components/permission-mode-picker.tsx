"use client";

import type { PermissionMode } from "@kvy/wire";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Permission-mode picker — extracted out of the old wizard's `OptionsStep`
 * (B2). Carries B6's one required fix from the redesign spec: `
 * bypassPermissions` ("allow all") used to sit as a plain, undifferentiated
 * dropdown row identical in weight to the other three modes, even though it
 * is qualitatively different — every tool call is auto-approved, no
 * per-action confirmation. This reuses the exact amber "needs attention"
 * treatment already established elsewhere in this codebase (the Codex-beta
 * banner in `provider-picker.tsx`, `options-step.tsx`'s in-use-branch
 * warnings) rather than inventing a new visual language: the option row
 * itself gets an amber warning icon + amber text, and selecting it surfaces
 * a persistent amber banner underneath, mirroring `shouldShowBetaBanner`'s
 * banner shape one-for-one.
 */
const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default (ask each time)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan (read-only)" },
  { value: "bypassPermissions", label: "Bypass permissions (allow all)" },
];

const BYPASS_PERMISSIONS: PermissionMode = "bypassPermissions";

export function PermissionModePicker({
  value,
  onChange,
  id = "new-session-permission-mode",
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={id}>
        Permission mode
        <Select value={value} onValueChange={(v) => onChange(v as PermissionMode)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_MODE_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                className={cn(
                  option.value === BYPASS_PERMISSIONS && "text-amber-600 dark:text-amber-400",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {option.value === BYPASS_PERMISSIONS && (
                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {option.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {value === BYPASS_PERMISSIONS && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <Badge variant="warning">Needs attention</Badge>
          <p className="text-muted-foreground">
            Every tool call is auto-approved: nothing pauses for your confirmation, including edits
            and shell commands.
          </p>
        </div>
      )}
    </div>
  );
}
