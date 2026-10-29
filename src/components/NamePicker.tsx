import { useEffect, useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

type Props = {
  visible: boolean;
  title: string;
  /** People already in this recording (or these slots): shown first. */
  here: string[];
  /** Everyone named before, most recent first; only 5 show until you type. */
  history: string[];
  /** Other voices of the same recording this one can be folded into. */
  mergeInto?: { key: string; name: string }[];
  /** Show "Remove name" (the voice or slot has a name now). */
  canRemove?: boolean;
  /** Show "Leave unnamed": you don't know who this is, and that's settled. */
  canLeaveUnnamed?: boolean;
  onLeaveUnnamed?: () => void;
  onPick: (name: string) => void;
  onMerge?: (key: string, name: string) => void;
  onRemove?: () => void;
  onClose: () => void;
};

const RECENT = 5;

/**
 * One picker for every place a person is named: a speaker slot before
 * recording, a voice after transcription. Two taps reach any outcome —
 * a known name, a new one typed in, merging into another voice, removing.
 */
export default function NamePicker(p: Props) {
  const [q, setQ] = useState("");
  useEffect(() => { if (p.visible) setQ(""); }, [p.visible]);
  const typed = q.trim();
  const rest = useMemo(() => {
    const seen = new Set(p.here.map((x) => x.toLowerCase()));
    const pool = p.history.filter((h) => !seen.has(h.toLowerCase()));
    return typed ? pool.filter((h) => h.toLowerCase().includes(typed.toLowerCase())) : pool.slice(0, RECENT);
  }, [p.history, p.here, typed]);
  const exists = [...p.here, ...p.history].some((x) => x.toLowerCase() === typed.toLowerCase());

  return (
    <Modal visible={p.visible} transparent animationType="fade" onRequestClose={p.onClose}>
      <TouchableOpacity style={styles.back} activeOpacity={1} onPress={p.onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet}>
          <Text style={styles.title}>{p.title}</Text>
          <TextInput
            style={styles.input}
            value={q}
            onChangeText={setQ}
            placeholder="Search or type a new name"
            placeholderTextColor="#6b7280"
            autoCapitalize="words"
            onSubmitEditing={() => typed && p.onPick(typed)}
          />
          <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
            {typed && !exists ? (
              <Item text={`Add “${typed}”`} strong onPress={() => p.onPick(typed)} />
            ) : null}
            {!typed && p.here.length ? <Text style={styles.group}>IN THIS RECORDING</Text> : null}
            {(typed ? p.here.filter((h) => h.toLowerCase().includes(typed.toLowerCase())) : p.here).map((h) => (
              <Item key={`h-${h}`} text={h} onPress={() => p.onPick(h)} />
            ))}
            {rest.length ? <Text style={styles.group}>{typed ? "OTHERS" : "RECENT"}</Text> : null}
            {rest.map((h) => <Item key={`r-${h}`} text={h} onPress={() => p.onPick(h)} />)}
            {!typed && p.mergeInto?.length ? (
              <>
                <Text style={styles.group}>SAME PERSON AS…</Text>
                {p.mergeInto.map((m) => (
                  <Item key={`m-${m.key}`} text={`Merge into ${m.name}`} onPress={() => p.onMerge?.(m.key, m.name)} />
                ))}
              </>
            ) : null}
            {!typed && p.canLeaveUnnamed ? <Item text="Don't know — leave unnamed" onPress={() => p.onLeaveUnnamed?.()} /> : null}
            {!typed && p.canRemove ? <Item text="Remove name" danger onPress={() => p.onRemove?.()} /> : null}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function Item({ text, onPress, strong, danger }: { text: string; onPress: () => void; strong?: boolean; danger?: boolean }) {
  return (
    <TouchableOpacity style={styles.item} onPress={onPress}>
      <Text style={[styles.itemTxt, strong && { fontWeight: "700", color: "#93c5fd" }, danger && { color: "#f87171" }]}>{text}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  back: { flex: 1, backgroundColor: "#000000aa", justifyContent: "center", padding: 24 },
  sheet: { backgroundColor: "#1a1d23", borderRadius: 14, padding: 14 },
  title: { color: "#fff", fontSize: 16, fontWeight: "700", marginBottom: 10 },
  input: { backgroundColor: "#0f1115", color: "#fff", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6 },
  group: { color: "#7c828a", fontSize: 11, letterSpacing: 1, marginTop: 10, marginBottom: 2 },
  item: { paddingVertical: 11 },
  itemTxt: { color: "#e8eaed", fontSize: 16 },
});
