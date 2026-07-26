import { Features } from "./components/features";
import { FinalCta } from "./components/final-cta";
import { Hero } from "./components/hero";
import { LandingFooter } from "./components/landing-footer";
import { LandingNav } from "./components/landing-nav";
import { Pricing } from "./components/pricing";
import { Stats } from "./components/stats";

/**
 * The public landing page (`/`), structured after the Briefberry skeleton —
 * bare nav → centered hero with product moment → stats strip → feature bento
 * → two-tier pricing → closing CTA → minimal footer — rendered entirely in
 * Falcon's own shadcn tokens. Public by construction: no auth gate, no sync
 * engine, no crypto bridge; the only client-side islands are `Reveal`
 * (motion) and `CopyCommand` (clipboard).
 */
export function LandingScreen() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <LandingNav />
      <main className="flex-1">
        <Hero />
        <Stats />
        <Features />
        <Pricing />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
