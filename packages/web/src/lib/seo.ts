import type { Metadata } from "next";
import { SITE_URL, THEME_COLOR } from "./config";

export const LANDING_DESCRIPTION =
  "Claude Code, Codex, and more, running on your own machine. Approve permissions, steer mid-session, and review diffs from any browser, end-to-end encrypted.";

export const LANDING_TITLE = "Kvy · Run coding agents from anywhere";

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
    applicationName: "Kvy",
    description: LANDING_DESCRIPTION,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: "Kvy",
      statusBarStyle: "black-translucent",
    },
    formatDetection: { telephone: false },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/favicon-196.png", sizes: "196x196", type: "image/png" },
        { url: "/manifest-icon-192.maskable.png", sizes: "192x192", type: "image/png" },
        { url: "/manifest-icon-512.maskable.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-icon-180.png", sizes: "180x180", type: "image/png" }],
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
      siteName: "Kvy",
      locale: "en_US",
      type: "website",
      images: [
        {
          url: "/og.jpg",
          width: 1200,
          height: 630,
          alt: "Kvy",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: LANDING_TITLE,
      description: LANDING_DESCRIPTION,
      images: ["/og.jpg"],
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
    name: "Kvy",
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
