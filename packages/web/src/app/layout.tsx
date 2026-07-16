import type { Metadata, Viewport } from "next";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Falcon",
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
