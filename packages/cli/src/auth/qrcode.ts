import qrcode from "qrcode-terminal";

export function displayQrCode(url: string): void {
  qrcode.generate(url, { small: true }, (qr) => {
    process.stdout.write(`${qr}\n`);
  });
}
