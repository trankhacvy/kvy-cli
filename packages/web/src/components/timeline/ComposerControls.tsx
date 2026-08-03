"use client";

import type { PermissionMode } from "@kvy/wire";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  PromptInputButton,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { useSessionControl } from "@/features/session-control";
import { PTY_SET_MODE_ENABLED } from "@/lib/config";
import { getProviderCapabilities } from "@/lib/providers";
import { canMutateMode, nextModeAfterSetMode, shouldShowTakeControl } from "./mode-switch-state";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
};

/**
 * The composer footer's left-side session chips (the old
 * ControlBar contents, redistributed into the chat-composer footer à la
 * Cursor/ChatGPT): a read-only model chip, the permission-mode selector,
 * and "Take control" for genuine remote-loop sessions. Interrupt lives on
 * the composer's right side (the stop button); "End session" lives in the
 * header actions menu.
 *
 * Unlike `Composer` itself, this component DOES read
 * `useSessionControl()` (for the `setMode`/`takeControl` mutations), so it
 * must render under `SessionControlProvider` — the caller passes it into
 * `Composer`'s `footerControls` slot from within that context. The mode
 * selector keeps ControlBar's optimistic-selection-then-rollback behavior
 * (`nextModeAfterSetMode`), and the same honesty gates apply: the mutating
 * affordance only appears where the RPC is real (`canMutateMode`), and
 * take-control only for `controlMode === "remote"` (`shouldShowTakeControl`).
 */
export function ComposerControls({
  mode,
  controlMode,
  disabled = false,
  modelChip,
  provider,
}: {
  mode: PermissionMode;
  controlMode: "local" | "remote";
  disabled?: boolean;
  /** Decrypted model id from the session's metadata, or null until known —
   *  the chip is hidden rather than fabricated when there's nothing real to show. */
  modelChip: string | null;
  provider: string;
}) {
  const { actions } = useSessionControl();
  const [selectedMode, setSelectedMode] = useState(mode);
  const [modeError, setModeError] = useState<string | null>(null);
  const capabilities = getProviderCapabilities(provider);

  // The canonical mode can change underneath this component (another device
  // switched it, or a permission answer resolved by mode-switch) — stay in
  // sync whenever it does, rather than freezing on whatever was true at mount.
  useEffect(() => {
    setSelectedMode(mode);
  }, [mode]);

  const takeControlMutation = useMutation({ mutationFn: () => actions.takeControl() });
  const setModeMutation = useMutation({
    mutationFn: (next: PermissionMode) => actions.setMode(next),
  });

  function handleModeChange(next: PermissionMode) {
    const previous = selectedMode;
    setSelectedMode(next);
    setModeError(null);
    setModeMutation.mutate(next, {
      onSuccess: (result) => {
        const outcome = nextModeAfterSetMode(next, previous, result);
        setSelectedMode(outcome.mode);
        setModeError(outcome.error);
      },
      onError: (error) => {
        setSelectedMode(previous);
        setModeError(error instanceof Error ? error.message : "Could not change the mode.");
      },
    });
  }

  // A read-only label, never a mutating control — issue #12's `setModel`
  // (typing `/model` into the live PTY) has real, unfixed correctness bugs
  // (false-positive on a switch Claude Code itself refused, no requested-
  // vs-observed equality check, an unguarded confirm-dialog race), so the
  // web never offers to change the model, for any provider. When the model
  // is unknown AND this provider has no live model-switch capability at all
  // (`!capabilities.supportsLiveModelSwitch`, e.g. Codex), there is no path
  // that will ever resolve "unknown" into a real value later — showing a
  // permanent "Model unknown" chip would read as broken, not pending, so
  // the chip is hidden entirely instead. For a provider that DOES support
  // live switching (Claude Code), "unknown" is transient (resolves once the
  // CLI's own transcript reports a model), so the chip still shows to make
  // that in-flight state visible.
  const showModelChip = modelChip !== null || capabilities.supportsLiveModelSwitch;

  return (
    <>
      {showModelChip && (
        <PromptInputButton size="sm" tooltip="The model this session is running" aria-label="Model">
          <Sparkles className="size-3.5" />
          <span className="text-xs">{modelChip ?? "Model unknown"}</span>
        </PromptInputButton>
      )}
      {canMutateMode(controlMode, capabilities.supportsLiveModeSwitch, PTY_SET_MODE_ENABLED) ? (
        <PromptInputSelect
          value={selectedMode}
          disabled={disabled || setModeMutation.isPending}
          onValueChange={(value) => handleModeChange(value as PermissionMode)}
        >
          <PromptInputSelectTrigger className="h-8 w-auto gap-1 border-none bg-transparent px-2 text-xs shadow-none hover:bg-muted">
            <PromptInputSelectValue />
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            {MODES.map((m) => (
              <PromptInputSelectItem key={m} value={m}>
                {MODE_LABEL[m]}
              </PromptInputSelectItem>
            ))}
          </PromptInputSelectContent>
        </PromptInputSelect>
      ) : (
        <span className="px-2 text-xs text-muted-foreground">{MODE_LABEL[mode]}</span>
      )}
      {shouldShowTakeControl(controlMode, capabilities.supportsTakeControl) && (
        <PromptInputButton
          size="sm"
          disabled={disabled || takeControlMutation.isPending}
          onClick={() => takeControlMutation.mutate()}
          tooltip="Take control of this session from the terminal"
        >
          <span className="text-xs">Take control</span>
        </PromptInputButton>
      )}
      {modeError && <span className="px-1 text-xs text-destructive">{modeError}</span>}
      {takeControlMutation.isError && (
        <span className="px-1 text-xs text-destructive">Could not take control.</span>
      )}
    </>
  );
}
