import { useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

type Props = {
  letters: string[]; // distinct AAI speaker letters present, e.g. ["A","B"]
  nameFor: (letter: string) => string;
  options: string[]; // candidate names (history + roster)
  onPick: (letter: string, name: string) => void;
};

export default function SpeakerRemap({
  letters,
  nameFor,
  options,
  onPick,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commit(name: string) {
    if (editing && name.trim()) onPick(editing, name.trim());
    setEditing(null);
    setDraft("");
  }

  return (
    <View>
      {letters.map((l) => (
        <TouchableOpacity
          key={l}
          style={styles.row}
          onPress={() => {
            setDraft("");
            setEditing(l);
          }}
        >
          <View style={styles.letter}>
            <Text style={styles.letterTxt}>{l}</Text>
          </View>
          <Text style={styles.name}>{nameFor(l)}</Text>
          <Text style={styles.edit}>change</Text>
        </TouchableOpacity>
      ))}

      <Modal visible={editing !== null} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              Who is Speaker {editing}?
            </Text>
            <View style={styles.wrap}>
              {options.map((o) => (
                <TouchableOpacity
                  key={o}
                  style={styles.chip}
                  onPress={() => commit(o)}
                >
                  <Text style={styles.chipTxt}>{o}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="or type a name"
              placeholderTextColor="#6b7280"
              onSubmitEditing={() => commit(draft)}
            />
            <View style={styles.sheetRow}>
              <TouchableOpacity
                style={styles.sheetBtn}
                onPress={() => setEditing(null)}
              >
                <Text style={styles.sheetBtnTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetBtn, styles.save]}
                onPress={() => commit(draft)}
              >
                <Text style={styles.sheetBtnTxt}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1d23",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    gap: 12,
  },
  letter: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  letterTxt: { color: "#fff", fontWeight: "700" },
  name: { color: "#fff", fontSize: 15, flex: 1 },
  edit: { color: "#3b82f6", fontSize: 13, fontWeight: "600" },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 28,
  },
  sheet: { backgroundColor: "#1a1d23", borderRadius: 16, padding: 20 },
  sheetTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  chip: {
    backgroundColor: "#23262d",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 18,
  },
  chipTxt: { color: "#fff", fontSize: 14 },
  input: {
    backgroundColor: "#0f1115",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 14,
  },
  sheetRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  sheetBtn: {
    flex: 1,
    backgroundColor: "#23262d",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  save: { backgroundColor: "#3b82f6" },
  sheetBtnTxt: { color: "#fff", fontWeight: "600" },
});
