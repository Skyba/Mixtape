import { View } from "react-native";
import qrcode from "qrcode-generator";

// Pure-JS QR rendered as a grid of Views (no native dependency).
export default function QRCode({
  value,
  size = 160,
}: {
  value: string;
  size?: number;
}) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.floor(size / n);

  const rows = [];
  for (let r = 0; r < n; r++) {
    const cells = [];
    for (let c = 0; c < n; c++) {
      cells.push(
        <View
          key={c}
          style={{
            width: cell,
            height: cell,
            backgroundColor: qr.isDark(r, c) ? "#000" : "#fff",
          }}
        />
      );
    }
    rows.push(
      <View key={r} style={{ flexDirection: "row" }}>
        {cells}
      </View>
    );
  }
  return <View style={{ backgroundColor: "#fff", padding: 8 }}>{rows}</View>;
}
