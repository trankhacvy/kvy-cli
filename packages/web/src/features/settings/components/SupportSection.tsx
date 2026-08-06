"use client";

import { AtSignIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FACEBOOK_URL, TWITTER_URL } from "@/lib/config";

/**
 * Settings → Support: two static, always-on affordances — reach out on
 * Facebook or X. Moved verbatim out of the deleted
 * `app/(protected)/settings/support/page.tsx` route — page chrome dropped;
 * unlike the notifications section's fallback channels, there's no
 * linking/subscribe flow here, just external links, so no state at all.
 */
export function SupportSection() {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">Get help, report a bug, or just say hi.</p>

      <section className="flex flex-col items-start gap-3">
        <div>
          <h3 className="text-sm font-medium">Facebook</h3>
          <p className="mt-1 text-sm text-muted-foreground">Message us on Facebook.</p>
        </div>
        <Button asChild variant="outline">
          <a href={FACEBOOK_URL} target="_blank" rel="noopener noreferrer">
            <UsersIcon data-icon="inline-start" />
            Facebook
          </a>
        </Button>
      </section>

      <section className="flex flex-col items-start gap-3">
        <div>
          <h3 className="text-sm font-medium">X (Twitter)</h3>
          <p className="mt-1 text-sm text-muted-foreground">Message us on X.</p>
        </div>
        <Button asChild variant="outline">
          <a href={TWITTER_URL} target="_blank" rel="noopener noreferrer">
            <AtSignIcon data-icon="inline-start" />X
          </a>
        </Button>
      </section>
    </div>
  );
}
