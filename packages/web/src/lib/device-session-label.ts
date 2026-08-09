const CLIENT_KIND_LABELS: Record<string, string> = {
  web: "Web browser",
  "cli-daemon": "CLI daemon",
  "cli-session": "CLI session",
  "cloud-sandbox": "Cloud sandbox",
};

export function clientKindLabel(clientKind: string): string {
  return CLIENT_KIND_LABELS[clientKind] ?? clientKind;
}

export interface LabeledDeviceSession {
  label: string | null;
  clientKind: string;
}

export function deviceSessionLabel(session: LabeledDeviceSession): string {
  return session.label ?? clientKindLabel(session.clientKind);
}
