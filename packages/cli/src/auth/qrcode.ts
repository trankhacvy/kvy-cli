/**
 * Terminal QR code rendering — port of Happy's `happy-cli/src/ui/qrcode.ts`
 * (kvy-plan.md §2.2: "+ QR via `qrcode-terminal` for the future mobile
 * app"). Used for both the device-pairing URL (`auth/login.ts`) and a
 * session's own web URL (`commands/start.ts`).
 */
import qrcode from "qrcode-terminal";

export function displayQrCode(url: string): void {
  qrcode.generate(url, { small: true }, (qr) => {
    process.stdout.write(`${qr}\n`);
  });
}
