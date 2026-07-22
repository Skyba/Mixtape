declare module "qrcode-generator" {
  interface QR {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: string): QR;
  export default qrcode;
}
