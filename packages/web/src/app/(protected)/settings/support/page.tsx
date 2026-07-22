"use client";

import { MailIcon, MessageCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DISCORD_INVITE_URL, SUPPORT_EMAIL } from "@/lib/config";

/**
 * Settings → Support (docs/competitive-notes-omnara.md #23): two static, always-on
 * affordances — join the Discord community, or email support directly. Mirrors
 * `AppearanceSettingsPage`'s shape (thin "use client" component, no server round-trip);
 * unlike the notifications page's fallback channels, there's no linking/subscribe flow
 * here, just external links, so no state at all.
 */
export default function SupportSettingsPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-8 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Get help, report a bug, or just say hi.
        </p>
      </div>

      <section className="flex w-full flex-col gap-3 text-left">
        <div>
          <h2 className="text-lg font-medium">Community</h2>
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

      <section className="flex w-full flex-col gap-3 text-left">
        <div>
          <h2 className="text-lg font-medium">Direct support</h2>
          <p className="mt-1 text-sm text-muted-foreground">Prefer email? We read every message.</p>
        </div>
        <Button asChild variant="outline">
          <a href={`mailto:${SUPPORT_EMAIL}`}>
            <MailIcon data-icon="inline-start" />
            {SUPPORT_EMAIL}
          </a>
        </Button>
      </section>
    </main>
  );
}
