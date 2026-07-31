import { PROVIDER_IDS } from "@falcon/wire";
import { PROVIDER_META as WEB_PROVIDER_META, type WebProviderMeta } from "@/lib/providers";
import type { NewSessionProvider } from "./types";

export type ProviderMeta = Pick<WebProviderMeta, "label" | "beta" | "betaNote">;

export const PROVIDER_META: Record<NewSessionProvider, ProviderMeta> = WEB_PROVIDER_META;

export const PROVIDER_OPTIONS: Array<[NewSessionProvider, ProviderMeta]> = PROVIDER_IDS.map(
  (id) => [id, PROVIDER_META[id]],
);

export function shouldShowBetaBanner(meta: ProviderMeta): boolean {
  return meta.beta && Boolean(meta.betaNote);
}
