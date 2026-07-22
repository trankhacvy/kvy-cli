"use client";

import type { PermissionMode } from "@falcon/wire";
import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
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
import type { NewSessionProvider } from "../types";
import type { NewSessionForm } from "../wizard-state";

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
