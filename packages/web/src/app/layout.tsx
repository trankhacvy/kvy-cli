import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";

import { DocumentTitle } from "@/components/DocumentTitle";
import { THEME_COLOR } from "@/lib/config";
import { rootMetadata } from "@/lib/seo";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { cn } from "@/lib/utils";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-display" });

const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = rootMetadata();

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const themeInitScript = `(function(){try{
    var v=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var prefersLight=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches;
    if(v==="light"||(v==="system"&&prefersLight)){document.documentElement.classList.remove("dark")}
  })();`;

  return (
    <html
      lang="en"
      className={cn(
        DEFAULT_THEME === "dark" ? "dark" : undefined,
        "font-sans",
        inter.variable,
        spaceGrotesk.variable,
        jetbrainsMono.variable,
      )}
      suppressHydrationWarning
    >
      <head>
        <script suppressHydrationWarning>{themeInitScript}</script>
        <meta name="apple-mobile-web-app-title" content="kvy" />
      </head>
      <body className="antialiased">
        <DocumentTitle />
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
