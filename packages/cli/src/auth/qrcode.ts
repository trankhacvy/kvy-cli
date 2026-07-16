/**
 * Terminal QR code rendering for the pairing URL — port of Happy's
 * `happy-cli/src/ui/qrcode.ts` (falcon-plan.md §2.2: "+ QR via
 * `qrcode-terminal` for the future mobile app").
 */
import qrcode from "qrcode-terminal";

export function displayPairingQrCode(url: string): void {
  qrcode.generate(url, { small: true }, (qr) => {
    process.stdout.write(`${qr}\n`);
  });
}
