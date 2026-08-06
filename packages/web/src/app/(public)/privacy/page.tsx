import type { Metadata } from "next";
import Link from "next/link";
import { FACEBOOK_URL, TWITTER_URL } from "@/lib/config";

export const metadata: Metadata = {
  description:
    "How Kvy handles account data, end-to-end encryption, and what the server can and cannot see.",
  alternates: { canonical: "/privacy/" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <p className="text-muted-foreground text-sm">
          <Link href="/" className="hover:text-foreground">
            Kvy
          </Link>
          <span aria-hidden="true"> · </span>
          Privacy
        </p>
        <h1 className="mt-3 font-semibold text-3xl tracking-tight">Privacy</h1>
        <p className="mt-2 text-muted-foreground text-sm">Last updated: July 27, 2026</p>

        <div className="mt-10 space-y-6 text-sm leading-relaxed text-foreground/90">
          <section className="space-y-2">
            <h2 className="font-medium text-base">What Kvy is</h2>
            <p>
              Kvy is end-to-end encrypted mission control for coding agents. Session transcripts,
              titles, and related agent content are encrypted on your devices before they reach our
              servers. The server stores ciphertext it cannot read.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Account data</h2>
            <p>
              When you create an account we store the identifiers needed to sign you in (for example
              email address, OAuth subject, hashed password credentials) and device/session metadata
              required for auth, pairing, and push delivery. We do not use your agent transcripts
              for advertising or model training.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Encryption keys</h2>
            <p>
              Encryption keys stay on your devices. New browsers receive keys only after you approve
              a device-to-device or CLI pairing flow. Losing every device that holds your keys means
              encrypted history cannot be recovered; your account identity can still be retained if
              you choose to start a fresh key epoch.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Notifications</h2>
            <p>
              If you enable Web Push or a fallback channel (such as Telegram or ntfy), we store the
              subscription endpoint needed to deliver generic alerts (for example that a session
              needs permission). Notification payloads do not include transcript content.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Self-hosting</h2>
            <p>
              If you run Kvy yourself, this policy describes the hosted product defaults. Your own
              deployment is under your control and your operators&apos; policies.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Contact</h2>
            <p>
              Questions: reach out on{" "}
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href={FACEBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Facebook
              </a>{" "}
              or{" "}
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href={TWITTER_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                X
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
