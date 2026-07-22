import { useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export type Option = { label: string; value: string };

export default function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <View>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)}>
        <Text style={styles.fieldTxt}>{current?.label ?? value}</Text>
        <Text style={styles.caret}>▾</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <View style={styles.sheet}>
            {options.map((o) => (
              <TouchableOpacity
                key={o.value}
                style={styles.item}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <Text
                  style={[
                    styles.itemTxt,
                    o.value === value && styles.itemActive,
                  ]}
                >
                  {o.value === value ? `● ${o.label}` : o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    backgroundColor: "#1a1d23",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  fieldTxt: { color: "#fff", fontSize: 15 },
  caret: { color: "#9aa0a6", fontSize: 14 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 28,
  },
  sheet: { backgroundColor: "#1a1d23", borderRadius: 16, padding: 12 },
  item: { paddingVertical: 14, paddingHorizontal: 10 },
  itemTxt: { color: "#cdd1d6", fontSize: 15 },
  itemActive: { color: "#3b82f6", fontWeight: "700" },
});
