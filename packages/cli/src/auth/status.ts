// Deliberately makes no network call — only the opaque refresh token is persisted,
// so there's nothing to decode client-side.
import { decodeBase64, deriveKeyTree } from "@kvy/crypto";
import { resolveHomeDir } from "../home.js";
import { credentialsPath, readCredentials } from "./credentials.js";
import { unwrapWithDeviceKey } from "./deviceKey.js";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function describeKeyMaterialMode(mode: "pin" | "device" | "plaintext-fallback"): string {
  switch (mode) {
    case "pin":
      return "PIN-protected";
    case "device":
      return "device-key-protected (OS Keychain)";
    case "plaintext-fallback":
      return "unwrapped (plaintext-fallback)";
  }
}

export function runAuthStatus(): number {
  const credentials = readCredentials();
  if (!credentials) {
    process.stdout.write("Not logged in. Run `kvy auth login` to authenticate.\n");
    return 0;
  }

  process.stdout.write("Logged in.\n");
  process.stdout.write(`  Credentials file: ${credentialsPath()}\n`);
  process.stdout.write(
    `  Key material: ${describeKeyMaterialMode(credentials.keyMaterial.mode)}\n`,
  );

  // `"pin"` mode needs an interactive prompt to unwrap — skipped here so the fingerprint
  // below is best-effort, shown only for modes that unwrap without prompting. A
  // fully-paired account's masterSecret is exactly 32 raw bytes; anything else can't
  // derive a signing identity, so this is best-effort display only.
  const secret =
    credentials.keyMaterial.mode === "plaintext-fallback"
      ? decodeBase64(credentials.keyMaterial.bundle)
      : credentials.keyMaterial.mode === "device"
        ? unwrapWithDeviceKey(credentials.keyMaterial.wrapped, resolveHomeDir())
        : null;
  if (secret && secret.length === 32) {
    const { signing } = deriveKeyTree(secret);
    process.stdout.write(`  Account key: ${toHex(signing.publicKey).slice(0, 16)}…\n`);
  }

  process.stdout.write(
    "  Refresh token: present (60-day absolute lifetime; no local expiry to show)\n",
  );

  return 0;
}
