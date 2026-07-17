/**
 * Pure template generation for the launchd plist / systemd `--user` unit
 * `serviceInstall.ts` writes to disk. Kept separate from the filesystem and
 * `launchctl`/`systemctl` process-exec side so these are plain,
 * snapshot-testable string builders with no I/O of their own.
 *
 * Both templates point the service straight at `falcon daemon start-sync`
 * — the daemon's own long-running process body (`daemon/commands.ts`),
 * normally spawned detached-and-polled by `falcon daemon start`. Once the
 * OS is supervising restarts (`KeepAlive`/`Restart=on-failure` below),
 * that detach-and-poll dance is redundant — the service manager *is* the
 * supervisor.
 */
import { SERVICE_LABEL } from "./serviceInstallPaths.js";

export interface ServiceUnitConfig {
  falconExecutable: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  /** Extra environment variables the service process should see, e.g. a non-default `FALCON_HOME_DIR`. */
  env?: Record<string, string>;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLaunchdPlist(config: ServiceUnitConfig): string {
  const envEntries = Object.entries(config.env ?? {});
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(SERVICE_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(config.falconExecutable)}</string>`,
    "    <string>daemon</string>",
    "    <string>start-sync</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(config.stdoutLogPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(config.stderrLogPath)}</string>`,
  ];

  if (envEntries.length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [key, value] of envEntries) {
      lines.push(`    <key>${xmlEscape(key)}</key>`, `    <string>${xmlEscape(value)}</string>`);
    }
    lines.push("  </dict>");
  }

  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

export function buildSystemdUnit(config: ServiceUnitConfig): string {
  const envLines = Object.entries(config.env ?? {}).map(
    ([key, value]) => `Environment=${key}=${value}`,
  );

  return [
    "[Unit]",
    `Description=Falcon daemon (${SERVICE_LABEL})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${config.falconExecutable} daemon start-sync`,
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${config.stdoutLogPath}`,
    `StandardError=append:${config.stderrLogPath}`,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
