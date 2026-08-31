import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ICON_GROUPS } from "../folderIcons";

/**
 * One icon chooser, opened from Settings and from a library row's icon. Grouped
 * rather than a flat wall of emoji, so a folder's icon can be found by what it
 * is about.
 */
export default function IconPicker({
  folder,
  current,
  onPick,
  onClose,
}: {
  folder: string;
  current: string;
  onPick: (icon: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.head}>
            <Text style={styles.title}>
              {current} {folder}
            </Text>
            <TouchableOpacity onPress={() => onPick("")}>
              <Text style={styles.reset}>default</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 420 }}>
            {ICON_GROUPS.map((g) => (
              <View key={g.label}>
                <Text style={styles.group}>{g.label.toUpperCase()}</Text>
                <View style={styles.grid}>
                  {g.icons.map((e) => (
                    <TouchableOpacity
                      key={e}
                      style={[styles.cell, e === current && styles.cellOn]}
                      onPress={() => onPick(e)}
                    >
                      <Text style={styles.glyph}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity style={styles.close} onPress={onClose}>
            <Text style={styles.closeTxt}>Close</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "#000000cc",
    justifyContent: "center",
    padding: 22,
  },
  sheet: { backgroundColor: "#15181d", borderRadius: 16, padding: 16 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  title: { color: "#fff", fontSize: 16, fontWeight: "700" },
  reset: { color: "#7c828a", fontSize: 12 },
  group: {
    color: "#7c828a",
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 1.1,
    marginTop: 12,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  cell: {
    width: 44,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  cellOn: { borderColor: "#2f6fd0", backgroundColor: "#1c2330" },
  glyph: { fontSize: 22 },
  close: {
    marginTop: 14,
    backgroundColor: "#23262d",
    borderRadius: 10,
    padding: 12,
    alignItems: "center",
  },
  closeTxt: { color: "#c9cdd3", fontSize: 14, fontWeight: "700" },
});
