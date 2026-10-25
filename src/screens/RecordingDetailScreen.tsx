import { useEffect, useRef, useState } from "react";
import { setLabel, touch, adopt, changedKeys } from "../attribution";
import { enqueue, replayOutbox } from "../outbox";
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
import PlacementPicker, { Placement } from "../components/PlacementPicker";
import Select from "../components/Select";
import { colorForLetter } from "../colors";
import {
  audioPath,
  transcriptPath,
  aaiJsonPath,
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
import { isCanonical, deleteRemote, onCloudChange } from "../cloud";
import { readMeta, commitMeta } from "../recordings";
import { remoteCanonicalPath } from "../firebase";
import { pushMeta, recordEdit, sendEdits } from "../outbox";
import { isLayoutV2, idDir } from "../recordings";
import {
  summarize,
  renderTranscript,
  nameForSpeaker,
  Utterance,
} from "../transcription";
import {
  getSettings,
  getSpeakerHistory,
  rememberFolder,
  rememberSpeakers,
} from "../storage";
import { Recording } from "../types";

import { DEFAULT_SUMMARY_PROMPT, PROMPT_PRESETS } from "../prompts";
import type { RootStackParamList } from "../../App";

type Props = NativeStackScreenProps<RootStackParamList, "Detail">;

// Mirrors the Record screen. "Auto" detects instead of pinning.
const DETAIL_LANGUAGES = ["Auto", "English", "French", "Arabic", "Spanish"];

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
  // v2: an entry the listener restored has a sidecar but no audio yet; the
  // disk, not the route, says whether the download button is needed.
  useEffect(() => {
    if (!isLayoutV2()) return;
    FileSystem.getInfoAsync(audioPath(rec)).then((i) => setIsRemote(!i.exists)).catch(() => {});
  }, [rec.id]);
  // The transcript pair on screen and the revision it came from, loaded
  // together: letter edits are bound to THIS revision, not to whatever the
  // sidecar says by the time the tap lands.
  const [loadedRev, setLoadedRev] = useState<number>(0);
  const revisionBehind = isLayoutV2() && !!rec.transcriptRevision && loadedRev !== rec.transcriptRevision;
  const shownRev = isLayoutV2() ? loadedRev : (rec.transcriptRevision ?? 0);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
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

  // A transcript finishing or an edit landing from the Mac while this screen
  // is open: re-read the sidecar and its files.
  // Reads the pair and its revision, then publishes all three in one go.
  async function loadPair(r: Recording) {
    const [t, u] = await Promise.all([readTranscript(r), readAaiJson(r)]);
    setTranscript(t);
    setUtterances(u);
    setLoadedRev(isLayoutV2() ? (r.transcriptLocalRev ?? 0) : (r.transcriptRevision ?? 0));
  }
  useEffect(() => onCloudChange(async () => {
    const cur = await readMeta(rec.id).catch(() => null);
    if (!cur) return;
    if (!isRemote) await loadPair(cur);
    setRec(cur);
  }), [rec.id, isRemote]);

  useEffect(() => {
    (async () => {
      setSpeakerHist(await getSpeakerHistory());
      if (!isRemote) await loadPair(rec);
    })();
  }, [isRemote, rec.id, rec.transcriptLocalRev]);

  // Under v2 a transcript write names the revision it belongs to, and is
  // refused inside the lock if that revision is no longer the installed one.
  function sameRev(cur: Recording) {
    if (isLayoutV2() && (cur.transcriptLocalRev ?? 0) !== loadedRev) throw new Error("transcript revision changed");
    return cur;
  }

  async function downloadFromCloud() {
    setBusy("Downloading…");
    if (await isCanonical()) {
      await FileSystem.makeDirectoryAsync(idDir(rec), { intermediates: true });
      await downloadRemoteFile(remoteCanonicalPath(rec.id, "audio.m4a"), audioPath(rec));
      setIsRemote(false);
      setBusy("");
      return;
    }
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
      const next = await commitMeta(rec, (cur) => ({ ...cur, summary: out }));
      setRec(next);
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
      const preview = touch({ ...rec, shareId }, "shareId");
      await recordEdit(preview, { shareId });
      const next = await commitMeta(rec, (cur) => adopt(cur, preview, ["shareId"]));
      setRec(next);
      await sendEdits(next);
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
      const preview = touch({ ...rec, shareId: undefined }, "shareId");
      await recordEdit(preview, { shareId: null });
      const next = await commitMeta(rec, (cur) => adopt(cur, preview, ["shareId"]));
      setRec(next);
      await sendEdits(next);
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
    if (revisionBehind) { Alert.alert("New transcript downloading", "Label speakers once it has arrived."); return; }
    // A name belongs to one letter unless there are more letters than people,
    // so assigning it here takes it away from whichever letter had it.
    const mayShare =
      new Set(utterances.map((u) => u.speaker)).size > rec.speakers.length;
    const base = Object.fromEntries(
      Object.entries(rec.speakerMap ?? {}).filter(
        ([l, n]) => mayShare || l === letter || n !== name
      )
    );
    const settings = await getSettings();
    // setLabel carries a legacy map forward as labels of unknown provenance
    // and only ever changes the one letter; the duplicate-name rule above is
    // re-checked by the server against the merged state and refused, not
    // silently dropped, if it would give one name to two letters.
    const preview = setLabel(rec, letter, name, "user", settings.ownerName);
    // Queue first, then write locally, then send: the per-letter patch names
    // the transcript revision it was made against so a re-run since refuses it.
    const stamps = preview.fieldsUpdatedAt ?? {};
    const patch: Record<string, unknown> = { [`speakerLabels.${letter}`]: preview.speakerLabels?.[letter] ?? null };
    if (preview.speakerId !== rec.speakerId) patch.speakerId = preview.speakerId ?? null;
    if (preview.meIncluded !== rec.meIncluded) patch.meIncluded = preview.meIncluded;
    await enqueue(preview, patch, stamps, shownRev);
    const keys = changedKeys(rec, preview);
    let next: Recording;
    try {
      next = await commitMeta(rec, (cur) => adopt(sameRev(cur), preview, keys));
    } catch {
      Alert.alert("New transcript arrived", "Label speakers again on the new one.");
      return;
    }
    const nextMap = next.speakerMap ?? { ...base, [letter]: name };
    const nextText = renderTranscript(utterances, rec.speakers, nextMap);
    setRec(next);
    setTranscript(nextText);
    await writeTranscript({ ...next, transcriptLocalRev: loadedRev }, nextText);
    if (isFirebaseConfigured && isSignedIn()) {
      // Legacy: the re-rendered transcript text goes up as a file. Canonical:
      // the server renders from the labels; nothing but the patch is sent.
      if (!(await isCanonical())) uploadRecording(next, { skipAudio: !!next.mergedInCloud }).catch(() => {});
      replayOutbox().catch(() => {});
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

  async function doTranscribe(target: Recording = rec) {
    const settings = await getSettings();
    if (!settings.assemblyAiKey && !(await isCanonical())) {
      Alert.alert("Add your AssemblyAI key in Settings first");
      return;
    }
    setBusy("Transcribing… (this can take minutes)");
    try {
      const updated = await transcribeExisting(target, settings);
      setRec(updated);
      setTranscript(await readTranscript(updated));
    } catch (e: any) {
      Alert.alert("Transcription failed", String(e?.message ?? e));
    }
    setBusy("");
  }

  async function changeFolder(folder: string, p?: Placement) {
    if (folder === rec.folder) return;
    setBusy("Moving…");
    const from = rec;
    if (await isCanonical()) {
      // A field, stamped, through the outbox. Tags belong to the folder's
      // vocabulary, so a move clears or replaces them.
      const preview = touch({ ...rec, folder, ...(p ? { private: p.private, tags: p.tags } : {}) }, "folder", ...(p ? ["private", "tags"] : []));
      await recordEdit(preview, { folder, ...(p ? { private: p.private, tags: p.tags } : {}) });
      const moved = await commitMeta(rec, (cur) => adopt(cur, preview, changedKeys(rec, preview)));
      await rememberFolder(folder);
      setRec(moved);
      await sendEdits(moved);
      setBusy("");
      return;
    }
    // The cloud copy can hold files this phone never had — a transcript
    // repaired server-side, for instance. The move re-uploads what's local and
    // deletes the old path, so anything only in the cloud has to come down
    // first or it goes with the old folder.
    if (isFirebaseConfigured && isSignedIn()) {
      await downloadRemoteFile(
        remoteObjectPath(rec, "txt"),
        transcriptPath(rec)
      ).catch(() => {});
      await downloadRemoteFile(
        remoteObjectPath(rec, "aai.json"),
        aaiJsonPath(rec)
      ).catch(() => {});
    }
    const moved = await moveToFolder(rec, folder);
    // Tags belong to the folder's vocabulary, so a move clears them.
    const next = p ? { ...moved, private: p.private, tags: p.tags } : moved;
    if (p) await writeMeta(next);
    await rememberFolder(folder);
    setRec(next);
    if (isFirebaseConfigured && isSignedIn()) {
      // The cloud copy carries the folder in its path, so a move is a
      // re-upload — and the old path has to go, or the API lists the
      // recording twice, once with its stale folder.
      await uploadRecording(next, { skipAudio: !!next.mergedInCloud }).catch(() => {});
      await deleteRemoteRecording(from).catch(() => {});
    }
    setBusy("");
  }

  /**
   * The language pins what AssemblyAI transcribes in — a wrong pin produces
   * phonetic nonsense rather than a rough transcript — so changing it offers to
   * run again. "Auto" means detect, which is what a forgotten setting should be.
   */
  async function changeLanguage(language: string) {
    if (language === rec.language) return;
    const preview = touch({ ...rec, language }, "language");
    await recordEdit(preview, { language });
    const next = await commitMeta(rec, (cur) => adopt(cur, preview, ["language"]));
    setRec(next);
    await sendEdits(next);
    if (rec.transcriptStatus === "done") {
      Alert.alert(
        "Language changed",
        `The transcript was made in ${rec.language || "auto"}. Run it again in ${
          language === "Auto" ? "auto-detect" : language
        }?`,
        [
          { text: "Later", style: "cancel" },
          { text: "Transcribe again", onPress: () => doTranscribe(next) },
        ]
      );
    }
  }

  /** Filing for the archive. The folder is a real move; the rest is metadata. */
  async function savePlacement(p: Placement) {
    if (p.folder !== rec.folder) return changeFolder(p.folder, p);
    const preview = touch({ ...rec, private: p.private, tags: p.tags }, "private", "tags");
    await recordEdit(preview, { private: p.private, tags: p.tags });
    const next = await commitMeta(rec, (cur) => adopt(cur, preview, ["private", "tags"]));
    setRec(next);
    await sendEdits(next);
  }

  /**
   * Every view resolves a speaker through nameForSpeaker, where speakerMap wins
   * over the speakers list — so renaming a slot changed nothing at all while a
   * map existed: talk time, the transcript and the remap rows all kept the old
   * names. The rename now carries through the map by position, re-renders the
   * stored transcript, and pushes both to the cloud.
   */
  async function saveSpeakers(names: (string | null)[]) {
    const speakers = toSpeakers(names);
    const renamed: Record<string, string> = {};
    rec.speakers.forEach((old, i) => {
      if (speakers[i] && speakers[i] !== old) renamed[old] = speakers[i];
    });
    const nextMap = rec.speakerMap
      ? Object.fromEntries(
          Object.entries(rec.speakerMap)
            .map(([letter, name]) => [letter, renamed[name] ?? name])
            // a name that no longer exists would pin the letter to a ghost
            .filter(([, name]) => speakers.includes(name as string))
        )
      : undefined;
    let next: Recording = touch({ ...rec, speakers, speakerMap: nextMap }, "speakers");
    const patch: Record<string, unknown> = { speakers };
    // A renamed slot renames the letter(s) carrying the old name, as a user
    // label on each, so provenance follows the edit rather than being lost.
    for (const [l, n] of Object.entries(nextMap ?? {})) {
      if (rec.speakerMap?.[l] !== n) {
        next = setLabel(next, l, n as string, "user", (await getSettings()).ownerName);
        patch[`speakerLabels.${l}`] = next.speakerLabels?.[l] ?? null;
      }
    }
    await recordEdit(next, patch, shownRev);
    const preview = next;
    const keys = changedKeys(rec, preview);
    try {
      next = await commitMeta(rec, (cur) => ({ ...adopt(sameRev(cur), preview, keys), speakerMap: nextMap }));
    } catch {
      Alert.alert("New transcript arrived", "Rename speakers again on the new one.");
      return;
    }
    setRec(next);
    await rememberSpeakers(speakers.filter((s) => !/^Speaker \d+$/.test(s)));

    if (utterances && utterances.length) {
      const text = renderTranscript(utterances, speakers, nextMap);
      setTranscript(text);
      await writeTranscript({ ...next, transcriptLocalRev: loadedRev }, text);
    }
    await sendEdits(next);
  }

  function confirmDelete() {
    Alert.alert("Delete recording?", rec.base, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (isFirebaseConfigured && isSignedIn()) {
            if (await isCanonical()) await deleteRemote(rec.id);
            else await deleteRemoteRecording(rec).catch(() => {});
          }
          await deleteRecording(rec);
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
            onPress={() => doTranscribe()}
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

      <PlacementPicker
        value={{
          folder: rec.folder,
          private: !!rec.private,
          tags: rec.tags ?? [],
        }}
        onChange={savePlacement}
      />
      <Text style={styles.sectionLabel}>Language</Text>
      <View style={styles.langRow}>
        {DETAIL_LANGUAGES.map((l) => (
          <TouchableOpacity
            key={l}
            style={[styles.langChip, l === rec.language && styles.langChipOn]}
            onPress={() => changeLanguage(l)}
          >
            <Text
              style={[
                styles.langTxt,
                l === rec.language && styles.langTxtOn,
              ]}
            >
              {l}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

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
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  langChip: {
    backgroundColor: "#23262d",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  langChipOn: { backgroundColor: "#2f6fd0" },
  langTxt: { color: "#c9cdd3", fontSize: 12.5 },
  langTxtOn: { color: "#fff", fontWeight: "700" },
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
