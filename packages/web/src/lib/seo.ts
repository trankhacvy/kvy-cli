import type { Metadata } from "next";
import { SITE_URL, THEME_COLOR } from "./config";

export const LANDING_DESCRIPTION =
  "Run coding agents on your machine. Approve permissions, steer mid-session, and review diffs from any browser — end-to-end encrypted.";

export const LANDING_TITLE = "Falcon — Remote control for Claude Code & Codex";

export const NO_INDEX_ROBOTS = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: {
    index: false,
    follow: false,
    noimageindex: true,
  },
} as const satisfies Metadata["robots"];

export function absoluteUrl(pathname = "/"): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${SITE_URL}${path}`;
}

export function rootMetadata(): Metadata {
  return {
    metadataBase: new URL(`${SITE_URL}/`),
    applicationName: "Falcon",
    description: LANDING_DESCRIPTION,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: "Falcon",
      statusBarStyle: "black-translucent",
    },
    formatDetection: { telephone: false },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icon.svg", type: "image/svg+xml" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
  };
}

export function landingMetadata(): Metadata {
  return {
    description: LANDING_DESCRIPTION,
    alternates: { canonical: "/" },
    openGraph: {
      title: LANDING_TITLE,
      description: LANDING_DESCRIPTION,
      url: "/",
      siteName: "Falcon",
      locale: "en_US",
      type: "website",
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: "Falcon",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: LANDING_TITLE,
      description: LANDING_DESCRIPTION,
      images: ["/og.png"],
    },
    robots: { index: true, follow: true },
    other: {
      "theme-color": THEME_COLOR,
    },
  };
}

export function softwareApplicationJsonLd(): Record<
  string,
  string | string[] | Record<string, string>
> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Falcon",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    description: LANDING_DESCRIPTION,
    url: absoluteUrl("/"),
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}
