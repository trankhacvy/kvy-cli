import type { NewSessionProvider } from "./types";

/**
 * Curated `--model` picker (plan-v2.md W4.2 "Model selector: replace the
 * free-text spawn field with a curated list + 'custom…' escape hatch"). The
 * options step still ends up writing a plain string into `NewSessionForm.model`
 * (`""` meaning "use the provider's default", same contract
 * `buildSpawnRequest` already has) — this only changes how that string gets
 * picked, from a bare `<input>` to a `Select` with the common aliases each
 * CLI accepts, falling back to a free-text field for anything else.
 *
 * Deliberately short-name aliases (`sonnet`/`opus`/`haiku`,
 * `gpt-5.1-codex`/`gpt-5.1`) rather than dated model-id strings — those are
 * what `claude`/`codex`'s own `--model` flag resolves against, so a curated
 * value here is never stale in the way a pinned dated id would eventually be.
 */
export interface ModelOption {
  value: string;
  label: string;
}

/** Sentinel `<Select>` values — Radix's `Select.Item` rejects an empty-string
 * `value` outright, so neither "provider default" nor "none of the curated
 * options" can use `""` the way `NewSessionForm.model` itself does. Both
 * sentinels are translated back to/from the form's real `""`-means-default
 * string at the `OptionsStep` call site; `MODEL_OPTIONS`' `value`s otherwise
 * match the model id string the form (and ultimately `--model`) carries
 * verbatim. */
export const DEFAULT_MODEL_VALUE = "__default__";
export const CUSTOM_MODEL_VALUE = "__custom__";

const DEFAULT_MODEL_OPTION: ModelOption = { value: DEFAULT_MODEL_VALUE, label: "Provider default" };

export const MODEL_OPTIONS: Record<NewSessionProvider, ModelOption[]> = {
  "claude-code": [
    DEFAULT_MODEL_OPTION,
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
    // 1M-context variants (docs/competitive-notes-omnara.md #13): distinct
    // curated picks, not a checkbox modifier on the base model — same
    // "resolves against the CLI's own --model flag" contract as every other
    // option here. `claude`'s `--model` accepts the base alias with a
    // `[1m]` suffix to opt into the long-context beta (1M-token window)
    // for that model; Haiku has no 1M variant, so it's intentionally
    // excluded. Codex has no announced 1M-context tier, so `codex` below
    // stays as-is.
    { value: "sonnet[1m]", label: "Sonnet (1M)" },
    { value: "opus[1m]", label: "Opus (1M)" },
  ],
  codex: [
    DEFAULT_MODEL_OPTION,
    { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
  ],
};

/** Whether `model` (the form's real value — `""` for "provider default") is
 * one of `provider`'s curated options, i.e. representable by the `<Select>`
 * without falling back to the free-text escape hatch. `OptionsStep` uses
 * this only to seed its own "is the custom field open" state (an empty
 * custom field and "provider default" are both `""` in `NewSessionForm`, so
 * which of the two is meant can't be recovered from the string alone once
 * the user is mid-edit — see that component's doc comment). */
export function isCuratedModel(provider: NewSessionProvider, model: string): boolean {
  if (model === "") return true;
  return MODEL_OPTIONS[provider].some((option) => option.value === model);
}

/** The `<Select>`'s own `value` for a curated (non-custom) selection —
 * `DEFAULT_MODEL_VALUE` for `""`, the model string itself otherwise. Only
 * meaningful while `OptionsStep`'s own "custom field open" state is `false`;
 * see `isCuratedModel`'s doc comment for why that state can't be derived
 * from `model` alone. */
export function curatedModelSelectValue(model: string): string {
  return model === "" ? DEFAULT_MODEL_VALUE : model;
}
