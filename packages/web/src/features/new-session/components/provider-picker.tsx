"use client";

import { Star } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getFavoriteProvider, setFavoriteProvider } from "../favorites";
import { PROVIDER_META, PROVIDER_OPTIONS, shouldShowBetaBanner } from "../provider-meta";
import type { NewSessionProvider } from "../types";

/**
 * Provider picker (`claude-code`/`codex`) — extracted out of the old New
 * Session wizard's `OptionsStep` (B2, new-session-from-web redesign) so it's
 * reusable by both that step (while it still existed) and the new
 * workspace-row inline creation panel, without re-forking the favorite-star
 * wiring or the Codex-beta banner treatment. Self-contained: reads/writes
 * its own starred-provider state (`favorites.ts`) rather than taking it as a
 * prop, since starring a provider has nothing to do with whichever form is
 * currently hosting this picker.
 */
export function ProviderPicker({
  value,
  onChange,
  id = "new-session-provider",
}: {
  value: NewSessionProvider;
  onChange: (provider: NewSessionProvider) => void;
  id?: string;
}) {
  const selectedMeta = PROVIDER_META[value];
  const [favorite, setFavoriteState] = useState<NewSessionProvider | null>(() =>
    getFavoriteProvider(),
  );

  function toggleFavorite(provider: NewSessionProvider) {
    const next = favorite === provider ? null : provider;
    setFavoriteProvider(next);
    setFavoriteState(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={id}>
        Provider
        <Select value={value} onValueChange={(v) => onChange(v as NewSessionProvider)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map(([optionValue, meta]) => (
              <SelectItem
                key={optionValue}
                value={optionValue}
                endAdornment={
                  <button
                    type="button"
                    title={
                      optionValue === favorite
                        ? `Unstar ${meta.label}`
                        : `Star ${meta.label} as default`
                    }
                    aria-label={
                      optionValue === favorite
                        ? `Unstar ${meta.label}`
                        : `Star ${meta.label} as default`
                    }
                    aria-pressed={optionValue === favorite}
                    className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(optionValue);
                    }}
                  >
                    <Star
                      className={cn(
                        "size-3.5",
                        optionValue === favorite
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground",
                      )}
                    />
                  </button>
                }
              >
                {meta.label}
                {meta.beta ? " (beta)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {shouldShowBetaBanner(selectedMeta) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <Badge variant="warning">Beta</Badge>
          <p className="text-muted-foreground">{selectedMeta.betaNote}</p>
        </div>
      )}
    </div>
  );
}
