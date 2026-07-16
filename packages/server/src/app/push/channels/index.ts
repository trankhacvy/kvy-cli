import type { PushChannelName } from "@falcon/wire";
import type { PushChannel } from "../types.js";
import { ntfyChannel } from "./ntfy.js";
import { telegramChannel } from "./telegram.js";
import { webpushChannel } from "./webpush.js";

/** `pushSubscriptions.channel -> sender` registry (plan.md §10). */
export const channels: Record<PushChannelName, PushChannel> = {
  webpush: webpushChannel,
  telegram: telegramChannel,
  ntfy: ntfyChannel,
};
