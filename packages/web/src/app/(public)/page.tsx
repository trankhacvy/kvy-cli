import { LandingScreen } from "@/features/landing/landing-screen";

/**
 * `/` — the public landing page. The app itself (session list, timelines,
 * git panels) lives under `/dashboard/**` behind `(protected)`'s
 * `RequireAuth` boundary; this route renders under the root layout only, so
 * a signed-out visitor gets instant static HTML with no auth flash.
 */
export default function LandingPage() {
  return <LandingScreen />;
}
