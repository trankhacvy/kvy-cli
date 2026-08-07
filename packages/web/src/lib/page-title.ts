export const DEFAULT_DOCUMENT_TITLE = "Kvy";

export const LANDING_DOCUMENT_TITLE = "kvy · Run coding agents from anywhere";

export function titleForPath(pathname: string): string {
  const path = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

  switch (path) {
    case "":
    case "/":
      return LANDING_DOCUMENT_TITLE;
    case "/signin":
      return "Sign in · Kvy";
    case "/password":
      return "Email & password · Kvy";
    case "/pair":
      return "Pair device · Kvy";
    case "/reset-keys":
      return "Reset your keys · Kvy";
    case "/privacy":
      return "Privacy · Kvy";
    case "/terms":
      return "Terms · Kvy";
    default:
      return DEFAULT_DOCUMENT_TITLE;
  }
}
