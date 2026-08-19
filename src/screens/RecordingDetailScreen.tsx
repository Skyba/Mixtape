import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import AudioPlayerBar from "../components/AudioPlayerBar";
import SpeakerSelector from "../components/SpeakerSelector";
import SpeakerRemap from "../components/SpeakerRemap";
import SpeakerTimeline from "../components/SpeakerTimeline";
import FolderDropdown from "../components/FolderDropdown";
import Select from "../components/Select";
import { colorForLetter } from "../colors";
import {
  audioPath,
  transcriptPath,
  readTranscript,
  writeTranscript,
  readAaiJson,
  writeMeta,
  moveToFolder,
  deleteRecording,
  listRecordings,
  ROOT,
} from "../recordings";
import {
  deleteRemoteRecording,
  downloadRemoteFile,
  remoteObjectPath,
  isFirebaseConfigured,
  isSignedIn,
  uploadRecording,
  publishShare,
  unpublishShare,
  shareUrl,
} from "../firebase";
import { transcribeExisting } from "../recordingFlow";
import {
  summarize,
  renderTranscript,
  nameForSpeaker,
  Utterance,
} from "../transcription";
import {
  getSettings,
  getFolders,
  getSpeakerHistory,
  rememberFolder,
  rememberSpeakers,
} from "../storage";
import { INBOX, Recording } from "../types";

import { DEFAULT_SUMMARY_PROMPT, PROMPT_PRESETS } from "../prompts";
import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Detail">;

function tstamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function toNames(speakers: string[]): (string | null)[] {
  return speakers.map((s) => (/^Speaker \d+$/.test(s) ? null : s));
}
function toSpeakers(names: (string | null)[]): string[] {
  return names.map((n, i) => (n && n.trim() ? n.trim() : `Speaker ${i + 1}`));
}

