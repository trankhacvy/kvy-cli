export const DEFAULT_DOCUMENT_TITLE = "Falcon";

export const LANDING_DOCUMENT_TITLE = "Falcon — Remote control for Claude Code & Codex";

export function titleForPath(pathname: string): string {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

  switch (path) {
    case "":
    case "/":
      return LANDING_DOCUMENT_TITLE;
    case "/signin":
      return "Sign in · Falcon";
    case "/password":
      return "Email & password · Falcon";
    case "/pair":
      return "Pair device · Falcon";
    case "/reset-keys":
      return "Reset your keys · Falcon";
    case "/privacy":
      return "Privacy · Falcon";
    case "/terms":
      return "Terms · Falcon";
    default:
      return DEFAULT_DOCUMENT_TITLE;
  }
}
