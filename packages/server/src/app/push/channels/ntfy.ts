import type { PushChannel } from "../types.js";

/**
 * Falcon-add fallback channel (plan.md §10, falcon-system-design.md §6.4).
 * `endpoint` holds the ntfy.sh (or self-hosted ntfy) topic name the user
 * configured to subscribe to.
 *
 * Stub only — see `telegram.ts` for the shared rationale. `POST
 * /v1/push/subscribe` already accepts `channel: "ntfy"` subscriptions; this
 * is the documented no-op until the ntfy HTTP publish call lands.
 */
export const ntfyChannel: PushChannel = {
  async send(sub) {
    console.error(
      { module: "push", channel: "ntfy" },
      `ntfy channel not yet implemented — dropping notification for subscription ${sub.id}`,
    );
  },
};
