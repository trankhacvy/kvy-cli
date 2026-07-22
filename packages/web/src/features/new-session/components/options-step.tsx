"use client";

import type { PermissionMode } from "@falcon/wire";
import { RefreshCw, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/features/session-list";
import { cn } from "@/lib/utils";
import { generateBranchName } from "../auto-branch";
import {
  getFavoriteModel,
  getFavoriteProvider,
  setFavoriteModel,
  setFavoriteProvider,
} from "../favorites";
import {
  CUSTOM_MODEL_VALUE,
  curatedModelSelectValue,
  DEFAULT_MODEL_VALUE,
  isCuratedModel,
  MODEL_OPTIONS,
} from "../model-meta";
import { PROVIDER_META, PROVIDER_OPTIONS, shouldShowBetaBanner } from "../provider-meta";
import type { BranchItem, NewSessionProvider } from "../types";
import type { BranchMode, NewSessionForm } from "../wizard-state";

const INPUT_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Star toggle rendered inline inside a `<SelectItem>` (docs/competitive-notes-omnara.md
 * #22 "Favorite/star a default machine, provider, and model") — a plain
 * `<button>`, not the `Button` component, kept minimal since it nests inside
 * Radix's `Select.Item` (a `role="option"` `<div>` that selects on
 * `pointerup`/`click`). Stopping propagation on both is required: Radix
 * fires `handleSelect` from `onPointerUp` for mouse input and from
 * `onClick` for touch/keyboard (`@radix-ui/react-select`'s `SelectItem`) —
 * missing either would let starring a row also select it.
 */
function FavoriteStar({
  favorite,
  label,
  onToggle,
}: {
  favorite: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      title={favorite ? `Unstar ${label}` : `Star ${label} as default`}
      aria-label={favorite ? `Unstar ${label}` : `Star ${label} as default`}
      aria-pressed={favorite}
      className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Star
        className={cn(
          "size-3.5",
          favorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground",
        )}
      />
    </button>
  );
}

const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default (ask each time)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan (read-only)" },
  { value: "bypassPermissions", label: "Bypass permissions (allow all)" },
];

/**
 * Step 3: provider, permission mode, model override, and the branch/worktree
 * choice (docs/features/worktree-isolation.md — Repo root / New branch /
 * Existing branch, falcon-prd.md FR-1.2, P1).
 */
export function OptionsStep({
  form,
  onChange,
  listBranches,
  directory,
}: {
  form: NewSessionForm;
  onChange: (patch: Partial<NewSessionForm>) => void;
  /** Lists local branches at `directory` (the daemon's `git.branches` RPC) — backs the "existing branch" mode's picker. */
  listBranches: (directory: string) => Promise<BranchItem[]>;
  /** The chosen working directory — `listBranches`' target. */
  directory: string;
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

  // Starred provider/model (docs/competitive-notes-omnara.md #22): read once
  // per mount, then updated locally on toggle — mirrors `MachineStep`'s own
  // favorite-state pattern.
  const [favoriteProvider, setFavoriteProviderState] = useState<NewSessionProvider | null>(() =>
    getFavoriteProvider(),
  );
  const [favoriteModel, setFavoriteModelState] = useState<string | null>(() =>
    getFavoriteModel(form.provider),
  );
  // Re-read the starred model whenever the selected provider changes — a
  // starred model is scoped per-provider (see `favorites.ts`), so switching
  // provider must re-resolve against the *new* provider's own star, not
  // carry the old one's over.
  useEffect(() => {
    setFavoriteModelState(getFavoriteModel(form.provider));
  }, [form.provider]);

  function toggleFavoriteProvider(provider: NewSessionProvider) {
    const next = favoriteProvider === provider ? null : provider;
    setFavoriteProvider(next);
    setFavoriteProviderState(next);
  }

  function toggleFavoriteModel(modelValue: string) {
    const next = favoriteModel === modelValue ? null : modelValue;
    setFavoriteModel(form.provider, next);
    setFavoriteModelState(next);
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="new-session-provider">
        Provider
        <Select
          value={form.provider}
          onValueChange={(value) => {
            const nextProvider = value as NewSessionForm["provider"];
            // The curated model list (and any custom string already typed)
            // is provider-specific — carrying it across a provider switch
            // would silently spawn the new provider with the old provider's
            // model id (e.g. "sonnet" passed as Codex's --model). Reset to
            // "provider default" instead of leaving a mismatched value.
            setCustomOpen(false);
            onChange({ provider: nextProvider, model: "" });
          }}
        >
          <SelectTrigger id="new-session-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map(([value, meta]) => (
              <SelectItem
                key={value}
                value={value}
                endAdornment={
                  <FavoriteStar
                    favorite={value === favoriteProvider}
                    label={meta.label}
                    onToggle={() => toggleFavoriteProvider(value)}
                  />
                }
              >
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
            {modelOptions.map((option) => {
              // The favorites store keeps the form's real value (`""` for
              // "Provider default"), same as `form.model` itself — translate
              // the sentinel back before comparing/storing, same as
              // `onValueChange` above does.
              const formValue = option.value === DEFAULT_MODEL_VALUE ? "" : option.value;
              return (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  endAdornment={
                    <FavoriteStar
                      favorite={formValue === favoriteModel}
                      label={option.label}
                      onToggle={() => toggleFavoriteModel(formValue)}
                    />
                  }
                >
                  {option.label}
                </SelectItem>
              );
            })}
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

      <BranchModePanel
        form={form}
        onChange={onChange}
        listBranches={listBranches}
        directory={directory}
      />
    </div>
  );
}

const BRANCH_MODE_OPTIONS: Array<{ value: BranchMode; label: string; description: string }> = [
  {
    value: "repo-root",
    label: "Repo root",
    description: "Work directly in the main checkout.",
  },
  {
    value: "new-branch",
    label: "New branch",
    description: "Recommended: isolated in its own git worktree.",
  },
  {
    value: "existing-branch",
    label: "Existing branch",
    description: "Check out an already-existing branch in a fresh isolated worktree.",
  },
];

/**
 * The 3-way branch/worktree choice (docs/features/worktree-isolation.md
 * Phase 4, docs/competitive-notes-omnara.md #2): Repo root / New branch
 * (worktree recommended, auto-generated name) / Existing branch (always a
 * fresh worktree).
 */
function BranchModePanel({
  form,
  onChange,
  listBranches,
  directory,
}: {
  form: NewSessionForm;
  onChange: (patch: Partial<NewSessionForm>) => void;
  listBranches: (directory: string) => Promise<BranchItem[]>;
  directory: string;
}) {
  function selectMode(mode: BranchMode) {
    // Seed a fresh auto-generated name the first time "new branch" is picked
    // with an empty name — never overwrites a name the user already typed
    // (e.g. switching away and back).
    if (mode === "new-branch" && form.branchName.trim() === "") {
      onChange({ branchMode: mode, branchName: generateBranchName() });
      return;
    }
    // "existing branch" mode always clears `branchName` on entry — unlike
    // "new branch", it has no sensible auto-generated value, and critically,
    // a name left over from a *different* mode (e.g. "new branch"'s
    // auto-generated `wf/...` suggestion, or a previously-picked existing
    // branch from an earlier visit to this same mode) is never a real
    // selection from the picker below. Leaving it in place would let
    // `canAdvance`'s bare "non-empty branchName" check pass without the user
    // ever clicking a row, and `buildSpawnRequest` would then silently spawn
    // with `createWorktree: true` on a branch that doesn't exist yet —
    // `gitWorktree.ts`'s `ensureBranchWorkspace` treats "doesn't exist" as
    // "create it", so the daemon would quietly create a brand-new branch
    // instead of checking out an existing one, contradicting this mode's
    // entire purpose. Clearing forces an explicit pick every time.
    if (mode === "existing-branch") {
      onChange({ branchMode: mode, branchName: "" });
      return;
    }
    onChange({ branchMode: mode });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Branch</legend>
        {BRANCH_MODE_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="new-session-branch-mode"
              className="mt-0.5"
              checked={form.branchMode === option.value}
              onChange={() => selectMode(option.value)}
            />
            <span className="flex flex-col">
              <span className="font-medium">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {form.branchMode === "new-branch" && (
        <div className="flex flex-col gap-2 pl-6">
          <div className="flex gap-2">
            <input
              value={form.branchName}
              onChange={(e) => onChange({ branchName: e.target.value })}
              placeholder="branch name"
              className={cn(INPUT_CLASS, "flex-1")}
            />
            <button
              type="button"
              title="Generate a new name"
              aria-label="Generate a new branch name"
              className="flex items-center justify-center rounded-md border border-input px-2 hover:bg-accent"
              onClick={() => onChange({ branchName: generateBranchName() })}
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
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

      {form.branchMode === "existing-branch" && (
        <div className="pl-6">
          <ExistingBranchPicker
            directory={directory}
            listBranches={listBranches}
            selected={form.branchName}
            onSelect={(name) => onChange({ branchName: name })}
          />
        </div>
      )}
    </div>
  );
}

/** The existing-branch mode's picker — lists local branches via `listBranches` on mount, same hand-rolled loading/error/retry pattern as `DirectoryStep`. */
function ExistingBranchPicker({
  directory,
  listBranches,
  selected,
  onSelect,
}: {
  directory: string;
  listBranches: (directory: string) => Promise<BranchItem[]>;
  selected: string;
  onSelect: (name: string) => void;
}) {
  const [branches, setBranches] = useState<BranchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    listBranches(directory)
      .then(setBranches)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only fetch once per mount of this mode/directory pair — `load` itself is redefined every render but isn't part of what should trigger a re-fetch.
  useEffect(() => {
    load();
  }, [directory]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading branches…</p>;
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-destructive">{error}</p>
        <button
          type="button"
          className="self-start text-xs underline text-muted-foreground hover:text-foreground"
          onClick={load}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!branches || branches.length === 0) {
    return <p className="text-sm text-muted-foreground">No local branches found.</p>;
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border">
      {branches.map((branch) => {
        // A branch can only be checked out in one worktree at a time — the
        // current branch is (by definition) already checked out at
        // `directory` itself, and `checkedOutAt` covers every other
        // worktree. Either way, selecting it here would fail at spawn time
        // (`gitWorktree.ts`'s own checked-out-elsewhere guard), so it's
        // disabled up front with an explanatory hint instead.
        const inUseAt = branch.checkedOutAt ?? (branch.isCurrent ? directory : undefined);
        const disabled = inUseAt !== undefined;
        return (
          <button
            key={branch.name}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(branch.name)}
            className={cn(
              "flex flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
              selected === branch.name && !disabled && "bg-accent",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{branch.name}</span>
              {branch.isCurrent && (
                <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                  current
                </Badge>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {disabled
                ? `In use at ${inUseAt}`
                : [
                    branch.upstream,
                    branch.lastCommitAt !== undefined
                      ? formatRelativeTime(branch.lastCommitAt * 1000)
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
          </button>
        );
      })}
    </div>
  );
}
