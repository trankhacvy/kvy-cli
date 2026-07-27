import type { Metadata } from "next";
import Link from "next/link";
import { SUPPORT_EMAIL } from "@/lib/config";

export const metadata: Metadata = {
  description: "Terms of use for the Falcon web app and related services.",
  alternates: { canonical: "/terms/" },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <p className="text-muted-foreground text-sm">
          <Link href="/" className="hover:text-foreground">
            Falcon
          </Link>
          <span aria-hidden="true"> · </span>
          Terms
        </p>
        <h1 className="mt-3 font-semibold text-3xl tracking-tight">Terms of use</h1>
        <p className="mt-2 text-muted-foreground text-sm">Last updated: July 27, 2026</p>

        <div className="mt-10 space-y-6 text-sm leading-relaxed text-foreground/90">
          <section className="space-y-2">
            <h2 className="font-medium text-base">Service</h2>
            <p>
              Falcon provides software to coordinate coding agents running on machines you control.
              You are responsible for the agents you run, the code they touch, and the credentials
              those machines hold.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Accounts</h2>
            <p>
              You must keep your sign-in methods secure and only approve pairing or key-sharing
              requests you recognize. You may not abuse the service, probe other accounts, or
              attempt to bypass encryption or access controls.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Availability</h2>
            <p>
              We aim for reliable operation but do not guarantee uninterrupted access. Self-hosted
              deployments depend on your own infrastructure.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Liability</h2>
            <p>
              Falcon is provided as-is. To the fullest extent permitted by law, we are not liable
              for indirect damages, lost profits, or loss of encrypted data when keys are lost.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-base">Contact</h2>
            <p>
              Questions:{" "}
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href={`mailto:${SUPPORT_EMAIL}`}
              >
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
