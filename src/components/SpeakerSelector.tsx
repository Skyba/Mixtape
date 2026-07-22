import { useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { colorForIndex } from "../colors";

type Props = {
  count: number;
  names: (string | null)[];
  history: string[];
  onChange: (count: number, names: (string | null)[]) => void;
};

export default function SpeakerSelector({
  count,
  names,
  history,
  onChange,
}: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  function setCount(next: number) {
    const c = Math.max(0, next);
    const arr = names.slice(0, c);
    while (arr.length < c) arr.push(null);
    onChange(c, arr);
  }

  function openSlot(i: number) {
    setDraft(names[i] ?? "");
    setEditing(i);
  }

  function commit(value: string | null) {
    if (editing === null) return;
    const arr = [...names];
    arr[editing] = value && value.trim() ? value.trim() : null;
    onChange(count, arr);
    setEditing(null);
  }

  function pickHistory(name: string) {
    const slot = names.findIndex((n) => n === null);
    if (slot === -1) return; // no free slot
    const arr = [...names];
    arr[slot] = name;
    onChange(count, arr);
  }

  return (
    <View style={styles.box}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Speakers</Text>
        <View style={styles.stepper}>
          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => setCount(count - 1)}
          >
            <Text style={styles.stepTxt}>−</Text>
          </TouchableOpacity>
          <Text style={styles.stepVal}>{count}</Text>
          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => setCount(count + 1)}
          >
            <Text style={styles.stepTxt}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.wrap}>
        {names.map((n, i) => {
          const named = !!n;
          return (
            <TouchableOpacity
              key={i}
              style={[
                styles.slot,
                named
                  ? [styles.slotNamed, { backgroundColor: colorForIndex(i) }]
                  : styles.slotEmpty,
              ]}
              onPress={() => openSlot(i)}
            >
              <Text style={named ? styles.slotTxtNamed : styles.slotTxtEmpty}>
                {n ?? `Unnamed ${i + 1}`}
              </Text>
            </TouchableOpacity>
          );
        })}
        {count === 0 ? (
          <Text style={styles.hint}>0 speakers — transcription skipped</Text>
        ) : null}
      </View>

      {history.length > 0 && (
        <>
          <Text style={styles.sub}>Recent — tap to fill a slot</Text>
          <View style={styles.wrap}>
            {history.map((h) => {
              const used = names.includes(h);
              return (
                <TouchableOpacity
                  key={h}
                  style={[styles.recent, used && styles.recentUsed]}
                  onPress={() => pickHistory(h)}
                  disabled={used}
                >
                  <Text
                    style={[
                      styles.recentTxt,
                      used && styles.recentTxtUsed,
                    ]}
                  >
                    {used ? `✓ ${h}` : h}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}

      <Modal visible={editing !== null} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              Name speaker {editing !== null ? editing + 1 : ""}
            </Text>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Speaker name"
              placeholderTextColor="#6b7280"
              autoFocus
              onSubmitEditing={() => commit(draft)}
            />
            <View style={styles.sheetRow}>
              <TouchableOpacity
                style={styles.sheetBtn}
                onPress={() => commit(null)}
              >
                <Text style={styles.sheetBtnTxt}>Clear</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sheetBtn}
                onPress={() => setEditing(null)}
              >
                <Text style={styles.sheetBtnTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetBtn, styles.sheetSave]}
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
  box: { marginTop: 18 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    color: "#9aa0a6",
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  stepper: { flexDirection: "row", alignItems: "center" },
  stepBtn: {
    backgroundColor: "#23262d",
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  stepTxt: { color: "#fff", fontSize: 22 },
  stepVal: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
    marginHorizontal: 18,
    minWidth: 22,
    textAlign: "center",
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  slot: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
  },
  slotNamed: { backgroundColor: "#3b82f6", borderColor: "#3b82f6" },
  slotEmpty: {
    backgroundColor: "transparent",
    borderColor: "#3f444d",
    borderStyle: "dashed",
  },
  slotTxtNamed: { color: "#fff", fontWeight: "700" },
  slotTxtEmpty: { color: "#9aa0a6" },
  hint: { color: "#6b7280", fontSize: 12 },
  sub: { color: "#6b7280", fontSize: 12, marginTop: 16 },
  recent: {
    backgroundColor: "#23262d",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
  },
  recentUsed: { backgroundColor: "#16331f" },
  recentTxt: { color: "#cdd1d6", fontSize: 13 },
  recentTxtUsed: { color: "#4ade80", fontWeight: "700" },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 28,
  },
  sheet: { backgroundColor: "#1a1d23", borderRadius: 16, padding: 20 },
  sheetTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  input: {
    backgroundColor: "#0f1115",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 16,
  },
  sheetRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  sheetBtn: {
    flex: 1,
    backgroundColor: "#23262d",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  sheetSave: { backgroundColor: "#3b82f6" },
  sheetBtnTxt: { color: "#fff", fontWeight: "600" },
});
