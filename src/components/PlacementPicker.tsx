import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  FOLDERS,
  INBOX,
  alwaysPrivate,
  builtinTags,
  isUnknownFolder,
  normalizeTag,
} from "../placement";
import {
  getCustomTags,
  getFolders,
  rememberFolder,
  rememberTag,
} from "../storage";

const COLLAPSED_FOLDERS = 6;

export type Placement = {
  folder: string;
  private: boolean;
  tags: string[];
};

function Chip({
  label,
  on,
  dim,
  onPress,
}: {
  label: string;
  on?: boolean;
  dim?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, on && styles.chipOn, dim && styles.chipDim]}
      onPress={onPress}
    >
      <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Sets where a recording is filed in the transcript archive: folder, privacy
 * and tags. Folders come from a hand-kept mirror of routes.json; tags are that
 * folder's vocabulary, so the row changes with the folder. Everything is a
 * chip — one tap, no dropdowns, and the folder row stays a single line until
 * you ask for the full list.
 */
export default function PlacementPicker({
  value,
  onChange,
}: {
  value: Placement;
  onChange: (next: Placement) => void;
}) {
  const [history, setHistory] = useState<string[]>([]);
  const [custom, setCustom] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState<"folder" | "tag" | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    getFolders().then(setHistory);
    getCustomTags().then(setCustom);
  }, []);

  // Recently used first, then the rest of the mirror — so the folders actually
  // in play sit on the first row.
  const folders = useMemo(() => {
    const all = [INBOX, ...FOLDERS.map((f) => f.name)];
    for (const h of history) if (!all.some((f) => f === h)) all.push(h);
    const rank = (n: string) => {
      const i = history.indexOf(n);
      return i < 0 ? history.length + all.indexOf(n) : i;
    };
    return [...all].sort((a, b) => rank(a) - rank(b));
  }, [history]);

  const shown = expanded ? folders : folders.slice(0, COLLAPSED_FOLDERS);
  const tags = [...builtinTags(value.folder), ...(custom[value.folder] ?? [])];
  const forcedPrivate = alwaysPrivate(value.folder);

  function pickFolder(name: string) {
    // Tags belong to a folder's vocabulary, so they don't survive the move.
    onChange({ folder: name, private: value.private, tags: [] });
    rememberFolder(name);
    setHistory((h) => [name, ...h.filter((x) => x !== name)]);
  }

  function toggleTag(t: string) {
    const on = value.tags.includes(t);
    // Selection order is kept: the archive puts the first two in the filename.
    onChange({
      ...value,
      tags: on ? value.tags.filter((x) => x !== t) : [...value.tags, t],
    });
  }

  function commitDraft() {
    const raw = draft.trim();
    setDraft("");
    const mode = adding;
    setAdding(null);
    if (!raw) return;
    if (mode === "folder") {
      const name = raw.slice(0, 40);
      pickFolder(name);
      setExpanded(true);
      if (isUnknownFolder(name)) {
        Alert.alert(
          "Folder added",
          `"${name}" is set on this recording. Add the same name to routes.json in comm-relay, otherwise the archive files it at the root.`
        );
      }
      return;
    }
    const tag = normalizeTag(raw);
    if (!tag) return;
    rememberTag(value.folder, tag);
    setCustom((c) => ({
      ...c,
      [value.folder]: [...(c[value.folder] ?? []), tag],
    }));
    onChange({ ...value, tags: [...value.tags, tag] });
  }

  return (
    <View>
      <View style={styles.row}>
        {shown.map((f) => (
          <Chip
            key={f}
            label={f}
            on={f === value.folder}
            onPress={() => pickFolder(f)}
          />
        ))}
        {folders.length > COLLAPSED_FOLDERS ? (
          <Chip
            label={expanded ? "less" : "···"}
            dim
            onPress={() => setExpanded((e) => !e)}
          />
        ) : null}
        {expanded ? (
          <Chip label="+ folder" dim onPress={() => setAdding("folder")} />
        ) : null}
      </View>

      <View style={styles.row}>
          {tags.map((t) => (
            <Chip
              key={t}
              label={t}
              on={value.tags.includes(t)}
              onPress={() => toggleTag(t)}
            />
          ))}
          <Chip label="+" dim onPress={() => setAdding("tag")} />
          <Chip
            label={value.private || forcedPrivate ? "🔒 private" : "private"}
            on={value.private || forcedPrivate}
            onPress={() => {
              if (forcedPrivate) {
                Alert.alert(
                  "Always private",
                  `Recordings in "${value.folder}" are private by default in routes.json, and privacy can only ever go up.`
                );
                return;
              }
              onChange({ ...value, private: !value.private });
            }}
        />
      </View>

      {adding ? (
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={adding === "folder" ? "new folder" : "new tag"}
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={commitDraft}
          />
          <TouchableOpacity style={styles.addBtn} onPress={commitDraft}>
            <Text style={styles.addTxt}>Add</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {isUnknownFolder(value.folder) ? (
        <Text style={styles.note}>
          Not in routes.json — add it there or the archive files this at the root.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  chip: {
    backgroundColor: "#23262d",
    borderRadius: 14,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  chipOn: { backgroundColor: "#2f6fd0" },
  chipDim: { backgroundColor: "#191c22" },
  chipTxt: { color: "#c9cdd3", fontSize: 12 },
  chipTxtOn: { color: "#fff", fontWeight: "700" },
  addRow: { flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: "#1a1d23",
    borderRadius: 10,
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  addBtn: {
    backgroundColor: "#2f6fd0",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  addTxt: { color: "#fff", fontSize: 13, fontWeight: "700" },
  note: { color: "#fbbf24", fontSize: 11, marginTop: 6, lineHeight: 15 },
});
