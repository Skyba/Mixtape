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
  ghost,
  onPress,
}: {
  label: string;
  on?: boolean;
  ghost?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, on && styles.chipOn, ghost && styles.chipGhost]}
      onPress={onPress}
    >
      <Text
        style={[
          styles.chipTxt,
          on && styles.chipTxtOn,
          ghost && styles.chipTxtGhost,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Sets where a recording is filed in the transcript archive: folder, privacy
 * and tags. Folders come from a hand-kept mirror of routes.json; tags are that
 * folder's vocabulary, so the row changes with the folder. Everything is a
 * chip — one tap, no dropdowns — and the folder row stays a single line until
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
  const isPrivate = value.private || forcedPrivate;

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
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.section}>FOLDER</Text>
        <TouchableOpacity
          style={[styles.lock, isPrivate && styles.lockOn]}
          onPress={() => {
            if (forcedPrivate) {
              Alert.alert(
                "Always private",
                `Recordings in "${value.folder}" are private by default in routes.json, and privacy only ever goes up.`
              );
              return;
            }
            onChange({ ...value, private: !value.private });
          }}
        >
          <Text style={[styles.lockTxt, isPrivate && styles.lockTxtOn]}>
            {isPrivate ? "🔒 private" : "private"}
          </Text>
        </TouchableOpacity>
      </View>

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
            label={expanded ? "less" : `+${folders.length - COLLAPSED_FOLDERS}`}
            ghost
            onPress={() => setExpanded((e) => !e)}
          />
        ) : null}
        {expanded ? (
          <Chip label="new folder" ghost onPress={() => setAdding("folder")} />
        ) : null}
      </View>

      {isUnknownFolder(value.folder) ? (
        <Text style={styles.note}>
          Not in routes.json — add it there, or the archive files this at the
          root.
        </Text>
      ) : null}

      <View style={styles.divider} />

      <Text style={styles.section}>TAGS</Text>
      <View style={styles.row}>
        {tags.map((t) => (
          <Chip
            key={t}
            label={`#${t}`}
            on={value.tags.includes(t)}
            onPress={() => toggleTag(t)}
          />
        ))}
        <Chip label="new tag" ghost onPress={() => setAdding("tag")} />
      </View>

      {adding ? (
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={adding === "folder" ? "folder name" : "tag name"}
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
    </View>
  );
}

const styles = StyleSheet.create({
  // Its own surface, so filing reads as one block rather than more chips
  // running on from the speaker list above it.
  card: {
    backgroundColor: "#15181d",
    borderRadius: 14,
    padding: 12,
    marginTop: 14,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  section: {
    color: "#7c828a",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
  },
  divider: { height: 1, backgroundColor: "#23262d", marginTop: 12, marginBottom: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: {
    backgroundColor: "#23262d",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  chipOn: { backgroundColor: "#2f6fd0" },
  chipGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#2d323b",
  },
  chipTxt: { color: "#c9cdd3", fontSize: 12.5 },
  chipTxtOn: { color: "#fff", fontWeight: "700" },
  chipTxtGhost: { color: "#7c828a", fontSize: 12 },
  lock: {
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "#2d323b",
  },
  lockOn: { backgroundColor: "#4a2a2a", borderColor: "#7a3b3b" },
  lockTxt: { color: "#7c828a", fontSize: 12 },
  lockTxtOn: { color: "#f28b82", fontWeight: "700" },
  addRow: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: "#0f1115",
    borderRadius: 8,
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  addBtn: {
    backgroundColor: "#2f6fd0",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  addTxt: { color: "#fff", fontSize: 13, fontWeight: "700" },
  note: { color: "#fbbf24", fontSize: 11, marginTop: 8, lineHeight: 15 },
});
