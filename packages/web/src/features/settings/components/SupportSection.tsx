"use client";

import { MailIcon, MessageCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DISCORD_INVITE_URL, SUPPORT_EMAIL } from "@/lib/config";

/**
 * Settings → Support (docs/competitive-notes-omnara.md #23): two static,
 * always-on affordances — join the Discord community, or email support
 * directly. Moved verbatim out of the deleted
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
          <h3 className="text-sm font-medium">Community</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Join the Falcon Discord to chat with other users and the team.
          </p>
        </div>
        <Button asChild variant="outline">
          <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
            <MessageCircleIcon data-icon="inline-start" />
            Join Discord
          </a>
        </Button>
      </section>

      <section className="flex flex-col items-start gap-3">
        <div>
          <h3 className="text-sm font-medium">Direct support</h3>
          <p className="mt-1 text-sm text-muted-foreground">Prefer email? We read every message.</p>
        </div>
        <Button asChild variant="outline">
          <a href={`mailto:${SUPPORT_EMAIL}`}>
            <MailIcon data-icon="inline-start" />
            {SUPPORT_EMAIL}
          </a>
        </Button>
      </section>
    </div>
  );
}
