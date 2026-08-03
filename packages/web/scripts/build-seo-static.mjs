import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://kvy-cli.tkvy.dev").replace(
  /\/+$/,
  "",
);

const robots = `User-agent: *
Allow: /
Disallow: /dashboard/
Disallow: /pair/
Disallow: /auth/
Disallow: /password/
Disallow: /reset-keys/
Disallow: /signin/

Sitemap: ${siteUrl}/sitemap.xml
`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${siteUrl}/privacy/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${siteUrl}/terms/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>
`;

writeFileSync(path.join(outDir, "robots.txt"), robots, "utf8");
writeFileSync(path.join(outDir, "sitemap.xml"), sitemap, "utf8");
// Keep public/ copies in sync for next dev (static files served as-is).
writeFileSync(path.join(root, "public", "robots.txt"), robots, "utf8");
writeFileSync(path.join(root, "public", "sitemap.xml"), sitemap, "utf8");
console.log(`build-seo-static: wrote robots.txt + sitemap.xml for ${siteUrl}`);
