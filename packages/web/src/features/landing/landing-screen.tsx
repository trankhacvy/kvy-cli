import { Faq } from "./components/faq";
import { Features } from "./components/features";
import { FinalCta } from "./components/final-cta";
import { Hero } from "./components/hero";
import { LandingFooter } from "./components/landing-footer";
import { LandingNav } from "./components/landing-nav";
import { Pillars } from "./components/pillars";

/**
 * The public landing page (`/`), structured after the Briefberry skeleton —
 * bare nav → centered hero with product moment → worldview pillars →
 * feature rows with dedicated visuals → FAQ → closing CTA → minimal footer —
 * rendered entirely in Kvy's own shadcn tokens. Public by construction: no
 * auth gate, no sync engine, no crypto bridge; the only client-side islands
 * are `Reveal` (motion), `CopyCommand` (clipboard), and `Faq`'s accordion.
 */
export function LandingScreen() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <LandingNav />
      <main className="flex-1">
        <Hero />
        <Pillars />
        <Features />
        <Faq />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
