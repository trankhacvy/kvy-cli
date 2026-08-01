"use client";

import type { GitBranchInfo } from "@kvy/wire";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CUSTOM_VALUE,
  HEAD_VALUE,
  resolveCustomRefSubmit,
  resolveSelectChange,
  resolveSelectValue,
  WORKSPACE_DEFAULT_VALUE,
} from "../compare-against-select-state";

/**
 * "Compare against" selector (docs/features/git-write-actions.md Phase 5):
 * "Workspace default" (`compareRef: null` — omits `baseRef`, so the
 * daemon's own configured-base-ref fallback applies), "HEAD (uncommitted)",
 * every local branch (`git.branches`, including the current one — comparing
 * against your own branch is legal, e.g. after a rename), or a free-text
 * "Custom…" ref accepting any branch/tag/SHA.
 */
export function CompareAgainstSelect({
  compareRef,
  onChange,
  branches,
}: {
  compareRef: string | null;
  onChange: (ref: string | null) => void;
  branches: GitBranchInfo[];
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  const selectValue = resolveSelectValue(compareRef, customOpen);

  function handleSelect(value: string) {
    const result = resolveSelectChange(value);
    if (result.openCustom) {
      setCustomOpen(true);
      setCustomDraft("");
      return;
    }
    setCustomOpen(false);
    onChange(result.ref);
  }

  function submitCustom() {
    const ref = resolveCustomRefSubmit(customDraft);
    if (ref === null) return;
    onChange(ref);
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Compare against</span>
      <Select value={selectValue} onValueChange={handleSelect}>
        <SelectTrigger size="sm" className="h-7 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WORKSPACE_DEFAULT_VALUE}>Workspace default</SelectItem>
          <SelectItem value={HEAD_VALUE}>HEAD (uncommitted)</SelectItem>
          {branches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name}>
              {branch.name}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_VALUE}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {customOpen && (
        <Input
          autoFocus
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCustom();
          }}
          onBlur={submitCustom}
          placeholder="branch, tag, or SHA"
          className="h-7 w-36 text-xs"
        />
      )}
    </div>
  );
}
