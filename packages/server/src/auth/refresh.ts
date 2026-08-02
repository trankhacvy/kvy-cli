import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deviceSessions } from "../db/schema.js";
import type { Database } from "../db/types.js";
import type { ClientKind } from "./tokens.js";
import { mintAccessToken } from "./tokens.js";

// daily-active daemon still re-runs `kvy auth login` every 60 days. Recorded in
// docs/encryption.md.
export const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IssueSessionParams {
  accountId: string;
  clientKind: ClientKind;
  label?: string;
  machineId?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/**
 * Mint a brand-new `device_sessions` row (its own rotation family) plus the access token
 * through this one function so a device session is always created the same way.
 */
export async function issueSession(
  db: Database,
  params: IssueSessionParams,
): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();

  const rows = await db
    .insert(deviceSessions)
    .values({
      accountId: params.accountId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      familyId: randomUUID(),
      clientKind: params.clientKind,
      label: params.label,
      machineId: params.machineId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    })
    .returning({ id: deviceSessions.id });

  const row = rows[0];
  if (!row) throw new Error("issueSession: insert returned no row");

  const accessToken = await mintAccessToken({
    accountId: params.accountId,
    sessionId: row.id,
    clientKind: params.clientKind,
  });

  return { accessToken, refreshToken, sessionId: row.id };
}
