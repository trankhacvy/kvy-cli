import type { PushChannelName } from "@kvy/wire";
import type { PushChannel } from "../types.js";
import { ntfyChannel } from "./ntfy.js";
import { telegramChannel } from "./telegram.js";
import { webpushChannel } from "./webpush.js";

export const channels: Record<PushChannelName, PushChannel> = {
  webpush: webpushChannel,
  telegram: telegramChannel,
  ntfy: ntfyChannel,
};
