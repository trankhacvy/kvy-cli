import { PROVIDER_IDS } from "@kvy/wire";
import { DEFAULT_MODEL_VALUE, type ModelOption, PROVIDER_META } from "@/lib/providers";
import type { NewSessionProvider } from "./types";

export type { ModelOption };
export { DEFAULT_MODEL_VALUE };
export const CUSTOM_MODEL_VALUE = "__custom__";

export const MODEL_OPTIONS: Record<NewSessionProvider, ModelOption[]> = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, PROVIDER_META[id].spawnModels]),
) as Record<NewSessionProvider, ModelOption[]>;

export function isCuratedModel(provider: NewSessionProvider, model: string): boolean {
  if (model === "") return true;
  return MODEL_OPTIONS[provider].some((option) => option.value === model);
}

export function curatedModelSelectValue(model: string): string {
  return model === "" ? DEFAULT_MODEL_VALUE : model;
}
