import { useEffect, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import type { RecordingStatus } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import * as Clipboard from "expo-clipboard";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import SpeakerSelector from "../components/SpeakerSelector";
import FolderDropdown from "../components/FolderDropdown";
import Select from "../components/Select";
import QRCode from "../components/QRCode";
import SpeakerTimeline from "../components/SpeakerTimeline";
import { colorForLetter } from "../colors";
import { getSettings, getSpeakerHistory, getFolders } from "../storage";
import {
  isFirebaseConfigured,
  isSignedIn,
  createLiveShare,
  updateShare,
  unpublishShare,
  uploadToPath,
  mergeAudioSegments,
  downloadUrlForPath,
  liveSegmentPath,
  liveMergedPath,
} from "../firebase";
import {
  processStop,
  processStopLive,
  transcribeExisting,
  setRecordingInProgress,
} from "../recordingFlow";
import { logEvent } from "../log";
import {
  transcribeClipText,
  diarizeFromUrl,
  inferSpeakerMap,
  summarize,
  renderTranscript,
  nameForSpeaker,
  AAI_RATE_PER_HOUR,
  Utterance,
} from "../transcription";
import { PROMPT_PRESETS, DEFAULT_SUMMARY_PROMPT } from "../prompts";
import {
  isBatteryOptimized,
  isBatteryPromptSnoozed,
  snoozeBatteryPrompt,
  openUnrestrictedSettings,
} from "../battery";
import { DEFAULT_SETTINGS, INBOX, Recording, Settings } from "../types";
import {
  acquireWakelock,
  releaseWakelock,
} from "../../modules/mixtape-wakelock";

const SEGMENT_MS = 20000; // live segment length

// Global audio mode required while recording. The mode is GLOBAL mutable state,
// so it's re-asserted at every record start — any code that sets the mode
// without shouldPlayInBackground (expo-audio resets omitted fields) would
// otherwise make the native recorder pause the moment the screen locks.
const RECORDING_AUDIO_MODE = {
  playsInSilentMode: true,
  allowsRecording: true,
  allowsBackgroundRecording: true,
  // Without this, expo-audio pauses the recorder the moment the screen
  // locks (OnActivityEntersBackground). This is what keeps it running.
  shouldPlayInBackground: true,
};
import type { RootStackParamList } from "../../App";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const DURATION_PRESETS = [0.5, 1, 2, 3, 4];
const LANGUAGES = ["English", "French", "Arabic", "Spanish", "Other"];

function fmt(t: number) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export default function RecordScreen() {
  const navigation = useNavigation<Nav>();
  // The status listener delegates through a ref so it always runs the latest
  // closure (stop/refs), not the one captured on first render.
  const onRecStatusRef = useRef<(s: RecordingStatus) => void>(() => {});
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY, (s) =>
    onRecStatusRef.current(s)
  );

  const [lastRec, setLastRec] = useState<Recording | null>(null);
  const [count, setCount] = useState(1);
  const [names, setNames] = useState<(string | null)[]>([null]);
  const [folder, setFolder] = useState(INBOX);
  const [durationH, setDurationH] = useState(2);
  const [language, setLanguage] = useState("English");
  const [speakerHist, setSpeakerHist] = useState<string[]>([]);
  const [folderHist, setFolderHist] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [isRecording, setIsRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");

  const [liveMode, setLiveMode] = useState(false);
  const [shareLive, setShareLive] = useState(false);
  const [diarizeOn, setDiarizeOn] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [diarUtt, setDiarUtt] = useState<Utterance[]>([]);
  const [diarMap, setDiarMap] = useState<Record<string, string> | undefined>(
    undefined
  );
  const [diarPasses, setDiarPasses] = useState(0);
  const [diarCost, setDiarCost] = useState(0);
  const [diarBusy, setDiarBusy] = useState(false);
  const diarOnRef = useRef(false);
  const diarBusyRef = useRef(false);
  const diarDelayRef = useRef(30000);
  const diarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diarUploadedRef = useRef(0);
  const liveOn = useRef(false); // true while a live session is active
  const segUris = useRef<string[]>([]);
  const segTextRef = useRef<string[]>([]);
  const segTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recIdRef = useRef("");
  const liveShareId = useRef<string | null>(null);

  const [livePromptKey, setLivePromptKey] = useState("summary");
  const [livePrompt, setLivePrompt] = useState(DEFAULT_SUMMARY_PROMPT);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [liveAsking, setLiveAsking] = useState(false);
  const [liveUrl, setLiveUrl] = useState("");

  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const startMsRef = useRef(0);
  const recordingRef = useRef(false); // true only during a normal (non-live) take
  const capFiredRef = useRef(false); // native forDuration cap ended the take
  const durationRef = useRef(durationH);
  useEffect(() => {
    durationRef.current = durationH;
  }, [durationH]);

  // Fires when the native recorder finishes — including the forDuration hard cap
  // reached while the screen is off and the JS timer is suspended. Runs the save
  // flow that a manual stop() would. Guarded so a manual stop (which clears
  // recordingRef first) and live-mode segment stops don't double-trigger it.
  onRecStatusRef.current = (s: RecordingStatus) => {
    if (s.isFinished && recordingRef.current && !liveOn.current) {
      // Only a native-initiated finish reaches here with recordingRef still
      // true (a manual stop clears it first) — i.e. the forDuration cap.
      capFiredRef.current = true;
      stop();
    }
  };

  useEffect(() => {
    (async () => {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) Alert.alert("Microphone permission denied");
      await setAudioModeAsync(RECORDING_AUDIO_MODE);
      setSpeakerHist(await getSpeakerHistory());
      setFolderHist(await getFolders());
      setSettings(await getSettings());
    })();
  }, []);

  // Mirrors the recording state into module scope so the cache tools in
  // Settings never offer to delete the take that's still being written.
  function markRecording(on: boolean) {
    setIsRecording(on);
    setRecordingInProgress(on);
  }

  function stopTick() {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
  }

  function startTick() {
    stopTick();
    tick.current = setInterval(() => {
      // Use real elapsed time (native recorded duration / wall-clock), not a JS
      // counter — so the timer stays correct even when the screen is off and the
      // JS engine was suspended.
      let secs = elapsedRef.current + 1;
      if (liveOn.current) {
        secs = Math.floor((Date.now() - startMsRef.current) / 1000);
      } else {
        try {
          secs = Math.floor((recorder.getStatus().durationMillis || 0) / 1000);
        } catch {}
      }
      elapsedRef.current = secs;
      setElapsed(secs);
      // Enforce the cap for both modes. In normal mode the native forDuration
      // cap normally fires first; this catches live mode and is a foreground
      // fallback. stop() routes to stopLive() when a live session is active.
      if (secs >= durationRef.current * 3600) stop();
    }, 1000);
  }

  function resolveSpeakers(): string[] {
    return names.map((n, i) => (n && n.trim() ? n.trim() : `Speaker ${i + 1}`));
  }

  // Prompts to set Unrestricted battery so recording survives screen-off.
  // Returns true to proceed with recording, false if the user went to settings.
  async function batteryGate(): Promise<boolean> {
    if (!(await isBatteryOptimized())) return true;
    if (await isBatteryPromptSnoozed()) return true;
    return new Promise((resolve) => {
      Alert.alert(
        "Record with the screen off?",
        "Android may stop the recording when the screen locks. Set Mixtape to “Unrestricted” battery so it keeps recording in the background.",
        [
          {
            text: "Snooze 2 weeks",
            onPress: async () => {
              await snoozeBatteryPrompt();
              resolve(true);
            },
          },
          {
            text: "Record anyway",
            style: "cancel",
            onPress: () => resolve(true),
          },
          {
            text: "Set Unrestricted",
            onPress: async () => {
              await openUnrestrictedSettings();
              resolve(false);
            },
          },
        ],
        { cancelable: false }
      );
    });
  }

  async function start() {
    if (!(await batteryGate())) {
      setStatus("Set Mixtape to Unrestricted, then tap Start again.");
      return;
    }
    const s = await getSettings();
    setSettings(s);
    if (liveMode) {
      if (!s.assemblyAiKey) {
        Alert.alert("Live needs an AssemblyAI key (Settings).");
        return;
      }
      return startLive();
    }
    try {
      setStatus("");
      setElapsed(0);
      elapsedRef.current = 0;
      capFiredRef.current = false;
      // Re-assert the recording mode: the global mode may have been changed
      // since mount, and without shouldPlayInBackground the recorder pauses
      // on screen-off.
      await setAudioModeAsync(RECORDING_AUDIO_MODE);
      await recorder.prepareToRecordAsync();
      // forDuration is a native hard cap: the OS recorder stops itself at the
      // deadline even with the screen off / JS timer suspended. The JS interval
      // below is now just a display + foreground fallback.
      recorder.record({ forDuration: Math.round(durationH * 3600) });
      recordingRef.current = true;
      await activateKeepAwakeAsync();
      acquireWakelock();
      logEvent(`start normal: recording, cap=${durationH}h`);
      markRecording(true);
      setPaused(false);
      startTick();
    } catch (e: any) {
      Alert.alert("Could not start", String(e?.message ?? e));
    }
  }

  // ----- live (segmented) mode -----
  async function startLive() {
    setStatus("");
    setElapsed(0);
    elapsedRef.current = 0;
    // Same re-assert as start(): keeps segments recording with the screen off.
    try {
      await setAudioModeAsync(RECORDING_AUDIO_MODE);
    } catch {}
    setLiveText("");
    setDiarUtt([]);
    setDiarMap(undefined);
    setDiarPasses(0);
    setDiarCost(0);
    diarUploadedRef.current = 0;
    diarDelayRef.current = 30000;
    segUris.current = [];
    segTextRef.current = [];
    recIdRef.current = String(new Date().getTime());
    startMsRef.current = Date.now();
    liveShareId.current = null;
    liveOn.current = true;
    await activateKeepAwakeAsync();
    acquireWakelock();
    markRecording(true);
    setPaused(false);
    startTick();

    diarOnRef.current = false;
    if (diarizeOn) {
      if (isFirebaseConfigured && isSignedIn()) {
        diarOnRef.current = true;
        scheduleDiarization();
      } else {
        setStatus("Live diarization needs cloud sign-in — showing plain text only.");
      }
    }

    setLiveUrl("");
    if (shareLive && isFirebaseConfigured && isSignedIn()) {
      try {
        const { shareId, url } = await createLiveShare({
          base: "Live recording…",
          speakers: resolveSpeakers(),
          language,
        });
        liveShareId.current = shareId;
        setLiveUrl(url);
      } catch {
        setStatus("Couldn't create live link; recording anyway.");
      }
    }
    recordSegment();
  }

  function recordSegment() {
    (async () => {
      try {
        await recorder.prepareToRecordAsync();
        // Native backstop: if the JS roll timer is suspended (screen off / Doze)
        // the segment stops itself instead of recording forever. Set above
        // SEGMENT_MS so the normal JS roll always wins and this only fires on a
        // freeze — the same durability the normal-mode forDuration cap gives.
        recorder.record({ forDuration: Math.round(SEGMENT_MS / 1000) + 10 });
      } catch {}
      segTimer.current = setTimeout(() => rollSegment(false), SEGMENT_MS);
    })();
  }

  async function rollSegment(isFinal: boolean) {
    if (segTimer.current) {
      clearTimeout(segTimer.current);
      segTimer.current = null;
    }
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri ?? null;
    } catch {}

    let dest: string | null = null;
    if (uri) {
      dest = `${FileSystem.cacheDirectory}seg_${recIdRef.current}_${segUris.current.length}.m4a`;
      try {
        await FileSystem.copyAsync({ from: uri, to: dest });
        segUris.current.push(dest);
      } catch {
        dest = null;
      }
    }

    if (!isFinal && liveOn.current) recordSegment(); // start next immediately

    if (dest) {
      const job = transcribeClipText(dest, language, settings)
        .then((txt) => {
          if (!txt.trim()) return;
          segTextRef.current = [...segTextRef.current, txt.trim()];
          const joined = segTextRef.current.join(" ");
          setLiveText(joined);
          if (liveShareId.current) {
            updateShare(liveShareId.current, {
              liveText: joined,
              durationSeconds: elapsedRef.current,
            }).catch(() => {});
          }
        })
        .catch(() => {});
      if (isFinal) await job; // wait for the last segment before saving
    }
  }

  // ----- live diarization (Option A: exponential-backoff full re-diarization) -----
  function scheduleDiarization() {
    if (diarTimer.current) clearTimeout(diarTimer.current);
    diarTimer.current = setTimeout(async () => {
      await runDiarizationPass();
      if (diarOnRef.current && liveOn.current) {
        // widen the interval each time so cost stays bounded on long recordings.
        diarDelayRef.current = Math.min(diarDelayRef.current * 2, 1800000);
        scheduleDiarization();
      }
    }, diarDelayRef.current);
  }

  async function runDiarizationPass() {
    if (diarBusyRef.current || !liveOn.current) return;
    const n = segUris.current.length;
    if (n < 2) return; // need a couple segments before diarization is meaningful
    diarBusyRef.current = true;
    setDiarBusy(true);
    try {
      const id = recIdRef.current;
      for (let i = diarUploadedRef.current; i < n; i++) {
        await uploadToPath(segUris.current[i], liveSegmentPath(id, i));
      }
      diarUploadedRef.current = n;
      const remote = Array.from({ length: n }, (_, i) => liveSegmentPath(id, i));
      await mergeAudioSegments(remote, liveMergedPath(id));
      const url = await downloadUrlForPath(liveMergedPath(id));
      const { utterances, audioDurationSec } = await diarizeFromUrl(
        url,
        language,
        settings,
        resolveSpeakers().length
      );
      logEvent(`diar pass segs=${n} utt=${utterances.length} dur=${audioDurationSec}`);
      if (liveOn.current && utterances.length) {
        // Map AAI's A/B labels to the right names from what people actually say.
        const speakerMap = await inferSpeakerMap(
          utterances,
          resolveSpeakers(),
          settings
        );
        setDiarUtt(utterances);
        setDiarMap(speakerMap);
        setDiarPasses((p) => p + 1);
        setDiarCost((c) => c + (audioDurationSec / 3600) * AAI_RATE_PER_HOUR);
        if (liveShareId.current) {
          updateShare(liveShareId.current, {
            utterances,
            speakers: resolveSpeakers(),
            speakerMap: speakerMap ?? null,
            durationSeconds: elapsedRef.current,
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      logEvent(`diar pass ERROR ${String(e?.message ?? e)}`);
    } finally {
      diarBusyRef.current = false;
      setDiarBusy(false);
    }
  }

  function stopDiarization() {
    diarOnRef.current = false;
    if (diarTimer.current) {
      clearTimeout(diarTimer.current);
      diarTimer.current = null;
    }
  }

  async function copyLiveTranscript() {
    const text = diarUtt.length
      ? renderTranscript(diarUtt, resolveSpeakers(), diarMap)
      : liveText;
    if (!text.trim()) return;
    await Clipboard.setStringAsync(text);
    setStatus("Live transcript copied.");
  }

  async function runLivePrompt() {
    if (!settings.anthropicKey) {
      Alert.alert("Add your Anthropic key in Settings first");
      return;
    }
    if (!liveText.trim()) return;
    setLiveAsking(true);
    try {
      setLiveAnswer(await summarize(liveText, livePrompt, settings));
    } catch (e: any) {
      Alert.alert("Failed", String(e?.message ?? e));
    }
    setLiveAsking(false);
  }

  function pause() {
    stopTick();
    try {
      recorder.pause();
    } catch {}
    setPaused(true);
  }

  function resume() {
    try {
      // Re-arm the native cap for the time that's left, so the limit still holds
      // after a pause/resume.
      const left = Math.round(durationRef.current * 3600 - elapsedRef.current);
      recorder.record({ forDuration: Math.max(1, left) });
    } catch {}
    setPaused(false);
    startTick();
  }

  /**
   * Discarding throws away however long you've been recording, and one stray
   * tap used to do it with no way back, so it asks first. The audio itself
   * survives in the cache either way — Settings ▸ Developer can import it back
   * until Android reclaims the space.
   */
  function cancel() {
    Alert.alert(
      "Discard this recording?",
      `${fmt(elapsedRef.current)} recorded. It won't be saved to your library.`,
      [
        { text: "Keep recording", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => discard() },
      ]
    );
  }

  async function discard() {
    recordingRef.current = false;
    if (liveOn.current) {
      liveOn.current = false;
      stopDiarization();
      if (segTimer.current) {
        clearTimeout(segTimer.current);
        segTimer.current = null;
      }
      if (liveShareId.current) {
        unpublishShare(liveShareId.current).catch(() => {});
        liveShareId.current = null;
      }
    }
    stopTick();
    try {
      await recorder.stop();
    } catch {}
    deactivateKeepAwake();
    releaseWakelock();
    markRecording(false);
    setPaused(false);
    setLiveText("");
    setDiarUtt([]);
    setLiveAnswer("");
    setLiveUrl("");
    setStatus("Recording discarded.");
  }

  async function stop() {
    if (liveOn.current) return stopLive();
    if (!recordingRef.current) return; // already stopping/stopped (idempotent)
    recordingRef.current = false;
    stopTick();
    let seconds = elapsedRef.current;
    try {
      // After a native forDuration stop the recorder is already reset and
      // reads 0 — never let that overwrite the ticked value.
      const derived = Math.floor((recorder.getStatus().durationMillis || 0) / 1000);
      if (derived > 0) seconds = derived;
    } catch {}
    if (capFiredRef.current) {
      // The native cap stopped it: the planned limit IS the duration (the JS
      // tick may have been suspended the whole time, so elapsedRef is stale).
      seconds = Math.max(seconds, Math.round(durationRef.current * 3600));
      capFiredRef.current = false;
    }
    setPaused(false);
    try {
      await recorder.stop();
    } catch {}
    deactivateKeepAwake();
    releaseWakelock();
    markRecording(false);
    const uri = recorder.uri;
    logEvent(`stop normal: durationMillis-derived=${seconds}s uri=${!!uri}`);
    if (!uri) {
      setStatus("No audio captured.");
      return;
    }
    setStatus("Saving…");
    try {
      const rec = await processStop({
        cacheUri: uri,
        durationSeconds: seconds,
        plannedDurationHours: durationH,
        speakers: resolveSpeakers(),
        folder,
        language,
        settings,
      });
      setStatus(
        `Saved: ${rec.base}\nTranscript: ${rec.transcriptStatus} · Upload: ${rec.uploadStatus}`
      );
      setLastRec(rec);
      setSpeakerHist(await getSpeakerHistory());
      setFolderHist(await getFolders());
    } catch (e: any) {
      setStatus("Failed: " + String(e?.message ?? e));
    }
  }

  async function stopLive() {
    const wasDiarizing = diarOnRef.current;
    liveOn.current = false;
    stopDiarization();
    stopTick();
    const seconds = elapsedRef.current;
    setStatus("Finishing last segment…");
    await rollSegment(true);
    deactivateKeepAwake();
    releaseWakelock();
    markRecording(false);
    if (segUris.current.length === 0) {
      setStatus("No audio captured.");
      return;
    }
    setStatus("Merging segments & saving…");
    try {
      const rec = await processStopLive({
        segmentUris: segUris.current,
        liveText: segTextRef.current.join(" "),
        durationSeconds: seconds,
        speakers: resolveSpeakers(),
        folder,
        language,
        settings,
        shareId: liveShareId.current ?? undefined,
      });
      if (liveShareId.current) {
        updateShare(liveShareId.current, {
          base: rec.base,
          speakers: rec.speakers,
          live: false,
        }).catch(() => {});
      }
      setLastRec(rec);
      setLiveText("");
      setLiveUrl("");
      // Auto-transcribe the merged recording (accurate diarized speakers + topic)
      // whenever an AssemblyAI key is set — same as a normal recording, so live
      // recordings don't sit untranscribed waiting for a manual Re-transcribe.
      const eligible = !!settings.assemblyAiKey;
      if (
        (wasDiarizing || eligible) &&
        !rec.mergePending &&
        rec.transcriptStatus !== "pending"
      ) {
        setStatus("Transcribing…");
        try {
          const done = await transcribeExisting(rec, settings);
          setLastRec(done);
          setStatus(`Saved: ${done.base}\nTranscribed · Upload: ${done.uploadStatus}`);
        } catch (e: any) {
          setStatus(
            `Saved: ${rec.base}\nTranscription failed (${String(
              e?.message ?? e
            )}) — reopen the app or tap "Re-transcribe"`
          );
        }
      } else {
        setStatus(
          `Saved: ${rec.base}\nUpload: ${rec.uploadStatus}` +
            (eligible ? "" : " · add an AssemblyAI key to transcribe")
        );
      }
      setDiarUtt([]);
      setSpeakerHist(await getSpeakerHistory());
      setFolderHist(await getFolders());
    } catch (e: any) {
      setStatus("Live save failed: " + String(e?.message ?? e));
    }
  }

  async function copyLiveUrl() {
    if (!liveUrl) return;
    await Clipboard.setStringAsync(liveUrl);
    setStatus("Live link copied.");
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Record</Text>

      {isRecording && (
        <View style={styles.timerBox}>
          <Text style={[styles.elapsed, paused && styles.elapsedPaused]}>
            {fmt(elapsed)}
          </Text>
          <Text style={styles.remaining}>
            {liveOn.current
              ? "🔴 live transcribing"
              : paused
              ? "paused"
              : `auto-stops in ${fmt(Math.max(0, durationH * 3600 - elapsed))}`}
          </Text>
          <Text style={styles.metaLine}>adjust anything below — live</Text>
        </View>
      )}

      {liveUrl ? (
        <View style={styles.shareBox}>
          <Text style={styles.shareLabel}>Live link — tap to copy</Text>
          <TouchableOpacity onPress={copyLiveUrl}>
            <Text style={styles.shareUrl} numberOfLines={1}>
              {liveUrl}
            </Text>
          </TouchableOpacity>
          <View style={styles.qrWrap}>
            <QRCode value={liveUrl} size={150} />
          </View>
        </View>
      ) : null}

      {liveOn.current && (liveText.length > 0 || diarUtt.length > 0) && (
        <View style={styles.liveBox}>
          <Text style={styles.liveHint}>
            {diarUtt.length > 0
              ? `🎨 speakers aligned · ${diarPasses} pass${
                  diarPasses === 1 ? "" : "es"
                } · ~$${diarCost.toFixed(2)}${diarBusy ? " · refreshing…" : ""}`
              : diarOnRef.current
              ? `≈ live text — aligning speakers${diarBusy ? " (running…)" : " soon…"}`
              : "≈ live text — speaker names resolve when you stop"}
          </Text>
          {diarUtt.length > 0 && (
            <View style={{ marginVertical: 8 }}>
              <SpeakerTimeline
                utterances={diarUtt}
                nameFor={(l) => nameForSpeaker(l, resolveSpeakers(), diarMap)}
              />
            </View>
          )}
          <ScrollView style={styles.scrollBox} nestedScrollEnabled>
            {diarUtt.length > 0 ? (
              diarUtt.map((u, i) => (
                <Text key={i} style={styles.liveLine}>
                  <Text
                    style={{
                      color: colorForLetter(u.speaker),
                      fontWeight: "700",
                    }}
                  >
                    {nameForSpeaker(u.speaker, resolveSpeakers(), diarMap)}:{" "}
                  </Text>
                  {u.text}
                </Text>
              ))
            ) : (
              <Text style={styles.liveLine}>{liveText}</Text>
            )}
          </ScrollView>

          <TouchableOpacity style={styles.liveCopy} onPress={copyLiveTranscript}>
            <Text style={styles.liveCopyTxt}>Copy transcript so far</Text>
          </TouchableOpacity>
          <View style={{ marginTop: 10 }}>
            <Select
              value={livePromptKey}
              options={PROMPT_PRESETS.map((p) => ({
                label: p.label,
                value: p.key,
              }))}
              onChange={(key) => {
                setLivePromptKey(key);
                if (key === "custom") setLivePrompt("");
                else {
                  const p = PROMPT_PRESETS.find((x) => x.key === key);
                  if (p && p.text) setLivePrompt(p.text);
                }
              }}
            />
          </View>
          <TouchableOpacity
            style={styles.liveAskBtn}
            onPress={runLivePrompt}
            disabled={liveAsking}
          >
            <Text style={styles.recTxt}>
              {liveAsking ? "Thinking…" : "Run on live transcript"}
            </Text>
          </TouchableOpacity>
          {liveAnswer ? (
            <ScrollView style={styles.answerScroll} nestedScrollEnabled>
              <Text style={styles.liveAnswer}>{liveAnswer}</Text>
            </ScrollView>
          ) : null}
        </View>
      )}

      {!isRecording && (
        <>
          <View style={styles.liveToggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Live transcribe (beta)</Text>
              <Text style={styles.metaLine}>
                See text as you record. Uses AssemblyAI; final speakers resolve
                on stop.
              </Text>
            </View>
            <Switch value={liveMode} onValueChange={setLiveMode} />
          </View>
          {liveMode && (
            <View style={styles.liveToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Share live link</Text>
                <Text style={styles.metaLine}>
                  Get a public URL that updates as you talk (needs sign-in;
                  updates while the app is open).
                </Text>
              </View>
              <Switch value={shareLive} onValueChange={setShareLive} />
            </View>
          )}
          {liveMode && (
            <View style={styles.liveToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Align speakers live</Text>
                <Text style={styles.metaLine}>
                  Re-runs full diarization on a widening interval (30s → 1m → 2m…)
                  so speaker colors align across the whole recording, then a final
                  accurate pass on stop. Needs sign-in · adds ≈ $
                  {(durationH * 0.48).toFixed(2)} for {durationH}h.
                </Text>
              </View>
              <Switch value={diarizeOn} onValueChange={setDiarizeOn} />
            </View>
          )}
        </>
      )}

      <SpeakerSelector
        count={count}
        names={names}
        history={speakerHist}
        onChange={(c, n) => {
          setCount(c);
          setNames(n);
        }}
      />

      <FolderDropdown value={folder} options={folderHist} onChange={setFolder} />

      <Text style={styles.label}>
        {isRecording ? "Time limit (hours)" : "Max duration (hours)"}
      </Text>
      <View style={styles.wrap}>
        {DURATION_PRESETS.map((h) => (
          <TouchableOpacity
            key={h}
            style={[styles.chip, durationH === h && styles.chipOn]}
            onPress={() => setDurationH(h)}
          >
            <Text style={[styles.chipTxt, durationH === h && styles.chipTxtOn]}>
              {h}h
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Language</Text>
      <View style={styles.wrap}>
        {LANGUAGES.map((l) => (
          <TouchableOpacity
            key={l}
            style={[styles.chip, language === l && styles.chipOn]}
            onPress={() => setLanguage(l)}
          >
            <Text style={[styles.chipTxt, language === l && styles.chipTxtOn]}>
              {l}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {isRecording ? (
        <>
          {liveOn.current ? (
            <TouchableOpacity
              style={[styles.recBtn, styles.recBtnOn]}
              onPress={stop}
            >
              <Text style={styles.recTxt}>Stop & save</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.controlRow}>
              <TouchableOpacity
                style={[styles.pauseBtn]}
                onPress={paused ? resume : pause}
              >
                <Text style={styles.recTxt}>{paused ? "Resume" : "Pause"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.recBtn, styles.recBtnOn, styles.flexBtn]}
                onPress={stop}
              >
                <Text style={styles.recTxt}>Stop & save</Text>
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity style={styles.cancelBtn} onPress={cancel}>
            <Text style={styles.cancelTxt}>Cancel (discard)</Text>
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity style={styles.recBtn} onPress={start}>
          <Text style={styles.recTxt}>
            {liveMode ? "Start live recording" : "Start recording"}
          </Text>
        </TouchableOpacity>
      )}

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {lastRec ? (
        <TouchableOpacity
          style={styles.viewBtn}
          onPress={() =>
            navigation.navigate("Detail", { rec: lastRec })
          }
        >
          <Text style={styles.viewTxt}>View recording →</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: "#0f1115", padding: 18, paddingTop: 48 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  label: {
    color: "#9aa0a6",
    fontSize: 12,
    marginTop: 12,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: "#23262d",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
  },
  chipOn: { backgroundColor: "#3b82f6" },
  chipTxt: { color: "#cdd1d6", fontSize: 14 },
  chipTxtOn: { color: "#fff", fontWeight: "700" },
  liveToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 12,
  },
  switchLabel: { color: "#fff", fontSize: 15, fontWeight: "600" },
  shareBox: {
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 14,
    marginTop: 14,
    alignItems: "center",
  },
  shareLabel: { color: "#9aa0a6", fontSize: 12, marginBottom: 6 },
  shareUrl: { color: "#60a5fa", fontSize: 13, marginBottom: 12 },
  qrWrap: { marginTop: 2 },
  liveBox: {
    backgroundColor: "#1a1d23",
    borderRadius: 12,
    padding: 14,
    marginTop: 14,
  },
  liveHint: { color: "#6b7280", fontSize: 12, marginTop: 8, marginBottom: 4 },
  scrollBox: { maxHeight: 200 },
  liveLine: { color: "#cdd1d6", fontSize: 14, lineHeight: 20, marginTop: 6 },
  liveCopy: {
    backgroundColor: "#23262d",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 12,
  },
  liveCopyTxt: { color: "#fff", fontWeight: "600" },
  liveAskBtn: {
    backgroundColor: "#3b82f6",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 10,
  },
  answerScroll: { maxHeight: 200, marginTop: 12 },
  liveAnswer: {
    color: "#cdd1d6",
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: "#0f1115",
    borderRadius: 10,
    padding: 12,
  },
  timerBox: { alignItems: "center", marginVertical: 18 },
  elapsed: { color: "#fff", fontSize: 44, fontWeight: "200" },
  elapsedPaused: { color: "#fbbf24" },
  remaining: { color: "#9aa0a6", fontSize: 14, marginTop: 6 },
  metaLine: { color: "#6b7280", fontSize: 13, marginTop: 8 },
  controlRow: { flexDirection: "row", gap: 12, marginTop: 18 },
  pauseBtn: {
    backgroundColor: "#23262d",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    width: 110,
  },
  flexBtn: { flex: 1, marginTop: 0 },
  recBtn: {
    backgroundColor: "#3b82f6",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 18,
  },
  recBtnOn: { backgroundColor: "#ef4444" },
  recTxt: { color: "#fff", fontSize: 16, fontWeight: "700" },
  cancelBtn: { paddingVertical: 12, alignItems: "center", marginTop: 6 },
  cancelTxt: { color: "#9aa0a6", fontSize: 14, fontWeight: "600" },
  status: { color: "#9aa0a6", fontSize: 13, marginTop: 16, lineHeight: 19 },
  viewBtn: {
    backgroundColor: "#23262d",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 12,
  },
  viewTxt: { color: "#3b82f6", fontWeight: "700", fontSize: 15 },
});
