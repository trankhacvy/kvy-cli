import type { Metadata, Viewport } from "next";

import { DocumentTitle } from "@/components/DocumentTitle";
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
};

export const viewport: Viewport = {
  themeColor: "hsl(222.2 84% 4.9%)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Dark is Falcon's default theme (design §9 stack table). The `.dark` class
  // is a static default here — an appearance toggle (design §9.2 Settings
  // screen) can flip it later without any other change to this file.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased">
        <DocumentTitle />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
