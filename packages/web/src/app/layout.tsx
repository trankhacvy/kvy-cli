import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";

import { DocumentTitle } from "@/components/DocumentTitle";
import { THEME_COLOR } from "@/lib/config";
import { rootMetadata } from "@/lib/seo";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

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
  const themeInitScript = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE_KEY,
  )});if(v==="light"){document.documentElement.classList.remove("dark")}}catch(e){}})();`;

  return (
    <html
      lang="en"
      className={cn(DEFAULT_THEME === "dark" ? "dark" : undefined, "font-sans", inter.variable)}
      suppressHydrationWarning
    >
      <head>
        <script suppressHydrationWarning>{themeInitScript}</script>
        <meta name="apple-mobile-web-app-title" content="Kvy" />
      </head>
      <body className="antialiased">
        <DocumentTitle />
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
