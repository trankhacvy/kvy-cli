import { createEnvelope, type SessionEnvelope } from "@kvy/wire";

export function announceRemoteControl(): SessionEnvelope {
  return createEnvelope("agent", { t: "mode-switch", control: "remote", by: "client" });
}
