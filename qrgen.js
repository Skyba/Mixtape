const QR = require("qrcode");
const url = process.argv[2];
QR.toFile("expo-qr.png", url, { width: 700, margin: 2 })
  .then(() => console.log("OK " + url))
  .catch((e) => {
    console.log("ERR " + e);
    process.exit(1);
  });