export default function RecordingDetailScreen({ route, navigation }: Props) {
  const [rec, setRec] = useState<Recording>(route.params.rec);
  const [isRemote, setIsRemote] = useState(!!route.params.remote);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [folderHist, setFolderHist] = useState<string[]>([INBOX]);
  const [speakerHist, setSpeakerHist] = useState<string[]>([]);
  const [summaryPrompt, setSummaryPrompt] = useState(DEFAULT_SUMMARY_PROMPT);
  const [presetKey, setPresetKey] = useState("summary");
  const [summary, setSummary] = useState<string>(route.params.rec.summary ?? "");
  const [summarizing, setSummarizing] = useState(false);
  const [utterances, setUtterances] = useState<Utterance[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const insets = useSafeAreaInsets();

  const done = rec.transcriptStatus === "done";
  const pending =
    rec.transcriptStatus === "pending" || rec.transcriptStatus === "processing";
  const canUseTranscript = done && !isRemote && !!transcript;

  useEffect(() => {
    (async () => {
      setFolderHist(Array.from(new Set([INBOX, ...(await getFolders())])));
      setSpeakerHist(await getSpeakerHistory());
      if (!isRemote) {
        setTranscript(await readTranscript(rec));
        setUtterances(await readAaiJson(rec));
      }
    })();
  }, [isRemote, rec]);

  async function downloadFromCloud() {
    setBusy("Downloading…");
    await FileSystem.makeDirectoryAsync(`${ROOT}${rec.folder}/`, {
      intermediates: true,
    });
    await downloadRemoteFile(remoteObjectPath(rec, "m4a"), audioPath(rec));
    await downloadRemoteFile(
      remoteObjectPath(rec, "txt"),
      transcriptPath(rec)
    );
    await writeMeta(rec);
    setIsRemote(false);
    setBusy("");
  }

  async function copyTranscript() {
    if (!canUseTranscript || !transcript) return;
    await Clipboard.setStringAsync(transcript);
    flashCopied();
  }

  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function runSummary() {
    if (!transcript) return;
    const settings = await getSettings();
    if (!settings.anthropicKey) {
      Alert.alert("Add your Anthropic key in Settings first");
      return;
    }
    setSummarizing(true);
    try {
      const out = await summarize(transcript, summaryPrompt, settings);
      setSummary(out);
      const next = { ...rec, summary: out };
      setRec(next);
      await writeMeta(next);
    } catch (e: any) {
      Alert.alert("Summary failed", String(e?.message ?? e));
    }
    setSummarizing(false);
  }

  async function copySummary() {
    if (!summary) return;
    await Clipboard.setStringAsync(summary);
    flashCopied();
  }

  async function publish() {
    if (!isSignedIn()) {
      Alert.alert("Sign in first", "Cloud sign-in is required to publish.");
      return;
    }
    setShareBusy(true);
    try {
      const { shareId, url } = await publishShare(rec, utterances ?? []);
      const next = { ...rec, shareId };
      setRec(next);
      await writeMeta(next);
      await Clipboard.setStringAsync(url);
      Alert.alert("Published — link copied", url);
    } catch (e: any) {
      Alert.alert("Publish failed", String(e?.message ?? e));
    }
    setShareBusy(false);
  }

  async function unpublish() {
    if (!rec.shareId) return;
    setShareBusy(true);
    try {
      await unpublishShare(rec.shareId);
      const next = { ...rec, shareId: undefined };
      setRec(next);
      await writeMeta(next);
    } catch (e: any) {
      Alert.alert("Unpublish failed", String(e?.message ?? e));
    }
    setShareBusy(false);
  }

  async function copyShareLink() {
    if (!rec.shareId) return;
    await Clipboard.setStringAsync(shareUrl(rec.shareId));
    flashCopied();
  }

  async function remapSpeaker(letter: string, name: string) {
    if (!utterances) return;
    const nextMap = { ...(rec.speakerMap ?? {}), [letter]: name };
    const nextText = renderTranscript(utterances, rec.speakers, nextMap);
    const next = { ...rec, speakerMap: nextMap };
    setRec(next);
    setTranscript(nextText);
    await writeTranscript(next, nextText);
    await writeMeta(next);
    if (isFirebaseConfigured && isSignedIn()) {
      try {
        await uploadRecording(next);
      } catch {
        /* best-effort; Sync will retry */
      }
    }
  }

  async function shareFile(uri: string) {
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert("Sharing unavailable on this device");
      return;
    }
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      Alert.alert("File not found", "Download it from cloud first.");
      return;
    }
    await Sharing.shareAsync(uri);
  }

  async function doTranscribe() {
    const settings = await getSettings();
    if (!settings.assemblyAiKey) {
      Alert.alert("Add your AssemblyAI key in Settings first");
      return;
    }
    setBusy("Transcribing… (this can take minutes)");
    try {
      const updated = await transcribeExisting(rec, settings);
      setRec(updated);
      setTranscript(await readTranscript(updated));
    } catch (e: any) {
      Alert.alert("Transcription failed", String(e?.message ?? e));
    }
    setBusy("");
  }

  async function changeFolder(folder: string) {
    if (folder === rec.folder) return;
    setBusy("Moving…");
    const moved = await moveToFolder(rec, folder);
    await rememberFolder(folder);
    setRec(moved);
    setBusy("");
  }

  async function saveSpeakers(names: (string | null)[]) {
    const speakers = toSpeakers(names);
    const next = { ...rec, speakers };
    setRec(next);
    await writeMeta(next);
    await rememberSpeakers(speakers.filter((s) => !/^Speaker \d+$/.test(s)));
  }

  function confirmDelete() {
    Alert.alert("Delete recording?", rec.base, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteRecording(rec);
          if (isFirebaseConfigured) await deleteRemoteRecording(rec);
          navigation.goBack();
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container}>
      {copied ? <Text style={styles.copiedBanner}>Copied ✓</Text> : null}
      <Text style={styles.title}>{rec.topic || rec.base}</Text>
      <Text style={styles.meta}>
        {new Date(rec.recordedAt).toLocaleString()} ·{" "}
        {Math.round(rec.durationSeconds / 60)} min · {rec.language}
      </Text>
      <View style={styles.badges}>
        <Badge
          text={
            done
              ? "Transcribed ✓"
              : pending
              ? "Transcribing…"
              : "No transcript"
          }
          color={done ? "#16331f" : pending ? "#3a2f12" : "#2a2d34"}
          fg={done ? "#4ade80" : pending ? "#fbbf24" : "#9aa0a6"}
        />
        <Badge
          text={`Upload: ${rec.uploadStatus}`}
          color="#2a2d34"
          fg="#9aa0a6"
        />
      </View>

      {(rec.aaiTranscriptId || rec.estCostUsd != null) && (
        <View style={styles.metaCard}>
          {rec.transcribedAt ? (
            <MetaRow
              k="Transcribed"
              v={new Date(rec.transcribedAt).toLocaleString()}
            />
          ) : null}
          {rec.audioDurationSec != null ? (
            <MetaRow
              k="Audio length"
              v={`${Math.round(rec.audioDurationSec / 60)} min (${rec.audioDurationSec}s)`}
            />
          ) : null}
          {rec.estCostUsd != null ? (
            <MetaRow k="Est. cost" v={`$${rec.estCostUsd.toFixed(3)}`} />
          ) : null}
          {rec.aaiTranscriptId ? (
            <MetaRow k="AAI job ID" v={rec.aaiTranscriptId} mono />
          ) : null}
        </View>
      )}

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.busyTxt}>{busy}</Text>
        </View>
      ) : null}

      {rec.damaged ? (
        <View style={styles.damagedBox}>
          <Text style={styles.damagedTitle}>Interrupted recording</Text>
          <Text style={styles.damagedTxt}>
            The recorder was killed before it could close this file (phone
            restart or flat battery), so the audio is there but the index that
            makes it playable is missing. It won't play or transcribe until
            it's repaired on a computer.
          </Text>
        </View>
      ) : null}

      {isRemote ? (
        <TouchableOpacity style={styles.primary} onPress={downloadFromCloud}>
          <Text style={styles.btnTxt}>⬇ Download from cloud</Text>
        </TouchableOpacity>
      ) : (
        <>
          {/* Transcript-gated actions */}
          <View style={styles.btnRow}>
            <LockBtn
              label="Copy transcript"
              enabled={canUseTranscript}
              onPress={copyTranscript}
            />
            <LockBtn
              label="Save .txt"
              enabled={canUseTranscript}
              onPress={() => shareFile(transcriptPath(rec))}
            />
          </View>

          <AudioPlayerBar uri={audioPath(rec)} />
          <TouchableOpacity
            style={styles.audioShare}
            onPress={() => shareFile(audioPath(rec))}
          >
            <Text style={styles.btnTxt}>Share / save audio (.m4a)</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.transcribe,
              done && styles.transcribeDone,
              pending && styles.transcribeBusy,
            ]}
            disabled={pending || !!rec.damaged}
            onPress={doTranscribe}
          >
            <Text style={styles.btnTxt}>
              {done
                ? "Re-transcribe"
                : pending
                ? "Transcribing…"
                : "Transcribe now"}
            </Text>
          </TouchableOpacity>
        </>
      )}

      <FolderDropdown
        value={rec.folder}
        options={folderHist}
        onChange={changeFolder}
      />
      <SpeakerSelector
        count={rec.speakers.length}
        names={toNames(rec.speakers)}
        history={speakerHist}
        onChange={(_, n) => saveSpeakers(n)}
      />

      {canUseTranscript && utterances && utterances.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Talk time</Text>
          <SpeakerTimeline
            utterances={utterances}
            nameFor={(l) => nameForSpeaker(l, rec.speakers, rec.speakerMap)}
          />

          <Text style={styles.sectionLabel}>Fix speaker names</Text>
          <SpeakerRemap
            letters={Array.from(
              new Set(utterances.map((u) => u.speaker))
            ).sort()}
            nameFor={(l) => nameForSpeaker(l, rec.speakers, rec.speakerMap)}
            options={Array.from(
              new Set([
                ...rec.speakers.filter((s) => !/^Speaker \d+$/.test(s)),
                ...speakerHist,
              ])
            )}
            onPick={remapSpeaker}
          />
        </>
      ) : null}

      {canUseTranscript ? (
        <>
          <Text style={styles.sectionLabel}>AI Summary</Text>
          <Select
            value={presetKey}
            options={PROMPT_PRESETS.map((p) => ({
              label: p.label,
              value: p.key,
            }))}
            onChange={(key) => {
              setPresetKey(key);
              if (key === "custom") setSummaryPrompt("");
              else {
                const p = PROMPT_PRESETS.find((x) => x.key === key);
                if (p && p.text) setSummaryPrompt(p.text);
              }
            }}
          />
          <TextInput
            style={[styles.promptInput, { marginTop: 10 }]}
            value={summaryPrompt}
            onChangeText={(v) => {
              setSummaryPrompt(v);
              setPresetKey("custom");
            }}
            placeholder="Prompt to run on the transcript…"
            placeholderTextColor="#6b7280"
            multiline
          />
          <TouchableOpacity
            style={styles.summarizeBtn}
            onPress={runSummary}
            disabled={summarizing}
          >
            {summarizing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnTxt}>
                {summary ? "Re-run prompt" : "Summarize"}
              </Text>
            )}
          </TouchableOpacity>
          {summary ? (
            <View style={styles.summaryBox}>
              <ScrollView style={styles.summaryScroll} nestedScrollEnabled>
                <Text style={styles.summaryTxt}>{summary}</Text>
              </ScrollView>
              <TouchableOpacity style={styles.copyChip} onPress={copySummary}>
                <Text style={styles.copyChipTxt}>Copy summary</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {isFirebaseConfigured ? (
            <>
              <Text style={styles.sectionLabel}>Public share link</Text>
              {rec.shareId ? (
                <View style={styles.shareCard}>
                  <Text style={styles.shareUrl} numberOfLines={1}>
                    {shareUrl(rec.shareId)}
                  </Text>
                  <View style={styles.btnRow}>
                    <TouchableOpacity
                      style={[styles.summarizeBtn, styles.flex, { marginTop: 0 }]}
                      onPress={copyShareLink}
                    >
                      <Text style={styles.btnTxt}>Copy link</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.del, styles.flex, { marginTop: 0 }]}
                      onPress={unpublish}
                      disabled={shareBusy}
                    >
                      <Text style={styles.btnTxt}>Unpublish</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.summarizeBtn}
                  onPress={publish}
                  disabled={shareBusy}
                >
                  {shareBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.btnTxt}>🔗 Publish public link</Text>
                  )}
                </TouchableOpacity>
              )}
            </>
          ) : null}

          <Text style={styles.sectionLabel}>Transcript</Text>
          <ScrollView style={styles.transcriptBox} nestedScrollEnabled>
            {utterances && utterances.length > 0 ? (
              utterances.map((u, i) => (
                <View key={i} style={styles.uttRow}>
                  <Text
                    style={[
                      styles.uttSpeaker,
                      { color: colorForLetter(u.speaker) },
                    ]}
                  >
                    {nameForSpeaker(u.speaker, rec.speakers, rec.speakerMap)}
                    <Text style={styles.uttTime}>
                      {"  "}
                      {tstamp(u.start)}
                    </Text>
                  </Text>
                  <Text style={styles.uttText}>{u.text}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.transcriptTxt}>{transcript}</Text>
            )}
          </ScrollView>
        </>
      ) : !isRemote && !done ? (
        <Text style={styles.meta}>No transcript yet.</Text>
      ) : null}

      <TouchableOpacity style={styles.del} onPress={confirmDelete}>
        <Text style={styles.btnTxt}>Delete</Text>
      </TouchableOpacity>
      <View style={{ height: 40 + insets.bottom }} />
    </ScrollView>
  );
}

