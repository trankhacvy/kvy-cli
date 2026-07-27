import type { Metadata } from "next";
import { LandingScreen } from "@/features/landing/landing-screen";
import { landingMetadata, softwareApplicationJsonLd } from "@/lib/seo";

export const metadata: Metadata = landingMetadata();

export default function LandingPage() {
  const jsonLd = softwareApplicationJsonLd();
  return (
    <>
      <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      <LandingScreen />
    </>
  );
}
