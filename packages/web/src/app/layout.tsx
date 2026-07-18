import type { Metadata, Viewport } from "next";

import { DocumentTitle } from "@/components/DocumentTitle";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";
import { Providers } from "./providers";

// `title` is deliberately *not* set here — `<DocumentTitle />` below is the
// app's one and only `<title>` element (see its own docstring for why: a
// second, statically-rendered `<title>` from `metadata` would silently win
// over any per-screen dynamic title, per the HTML spec's "first `<title>`
// in tree order" rule for `document.title`).
export const metadata: Metadata = {
  description: "Falcon — end-to-end encrypted mission control for coding agents.",
  manifest: "/manifest.webmanifest",
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

export const viewport: Viewport = {
  themeColor: "hsl(222.2 84% 4.9%)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Dark is Falcon's default theme (design §9 stack table), so the static
  // export always prerenders `.dark` on `<html>` — there's no per-visitor
  // personalization at build time anyway. The inline script below is the
  // pre-hydration anti-flash step (next-themes' own pattern): it runs
  // synchronously, before first paint, and removes `.dark` if this browser
  // previously chose light (`src/app/settings/appearance`, backed by
  // `use-theme.ts`'s store — plan-v2.md W4.2). `suppressHydrationWarning`
  // covers the resulting server/client class mismatch on `<html>` itself.
  //
  // Plain string children (not `dangerouslySetInnerHTML`) — this app's one
  // firm rule (see `lib/markdown.ts`/`lib/unifiedDiff.ts`) is that untrusted
  // content never reaches innerHTML; a `<script>` tag's string children
  // become its literal text content instead, which is all a `<script>`
  // needs, so that rule never has to bend for this either.
  const themeInitScript = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE_KEY,
  )});if(v==="light"){document.documentElement.classList.remove("dark")}}catch(e){}})();`;

  return (
    <html
      lang="en"
      className={DEFAULT_THEME === "dark" ? "dark" : undefined}
      suppressHydrationWarning
    >
      <head>
        <script suppressHydrationWarning>{themeInitScript}</script>
      </head>
      <body className="antialiased">
        <DocumentTitle />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
