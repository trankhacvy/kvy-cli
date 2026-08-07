import { Faq } from "./components/faq";
import { Features } from "./components/features";
import { FinalCta } from "./components/final-cta";
import { Hero } from "./components/hero";
import { LandingFooter } from "./components/landing-footer";
import { LandingNav } from "./components/landing-nav";
import { Pillars } from "./components/pillars";

/**
 * The public landing page (`/`), structured after the Briefberry skeleton —
 * nav → centered hero with product moment → worldview pillars →
 * feature rows with dedicated visuals → FAQ → closing CTA → footer —
 * rendered entirely in Kvy's own shadcn tokens. Public by construction: no
 * auth gate, no sync engine, no crypto bridge; the only client-side islands
 * are `Reveal` (motion), `CopyCommand` (clipboard), and `Faq`'s accordion.
 */
export function LandingScreen() {
  return (
    <div className="landing-noise relative flex min-h-dvh flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-primary"
      >
        Skip to content
      </a>
      <LandingNav />
      <main id="main" className="flex-1">
        <Hero />
        <Features />
        <Pillars />
        <Faq />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
