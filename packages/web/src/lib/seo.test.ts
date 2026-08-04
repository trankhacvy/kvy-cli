import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  LANDING_TITLE,
  landingMetadata,
  rootMetadata,
  softwareApplicationJsonLd,
} from "./seo";

describe("seo helpers", () => {
  it("builds absolute urls from SITE_URL", () => {
    expect(absoluteUrl("/")).toMatch(/\/$/);
    expect(absoluteUrl("privacy/")).toContain("/privacy/");
  });

  it("root metadata points at the web manifest and icons", () => {
    const meta = rootMetadata();
    expect(meta.manifest).toBe("/manifest.webmanifest");
    expect(meta.applicationName).toBe("Kvy");
    expect(meta.appleWebApp).toMatchObject({ capable: true, title: "Kvy" });
  });

  it("landing metadata is indexable with open graph", () => {
    const meta = landingMetadata();
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.openGraph?.title).toBe(LANDING_TITLE);
    expect(meta.openGraph?.images).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: "/og.jpg" })]),
    );
    expect(meta.alternates?.canonical).toBe("/");
  });

  it("emits SoftwareApplication JSON-LD", () => {
    const json = softwareApplicationJsonLd();
    expect(json["@type"]).toBe("SoftwareApplication");
    expect(json.name).toBe("Kvy");
  });
});