function Badge({
  text,
  color,
  fg,
}: {
  text: string;
  color: string;
  fg: string;
}) {
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={[styles.badgeTxt, { color: fg }]}>{text}</Text>
    </View>
  );
}

function MetaRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaKey}>{k}</Text>
      <Text
        style={[styles.metaVal, mono && styles.metaMono]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {v}
      </Text>
    </View>
  );
}

function LockBtn({
  label,
  enabled,
  onPress,
}: {
  label: string;
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.lock, styles.flex, enabled ? styles.lockOn : styles.lockOff]}
      disabled={!enabled}
      onPress={onPress}
    >
      <Text style={enabled ? styles.btnTxt : styles.lockOffTxt}>
        {enabled ? label : `🔒 ${label}`}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: "#0f1115", flex: 1, padding: 20, paddingTop: 50 },
  damagedBox: {
    backgroundColor: "#3a1d1d",
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  damagedTitle: { color: "#f28b82", fontSize: 15, fontWeight: "700" },
  damagedTxt: { color: "#e8b4b0", fontSize: 12, marginTop: 6, lineHeight: 17 },
  copiedBanner: {
    color: "#4ade80",
    fontWeight: "700",
    fontSize: 13,
    marginBottom: 6,
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  meta: { color: "#9aa0a6", fontSize: 13, marginTop: 6 },
  badges: { flexDirection: "row", gap: 8, marginTop: 10 },
  badge: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14 },
  badgeTxt: { fontSize: 12, fontWeight: "700" },
  metaCard: {
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 8,
  },
  metaRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  metaKey: { color: "#6b7280", fontSize: 13 },
  metaVal: { color: "#cdd1d6", fontSize: 13, flexShrink: 1, textAlign: "right" },
  metaMono: { fontFamily: "monospace", fontSize: 11 },
  sectionLabel: {
    color: "#9aa0a6",
    fontSize: 13,
    marginTop: 22,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  promptInput: {
    backgroundColor: "#1a1d23",
    color: "#fff",
    borderRadius: 10,
    padding: 14,
    minHeight: 64,
    textAlignVertical: "top",
  },
  summarizeBtn: {
    backgroundColor: "#3b82f6",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 10,
  },
  summaryBox: {
    backgroundColor: "#16331f",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  summaryScroll: { maxHeight: 240 },
  summaryTxt: { color: "#d7f5e1", fontSize: 14, lineHeight: 21 },
  copyChip: {
    backgroundColor: "#1f5132",
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    marginTop: 12,
  },
  copyChipTxt: { color: "#d7f5e1", fontWeight: "700", fontSize: 13 },
  shareCard: { backgroundColor: "#1a1d23", borderRadius: 12, padding: 14 },
  shareUrl: { color: "#60a5fa", fontSize: 13, marginBottom: 12 },
  busy: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 },
  busyTxt: { color: "#9aa0a6" },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  flex: { flex: 1 },
  lock: { padding: 14, borderRadius: 12, alignItems: "center" },
  lockOn: { backgroundColor: "#3b82f6" },
  lockOff: {
    backgroundColor: "#1a1d23",
    borderWidth: 1,
    borderColor: "#2a2d34",
  },
  lockOffTxt: { color: "#5b6068", fontWeight: "600" },
  primary: {
    backgroundColor: "#3b82f6",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 18,
  },
  secondary: {
    backgroundColor: "#23262d",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 12,
  },
  audioRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  play: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#23262d",
    alignItems: "center",
    justifyContent: "center",
  },
  playOn: { backgroundColor: "#3b82f6" },
  playTxt: { color: "#fff", fontSize: 18 },
  audioShare: {
    flex: 1,
    backgroundColor: "#23262d",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  transcribe: {
    backgroundColor: "#3b82f6",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 12,
  },
  transcribeDone: { backgroundColor: "#23262d" },
  transcribeBusy: { backgroundColor: "#3a2f12" },
  btnTxt: { color: "#fff", fontWeight: "700" },
  del: {
    backgroundColor: "#7f1d1d",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 28,
  },
  transcriptBox: {
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 14,
    marginTop: 18,
    maxHeight: 380,
  },
  transcriptTxt: { color: "#cdd1d6", fontSize: 14, lineHeight: 21 },
  uttRow: { marginBottom: 14 },
  uttSpeaker: { fontSize: 14, fontWeight: "700" },
  uttTime: { color: "#6b7280", fontSize: 12, fontWeight: "400" },
  uttText: { color: "#cdd1d6", fontSize: 14, lineHeight: 21, marginTop: 2 },
});
