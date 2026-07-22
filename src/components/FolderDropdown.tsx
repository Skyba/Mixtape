import { useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { INBOX } from "../types";

type Props = {
  value: string;
  options: string[];
  onChange: (folder: string) => void;
};

export default function FolderDropdown({ value, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const list = Array.from(new Set([INBOX, ...options]));

  function choose(v: string) {
    onChange(v);
    setOpen(false);
  }
  function addNew() {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    choose(v);
  }

  return (
    <View style={styles.box}>
      <Text style={styles.label}>Folder</Text>
      <TouchableOpacity style={styles.field} onPress={() => setOpen(true)}>
        <Text style={styles.fieldTxt}>{value || INBOX}</Text>
        <Text style={styles.caret}>▾</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <View style={styles.sheet}>
            <ScrollView style={{ maxHeight: 260 }}>
              {list.map((f) => (
                <TouchableOpacity
                  key={f}
                  style={styles.item}
                  onPress={() => choose(f)}
                >
                  <Text
                    style={[
                      styles.itemTxt,
                      f === value && styles.itemTxtActive,
                    ]}
                  >
                    {f === value ? `● ${f}` : f}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.addRow}>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="New folder…"
                placeholderTextColor="#6b7280"
                onSubmitEditing={addNew}
              />
              <TouchableOpacity style={styles.addBtn} onPress={addNew}>
                <Text style={styles.addTxt}>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 18 },
  label: {
    color: "#9aa0a6",
    fontSize: 13,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
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
  itemTxtActive: { color: "#3b82f6", fontWeight: "700" },
  addRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    backgroundColor: "#0f1115",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  addBtn: {
    backgroundColor: "#23262d",
    paddingHorizontal: 18,
    justifyContent: "center",
    borderRadius: 10,
  },
  addTxt: { color: "#fff", fontWeight: "600" },
});
