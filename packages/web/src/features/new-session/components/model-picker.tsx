"use client";

import { Star } from "lucide-react";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getFavoriteModel, setFavoriteModel } from "../favorites";
import {
  CUSTOM_MODEL_VALUE,
  curatedModelSelectValue,
  DEFAULT_MODEL_VALUE,
  isCuratedModel,
  MODEL_OPTIONS,
} from "../model-meta";
import type { NewSessionProvider } from "../types";

const INPUT_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Model picker — extracted out of the old wizard's `OptionsStep` (B2).
 * Owns its own "is the free-text custom field open" state internally (see
 * `OptionsStep`'s original doc comment for why that can't be derived from
 * `value` alone: `""` is ambiguous between "provider default" and "an empty
 * custom field the user just opened"). Callers that need this state reset on
 * a provider switch (an empty custom field/curated pick from Claude Code
 * means nothing once the provider becomes Codex) should mount this with
 * `key={provider}` — `new-session-panel.tsx` and the old `OptionsStep` both
 * already reset `model` to `""` in the same `onChange` that flips
 * `provider`, so remounting harmlessly recomputes the same "closed, curated"
 * initial state from that fresh `""`.
 */
export function ModelPicker({
  provider,
  value,
  onChange,
  id = "new-session-model",
}: {
  provider: NewSessionProvider;
  value: string;
  onChange: (model: string) => void;
  id?: string;
}) {
  const modelOptions = MODEL_OPTIONS[provider];
  const [customOpen, setCustomOpen] = useState(() => !isCuratedModel(provider, value));
  const selectValue = customOpen ? CUSTOM_MODEL_VALUE : curatedModelSelectValue(value);

  const [favorite, setFavoriteState] = useState<string | null>(() => getFavoriteModel(provider));

  function toggleFavorite(modelValue: string) {
    const next = favorite === modelValue ? null : modelValue;
    setFavoriteModel(provider, next);
    setFavoriteState(next);
  }

  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={id}>
      Model
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_MODEL_VALUE) {
            setCustomOpen(true);
            onChange("");
            return;
          }
          setCustomOpen(false);
          onChange(v === DEFAULT_MODEL_VALUE ? "" : v);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {modelOptions.map((option) => {
            const formValue = option.value === DEFAULT_MODEL_VALUE ? "" : option.value;
            return (
              <SelectItem
                key={option.value}
                value={option.value}
                endAdornment={
                  <button
                    type="button"
                    title={
                      formValue === favorite
                        ? `Unstar ${option.label}`
                        : `Star ${option.label} as default`
                    }
                    aria-label={
                      formValue === favorite
                        ? `Unstar ${option.label}`
                        : `Star ${option.label} as default`
                    }
                    aria-pressed={formValue === favorite}
                    className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(formValue);
                    }}
                  >
                    <Star
                      className={cn(
                        "size-3.5",
                        formValue === favorite
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground",
                      )}
                    />
                  </button>
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model id"
          className={INPUT_CLASS}
        />
      )}
    </label>
  );
}
