"use client";

import { decodeBase64 } from "@kvy/crypto/web";
import type { MachineRow, SessionRow } from "@kvy/wire";
import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";

const UNTITLED_SESSION = "(untitled session)";
const UNNAMED_MACHINE = "(unnamed machine)";

/** A session's decrypted title plus its Pin flag — both live in the same
 * encrypted metadata blob, so one `open()` call resolves both at once. */
interface DecryptedSessionMeta {
  title: string;
  pinned: boolean;
}

export interface DecryptedTitles {
  sessions: Map<string, DecryptedSessionMeta>;
  machines: Map<string, string>;
}

const EMPTY_TITLES: DecryptedTitles = { sessions: new Map(), machines: new Map() };

async function decryptSessionMeta(
  bridge: CryptoBridgeClient,
  session: SessionRow,
): Promise<DecryptedSessionMeta> {
  try {
    const ok = await bridge.setSessionKey(decodeBase64(session.dek));
    if (!ok) return { title: UNTITLED_SESSION, pinned: false };
    const opened = await bridge.open<{ title?: unknown; pinned?: unknown }>(session.metadata.value);
    const title =
      opened && typeof opened.title === "string" && opened.title.length > 0
        ? opened.title
        : UNTITLED_SESSION;
    const pinned = opened?.pinned === true;
    return { title, pinned };
  } catch (err) {
    console.error(`use-decrypted-titles: failed to decrypt session ${session.id}'s metadata`, err);
    return { title: UNTITLED_SESSION, pinned: false };
  }
}

async function decryptMachineName(
  bridge: CryptoBridgeClient,
  machine: MachineRow,
): Promise<string> {
  try {
    const ok = await bridge.setSessionKey(decodeBase64(machine.dek));
    if (!ok) return UNNAMED_MACHINE;
    const opened = await bridge.open<{ host?: unknown }>(machine.metadata.value);
    if (opened && typeof opened.host === "string" && opened.host.length > 0) {
      return opened.host;
    }
    return UNNAMED_MACHINE;
  } catch (err) {
    console.error(`use-decrypted-titles: failed to decrypt machine ${machine.id}'s metadata`, err);
    return UNNAMED_MACHINE;
  }
}

/**
 * Decrypts every session/machine title in `sessions`/`machines`, re-running
 * only for rows this hook hasn't already decrypted at their current
 * `metadata.version` (a version bump — e.g. a title rename — is the only
 * thing that invalidates a cached title; unrelated row changes like a status
 * flip reuse the cached value instead of re-hitting the crypto worker on
 * every sync-engine patch).
 */
export function useDecryptedTitles(
  sessions: SessionRow[],
  machines: MachineRow[],
  bridge: CryptoBridgeClient | null,
): DecryptedTitles {
  const [titles, setTitles] = useState<DecryptedTitles>(EMPTY_TITLES);
  const [versions] = useState(() => new Map<string, number>());

  useEffect(() => {
    if (!bridge) return;
    const sessionsToDecrypt = sessions.filter(
      (s) => versions.get(`s:${s.id}`) !== s.metadata.version,
    );
    const machinesToDecrypt = machines.filter(
      (m) => versions.get(`m:${m.id}`) !== m.metadata.version,
    );
    if (sessionsToDecrypt.length === 0 && machinesToDecrypt.length === 0) return;

    let cancelled = false;
    (async () => {
      const nextSessionTitles = new Map<string, DecryptedSessionMeta>();
      for (const session of sessionsToDecrypt) {
        if (cancelled) return;
        nextSessionTitles.set(session.id, await decryptSessionMeta(bridge, session));
        versions.set(`s:${session.id}`, session.metadata.version);
      }
      const nextMachineNames = new Map<string, string>();
      for (const machine of machinesToDecrypt) {
        if (cancelled) return;
        nextMachineNames.set(machine.id, await decryptMachineName(bridge, machine));
        versions.set(`m:${machine.id}`, machine.metadata.version);
      }
      if (cancelled) return;
      setTitles((prev) => ({
        sessions: new Map([...prev.sessions, ...nextSessionTitles]),
        machines: new Map([...prev.machines, ...nextMachineNames]),
      }));
    })();

    return () => {
      cancelled = true;
    };
    // `versions` is a stable Map ref (useState initializer) used as a mutable
    // cache — listing it satisfies useExhaustiveDependencies and never
    // triggers a re-run, since the reference itself never changes.
  }, [bridge, sessions, machines, versions]);

  return titles;
}
