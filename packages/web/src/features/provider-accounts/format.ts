import type { ProviderUsageMeter } from "@kvy/wire";

/**
 * Display formatting for Settings → Providers (docs/competitive-notes-omnara.md
 * #9). Pure functions, unit-tested directly — no jsdom/React-rendering
 * harness exists in this package's vitest config (plain `node` environment,
 * `*.test.ts` only), same precedent `features/new-session/provider-meta.ts`'s
 * `shouldShowBetaBanner` doc comment gives for keeping formatting logic
 * extracted from JSX.
 */

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Aug 18, 11:29 AM" — the exact shape docs/competitive-notes-omnara.md's #9 example uses ("100% used · Resets Aug 18, 11:29 AM"), reused for both a usage meter's reset date and the account card's "last refreshed" timestamp. */
export function formatDateTime(ms: number): string {
  return DATE_TIME_FORMATTER.format(new Date(ms));
}

/** "93% used · Resets Jul 20, 6:00 PM" — the usage-meter row's own label; falls back to an honest "resets unknown" instead of throwing on an unparseable `resetsAt` (the local CLI cache is trusted but not schema-guaranteed to always carry a valid ISO string). */
export function formatUsageMeterLabel(meter: ProviderUsageMeter): string {
  const resetsAtMs = Date.parse(meter.resetsAt);
  const resetsLabel = Number.isNaN(resetsAtMs)
    ? "resets unknown"
    : `Resets ${formatDateTime(resetsAtMs)}`;
  return `${Math.round(meter.percentUsed)}% used · ${resetsLabel}`;
}

/** "Last refreshed Jul 22, 3:14 PM" / the honest "Last refreshed time unknown" when the local config carried no timestamp at all (rather than silently omitting the row). */
export function formatLastRefreshed(ms: number | undefined): string {
  if (ms === undefined) return "Last refreshed time unknown";
  return `Last refreshed ${formatDateTime(ms)}`;
}

const AUTH_TYPE_LABELS: Record<string, string> = {
  oauth: "OAuth",
  "api-key": "API key",
  chatgpt: "ChatGPT sign-in",
  apikey: "API key",
};

/** Humanizes the wire's raw `authType` string (whatever the local CLI's own config happens to record) — falls back to title-casing an unrecognized value rather than an ALL_CAPS/snake_case raw dump, and to "Unknown" when the field is absent. */
export function formatAuthType(authType: string | undefined): string {
  if (!authType) return "Unknown";
  return AUTH_TYPE_LABELS[authType] ?? titleCase(authType);
}

const BILLING_TYPE_LABELS: Record<string, string> = {
  stripe_subscription: "Stripe Subscription",
  free: "Free",
};

/** Humanizes the wire's raw `billingType` string — same fallback shape as `formatAuthType`. `undefined` reads as "no billing info available" rather than a fabricated default, distinct from a resolved-but-unknown value. */
export function formatBillingType(billingType: string | undefined): string | null {
  if (!billingType) return null;
  return BILLING_TYPE_LABELS[billingType] ?? titleCase(billingType);
}

/** "stripe_subscription" / "some-kebab-value" → "Stripe Subscription" / "Some Kebab Value" — the shared fallback both label maps above use for a raw value this module doesn't have an explicit human label for yet. */
function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
