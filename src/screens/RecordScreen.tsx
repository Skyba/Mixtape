import { markPending, clearPending } from "../pendingTake";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { AudioModule, RecordingPresets, setAudioModeAsync } from "expo-audio";
import type { AudioRecorder, RecordingStatus } from "expo-audio";
import { createRecordingOptions } from "expo-audio/build/utils/options";
import * as FileSystem from "expo-file-system/legacy";
import * as Clipboard from "expo-clipboard";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import SpeakerSelector from "../components/SpeakerSelector";
import PlacementPicker, { Placement } from "../components/PlacementPicker";
import Select from "../components/Select";
import QRCode from "../components/QRCode";
import SpeakerTimeline from "../components/SpeakerTimeline";
import { colorForLetter } from "../colors";
import { getSettings, getSpeakerHistory } from "../storage";
import {
  isFirebaseConfigured,
  isSignedIn,
  createLiveShare,
  updateShare,
  unpublishShare,
  uploadToPath,
  downloadUrlForPath,
  liveSegmentPath,
  liveMergedPath,
} from "../firebase";
import {
  processStop,
  processStopLive,
  transcribeExisting,
  setRecordingInProgress,
  isRecordingInProgress,
  flushLog,
} from "../recordingFlow";
import { logEvent } from "../log";
import { SEGMENT_DIR } from "../recover";
import { isPlayable } from "../mp4";
import { isCanonical, mergeAudioSegments } from "../cloud";
import { alwaysPrivate } from "../placement";
import { capturePlace } from "../place";
import type { Place } from "../place";
import { notify } from "../notifications";
import { Preset, deletePreset, getPresets, savePreset } from "../presets";
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
  AudioInput,
  acquireWakelock,
  externalInput,
  releaseWakelock,
  watchSilence,
  cancelSegment,
  hasNativeSegmentTimer,
  onSegmentDue,
  scheduleSegment,
  startTakeService,
  updateTakeService,
  stopTakeService,
  hasActivity,
  consumeStopRequest,
  onStopRequested,
} from "../../modules/mixtape-wakelock";

const SEGMENT_MS = 20000; // live segment length
// Normal recordings are written in chunks this long. A file is only readable
// once the recorder closes it, so a process death (phone restart, flat battery)
// destroys whatever is still open — chunking caps that loss at one chunk
// instead of the whole session. Chunks are stitched back into one file at stop.
const SAFETY_CHUNK_MS = 180000; // 3 minutes

// Global audio mode required while recording. The mode is GLOBAL mutable state,
// so it's re-asserted at every record start — any code that sets the mode
// without shouldPlayInBackground (expo-audio resets omitted fields) would
// otherwise make the native recorder pause the moment the screen locks.
// Mono. The phone's own mic already hands us the same room mix on both
// channels, so stereo bought nothing — and a mono-only USB mic can be ruled
// out entirely when the recorder insists on two channels, which silently
// sends the take back to the built-in mic. Half the bytes, too.
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  // Needed for the dead-input check at each segment boundary below.
  isMeteringEnabled: true,
};

// NOTE: getStatus().metering is not usable as a silence check here. A 30-minute
// take whose segments all measured -22 to -25 dBFS in the file reported -160.0
// at every probe, so acting on it switched a working dongle to the built-in mic
// on the first boundary. The level is still logged, to see whether it ever
// becomes meaningful, but nothing decides anything on it. isClientSilenced,
// which is a real signal, still covers the case of another app taking the mic.
// There is deliberately no settle delay before re-preparing. It was a guess at
// the USB failure, it did not fix it, and it was a JS setTimeout sitting in the
// roll path — which React Native suspends in the background, defeating the
// whole point of driving the roll natively. Single-file mode is the answer for
// the dongle; this path must contain no JS timer at all.
// How long after a segment starts to look at its level. Long enough for the
// route to settle, short enough to lose one segment rather than a session.
const SEG_PROBE_MS = 2000;
// Single-file mode has no boundary to notice a dead recorder at, so the file
// itself is the evidence: a take once wrote 7 minutes of a 2-hour session and
// reported the full duration, and nothing saw it. Checked on the native tick,
// so it still runs with the screen off.
const LIVENESS_MS = 60000;
// Three checks with no growth at all. A live recorder writes ~16KB/s, so three
// minutes of exactly zero bytes is not buffering — it has stopped.
const LIVENESS_DEAD_CHECKS = 3;

const RECORDING_AUDIO_MODE = {
  playsInSilentMode: true,
  allowsRecording: true,
  allowsBackgroundRecording: true,
  // Without this, expo-audio pauses the recorder the moment the screen
  // locks (OnActivityEntersBackground). This is what keeps it running.
  shouldPlayInBackground: true,
};
// With the app's own microphone service held for the take, expo-audio's must
// stay out of it: it stops itself at every segment boundary and is refused
// when it tries to start again in the background.
const OWN_SERVICE_AUDIO_MODE = {
  ...RECORDING_AUDIO_MODE,
  allowsBackgroundRecording: false,
};
// Single-file takes enforce the time limit on the native tick, so a limit
// raised mid-take holds. The recorder's own timer stays only as a backstop
// past the longest limit, because it cannot be moved once started.
const BACKSTOP_S = 10 * 3600 + 300;
// How soon to try again when no segment would arm, rather than a whole chunk.
const ARM_RETRY_MS = 5000;

// The recorder lives at module scope, not in useAudioRecorder: the hook
// releases it when the screen unmounts, and a swipe from recents, a render
// error in any tab or the storage move all unmount it — which reset the
// recorder mid-file and ended the take with nothing saved. Created on first
// mount: the constructor needs an activity, which a headless start lacks.
let sharedRecorder: AudioRecorder | null = null;
const noop = () => {};
// Native events go to whichever screen instance currently owns the take.
const handlers: {
  status: (s: RecordingStatus) => void;
  segmentDue: (token: number) => void;
  stopRequested: () => void;
} = { status: noop, segmentDue: noop, stopRequested: noop };
// Set when the screen unmounted mid-take with no activity to stop the
// recorder through (a swipe from recents). The next mount finishes it.
let orphanFinish: (() => Promise<void>) | null = null;

function getRecorder(): AudioRecorder {
  if (!sharedRecorder) {
    sharedRecorder = new AudioModule.AudioRecorder(
      createRecordingOptions(RECORDING_OPTIONS)
    );
    sharedRecorder.addListener("recordingStatusUpdate", (s) => handlers.status(s));
    onSegmentDue((t) => handlers.segmentDue(t));
    onStopRequested(() => handlers.stopRequested());
  }
  return sharedRecorder;
}
import type { RootStackParamList } from "../../App";

type Nav = NativeStackNavigationProp<RootStackParamList>;

// 10h is AssemblyAI's ceiling — anything longer can't be transcribed at all,
// so it's the top of the range rather than a value you can overshoot.
const DURATION_PRESETS = [0.5, 1, 2, 3, 5, 10];
// "Auto" is first and is the default: a forgotten language setting used to
// force the wrong one onto the whole recording.
const LANGUAGES = ["Auto", "English", "French", "Spanish", "German", "Arabic"];

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
  const [recorder] = useState(getRecorder);

  const [lastRec, setLastRec] = useState<Recording | null>(null);
  const [count, setCount] = useState(1);
  const [names, setNames] = useState<(string | null)[]>([null]);
  const [folder, setFolder] = useState(INBOX);
  const [isPrivate, setIsPrivate] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  // One line of context for the archive. Editable while recording, because
  // what a conversation turns out to be about is often clear only part way in.
  const [note, setNote] = useState("");
  // Is the owner one of the voices? Default yes; one tap says no for a
  // conference or someone else's meeting. Answered here because this is the
  // one moment it is certainly known. Never gates recording.

  const [durationH, setDurationH] = useState(2);
  const [language, setLanguage] = useState("Auto");
  const [speakerHist, setSpeakerHist] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [presets, setPresets] = useState<Preset[]>([]);
  // The preset the current settings came from, if any. Deliberately not
  // persisted: arriving at the screen starts with nothing selected.
  const [applied, setApplied] = useState<Preset | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  // The plugged-in mic, or null when we're on the phone's own mic.
  const [mic, setMic] = useState<AudioInput | null>(null);
  const extRef = useRef<AudioInput | null>(null);
  // Fallback for builds without the native input list: what the recorder
  // actually ended up routed to, which is only knowable mid-take.
  const [routed, setRouted] = useState<{ name: string; ext: boolean } | null>(
    null
  );

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
  const chunkedRef = useRef(false); // normal take recording in safety chunks
  const segMsRef = useRef(SEGMENT_MS); // current chunk length (live vs safety)
  const rollingRef = useRef(false); // a roll is in flight; ignore native finishes
  const pausedRef = useRef(false); // live mode: stop the segment chain at a roll
  const pausedMsRef = useRef(0); // live mode: total time spent paused
  const pauseStartRef = useRef(0);
  // Files this screen stopped itself. Their "finished" event can arrive after
  // the next segment has started; anything else finishing is not ours.
  const ownStopsRef = useRef(new Set<string>());
  const segLiveRef = useRef(false); // a segment is prepared or recording
  const takeInputRef = useRef<string | undefined>(undefined); // mic at take start
  // Fixed for the take, unlike liveOn/chunkedRef, which drop at Stop while
  // the marker still has to describe the segments until the save.
  const takeModeRef = useRef<"single" | "chunked" | "live">("single");
  const takeSeqRef = useRef(0); // bumped by every beginTake
  const silenceWarnedRef = useRef(false); // isClientSilenced warning, once per take
  const micFallbackWarnedRef = useRef(false); // mic trouble warning, once per take
  const segArmedAtRef = useRef(0); // when the current segment started recording
  const liveSizeRef = useRef(0); // last observed size of the single-file take
  const liveStuckRef = useRef(0); // consecutive checks with no growth
  const liveWarnedRef = useRef(false);
  // Bumped by every start, stop, pause and discard. Async work started before
  // the bump must not touch the recorder afterwards: without this, a segment
  // armed during a stop would start recording after the take had ended.
  const takeGenRef = useRef(0);
  // Identifies the tick the recorder is currently waiting on. A tick carrying
  // any other token belongs to a boundary that has already passed, or to a
  // take that has ended, and must be ignored — cancellation cannot retract an
  // event that has already been emitted.
  const segTokenRef = useRef(0);
  // One roll at a time. Stop and Pause both call rollSegment directly, and two
  // rolls overlapping would stop the same recorder twice and copy the same
  // source file twice, duplicating or losing a segment.
  const rollQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Captured when a take starts, so the fix reflects where it happened rather
  // than where the phone was when it stopped. Never blocks starting.
  const placeRef = useRef<Place | undefined>(undefined);
  const durationRef = useRef(durationH);
  useEffect(() => {
    durationRef.current = durationH;
  }, [durationH]);

  // Fires when the native recorder finishes. Our own stops are recognised by
  // their file; anything else is the recorder's backstop timer, a recorder
  // error, or expo-audio's notification Stop on a build without our service.
  // None of those is the time limit, so none is saved as the planned length.
  onRecStatusRef.current = (s: RecordingStatus) => {
    if (!s.isFinished) return;
    if (s.url && ownStopsRef.current.delete(s.url)) return;
    if (recordingRef.current && !liveOn.current && !chunkedRef.current) {
      logEvent(
        s.hasError
          ? `recorder error, saving what was recorded: ${s.error ?? "unknown"}`
          : "recorder stopped from outside (backstop or notification), saving"
      );
      stop();
      return;
    }
    if (!(liveOn.current || chunkedRef.current) || pausedRef.current || rollingRef.current) return;
    if (s.hasError) {
      logEvent(`seg${segUris.current.length} recorder error: ${s.error ?? "unknown"}; rolling`);
      rollSegment(false);
      return;
    }
    // The backstop fires 10 s after the segment was due. A finish well
    // before that is someone stopping the recording, and restarting the
    // chain would record on after the user asked it to stop.
    if (Date.now() - segArmedAtRef.current < segMsRef.current) {
      logEvent("recorder stopped from outside mid-segment, ending the take");
      stop();
      return;
    }
    // A chunk hit its native backstop because the roll was late (Doze).
    // Roll it now rather than letting the chain die silently.
    rollSegment(false);
  };

  // The notification's Stop & save.
  const onStopRequestRef = useRef<() => void>(() => {});
  onStopRequestRef.current = () => {
    if (!(recordingRef.current || liveOn.current || chunkedRef.current)) return;
    logEvent("stop from the notification");
    stop();
  };
  const stopRef = useRef<() => Promise<void>>(async () => {});
  stopRef.current = stop;
  const markerRef = useRef<() => Promise<void>>(async () => {});
  markerRef.current = writeMarker;

  useEffect(() => {
    handlers.status = (s) => onRecStatusRef.current(s);
    handlers.segmentDue = (t) => onSegmentDueRef.current(t);
    handlers.stopRequested = () => {
      consumeStopRequest();
      onStopRequestRef.current();
    };
    // A Stop tapped before this screen existed belongs to the take finished
    // just below, or to none.
    consumeStopRequest();
    if (orphanFinish) {
      const finish = orphanFinish;
      orphanFinish = null;
      logEvent("finishing the take a closed record screen left running");
      finish().catch(() => {});
    }
    return () => {
      if (!(recordingRef.current || liveOn.current || chunkedRef.current)) return;
      logEvent("record screen unmounted mid-take");
      const finish = () => stopRef.current();
      if (hasActivity()) {
        // A render error, the storage move, a recreated activity: the
        // recorder can still be stopped, so save the take now.
        finish().catch(() => {});
        return;
      }
      // No activity, so expo-audio refuses every recorder call. A
      // single-file take keeps recording; a segmented one stops at the end
      // of its segment. Either way it is saved when the app is reopened.
      handlers.status = noop;
      handlers.segmentDue = noop;
      handlers.stopRequested = noop;
      cancelSegment();
      orphanFinish = finish;
      updateTakeService("Open Mixtape to save this recording");
    };
  }, []);

  useEffect(() => {
    (async () => {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) Alert.alert("Microphone permission denied");
      // Remounted mid-take: the take set its own mode, keep it.
      if (!isRecordingInProgress()) await setAudioModeAsync(RECORDING_AUDIO_MODE);
      setSpeakerHist(await getSpeakerHistory());
      setSettings(await getSettings());
      setPresets(await getPresets());
    })();
  }, []);

  // The native tick is the only thing that still fires once the activity is
  // backgrounded. Guarded on elapsed time rather than trusting the tick: a
  // delayed or repeated event must not cut a segment short.
  const onSegmentDueRef = useRef<(token: number) => void>(() => {});
  onSegmentDueRef.current = (token: number) => {
    if (token !== segTokenRef.current) return; // a tick that already passed
    if (liveOn.current || chunkedRef.current) {
      if (rollingRef.current || pausedRef.current) return;
      rollSegment(false);
      return;
    }
    // Single-file mode: the same tick is the liveness check and the time
    // limit, which therefore follows a limit changed mid-take.
    if (!recordingRef.current) return;
    if (!pausedRef.current && activeMs() >= durationRef.current * 3600000) {
      logEvent(`cap ${durationRef.current}h reached → stopping`);
      stop();
      return;
    }
    // While paused the file legitimately stops growing. Keep the chain alive
    // without counting it, or the check dies for the rest of the take.
    if (pausedRef.current) {
      liveStuckRef.current = 0;
      armLiveness();
      return;
    }
    checkStillRecording();
  };

  function armLiveness() {
    if (!recordingRef.current) return;
    const token = ++segTokenRef.current;
    const left = durationRef.current * 3600000 - activeMs();
    scheduleSegment(Math.max(1000, Math.min(LIVENESS_MS, left)), token);
  }

  /** Time recorded so far by the wall clock, pauses excluded. Unlike
   *  elapsedRef it is right after the JS tick was suspended. */
  function activeMs(): number {
    const end = pausedRef.current ? pauseStartRef.current : Date.now();
    return Math.max(0, end - startMsRef.current - pausedMsRef.current);
  }

  /** Is the file still growing? If not, the recorder has stopped writing. */
  async function checkStillRecording() {
    let size = 0;
    try {
      const uri = recorder.uri;
      if (uri) {
        const info = await FileSystem.getInfoAsync(uri);
        size = info.exists ? (info as any).size ?? 0 : 0;
      }
    } catch {
      armLiveness();
      return;
    }
    if (size > liveSizeRef.current) {
      liveSizeRef.current = size;
      liveStuckRef.current = 0;
    } else {
      liveStuckRef.current += 1;
    }
    if (liveStuckRef.current >= LIVENESS_DEAD_CHECKS && !liveWarnedRef.current) {
      liveWarnedRef.current = true;
      logEvent(`recorder stopped writing, stuck at ${size} bytes`);
      // Warn, do not stop. Stopping on this signal would truncate a healthy
      // recording if the size ever reads stale, and the audio already written
      // is saved by the normal stop either way — so a false positive here
      // must cost a notification, never a conversation.
      notify(
        "Recording may have stopped",
        "The recording file has not grown for several minutes. Open Mixtape and check."
      ).catch(() => {});
    }
    armLiveness();
  }

  // A VoIP call takes the mic and Android feeds this app silence instead of
  // failing, so a take during a WhatsApp or Meet call records a well-formed
  // empty file. Say so while it is still happening — afterwards the only
  // evidence is a file with nothing in it.
  useEffect(
    () =>
      watchSilence((silenced) => {
        logEvent(`mic silenced=${silenced}`);
        // A notification, not an Alert: this fires precisely when another app
        // has taken the mic, which means that app is in front and an Alert
        // would be drawn behind it. It also re-arms on each segment, so only
        // say it once per take.
        if (silenced && !silenceWarnedRef.current) {
          silenceWarnedRef.current = true;
          notify(
            "Nothing is being recorded",
            "Android has cut the microphone: another app has it, or Mixtape went to the background in a live session. Open Mixtape and keep it on screen. The recording is running but empty until then."
          ).catch(() => {});
        }
      }),
    []
  );

  // Watch for the dongle being plugged in or pulled out. Cheap local query,
  // so polling beats wiring up a native device-change callback.
  useEffect(() => {
    refreshMic();
    const t = setInterval(refreshMic, 2500);
    return () => clearInterval(t);
  }, []);

  /**
   * Which microphone we'd record with. Asks the system directly rather than
   * going through expo-audio: its getAvailableInputs() hides USB devices, and
   * its getCurrentInput() pins the built-in mic as the preferred device when
   * nothing is recording yet, which would route a take away from the dongle.
   */
  function refreshMic() {
    const ext = externalInput();
    extRef.current = ext;
    setMic(ext);
  }

  /**
   * Point the recorder at the dongle. Android usually routes to USB on its own,
   * but saying so explicitly survives anything that pinned the built-in mic.
   * Must run after prepareToRecordAsync: with no prepared recorder underneath,
   * expo-audio's setInput silently does nothing.
   */
  /**
   * Read back the device the take is actually on. Only used where the native
   * list isn't available, and only once the route has settled: asking too
   * early makes expo-audio pin the built-in mic as the preferred device,
   * which would drag a live take off the dongle.
   */
  async function probeRoutedMic() {
    if (extRef.current) return;
    try {
      const input: any = await recorder.getCurrentInput();
      if (!input?.name) return;
      setRouted({
        name: String(input.name),
        ext: input.type !== "MicrophoneBuiltIn",
      });
    } catch {}
  }

  function preferExternalMic() {
    const ext = extRef.current;
    if (!ext) return;
    try {
      recorder.setInput(String(ext.id));
    } catch {
      // A device that refuses to be the preferred input is not worth failing
      // the recording over — the system routing still applies.
    }
  }

  function applyPreset(p: Preset) {
    setDurationH(p.durationH);
    setNames(p.names);
    setCount(p.names.length);
    setLanguage(p.language);
    setFolder(p.folder);
    setTags(p.tags);
    setIsPrivate(p.private);
    setApplied(p);
    setSavingPreset(false);
  }

  /** Everything a preset covers, as it stands right now. */
  function currentAs(name: string): Preset {
    return {
      name,
      durationH,
      names,
      language,
      folder,
      tags,
      private: isPrivate,
    };
  }

  /**
   * Whether the settings still match the preset they came from. Comparing the
   * values beats intercepting every setter: whatever moves a field — a chip,
   * the speaker rows, the placement picker — shows up here.
   */
  function matchesPreset(p: Preset) {
    const tagsOf = (t: string[]) => [...t].sort().join("\u0000");
    return (
      p.durationH === durationH &&
      p.language === language &&
      p.folder === folder &&
      p.private === isPrivate &&
      p.names.length === names.length &&
      p.names.every((n, i) => (n ?? "") === (names[i] ?? "")) &&
      tagsOf(p.tags) === tagsOf(tags)
    );
  }

  const onPreset = applied !== null && matchesPreset(applied);

  async function updatePreset(target: Preset) {
    const next = currentAs(target.name);
    setPresets(await savePreset(next));
    setApplied(next);
  }

  function presetMenu(target: Preset) {
    Alert.alert(target.name, undefined, [
      {
        text: "Update to current settings",
        onPress: () => updatePreset(target),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => confirmDeletePreset(target),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function storePreset() {
    const name = presetName.trim();
    setPresetName("");
    setSavingPreset(false);
    if (!name) return;
    const next = currentAs(name.slice(0, 24));
    setPresets(await savePreset(next));
    setApplied(next);
  }

  function confirmDeletePreset(p: Preset) {
    Alert.alert(`Delete "${p.name}"?`, "The preset only, not any recording.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setPresets(await deletePreset(p.name));
          setApplied((cur) => (cur?.name === p.name ? null : cur));
        },
      },
    ]);
  }

  // Mirrors the recording state into module scope so the cache tools in
  // Settings never offer to delete the take that's still being written.
  function markRecording(on: boolean) {
    setIsRecording(on);
    setRecordingInProgress(on);
  }

  /**
   * Holds the app's own microphone service for the take. Must run while the
   * app is on screen, which a tap on Start guarantees.
   */
  async function beginTake() {
    takeSeqRef.current += 1;
    const own = await startTakeService("Recording");
    await setAudioModeAsync(own ? OWN_SERVICE_AUDIO_MODE : RECORDING_AUDIO_MODE);
    logEvent(own ? "take service held" : "take service unavailable, using expo-audio's");
  }

  /** Everything a take holds, released once it is saved — not at Stop, so
   *  the upload and merge keep the CPU and the network. */
  function endTake(seq = takeSeqRef.current) {
    // A save can outlast its take: a new take started meanwhile owns all of
    // this now, and must not lose its service when the old save finishes.
    if (seq !== takeSeqRef.current) return;
    deactivateKeepAwake();
    releaseWakelock();
    stopTakeService();
    setRecordingInProgress(false);
  }

  /** Stops the recorder, noting the file so its late event is not mistaken
   *  for someone else stopping it. */
  async function stopRecorder() {
    const u = recorder.uri;
    if (u) ownStopsRef.current.add(u);
    await recorder.stop();
  }

  /** (Re)writes the interrupted-take marker from what the take is now. */
  async function writeMarker() {
    const startedAt = takeStartRef.current;
    if (!startedAt) return;
    const segmented = takeModeRef.current !== "single";
    if (!segmented && !recorder.uri) return;
    await markPending({
      cacheUri: segmented ? "" : recorder.uri ?? "",
      startedAt,
      plannedDurationHours: durationRef.current,
      speakers: resolveSpeakers(),
      folder,
      language,
      note,
      private: isPrivate,
      tags,
      place: placeRef.current,
      inputName: takeInputRef.current,
      meIncluded: meFromSlots(),
      ...(segmented ? { segments: [...segUris.current], live: takeModeRef.current === "live" } : {}),
    });
  }

  /** A take that cannot fit fails at the save, hours later. Says so now. */
  async function warnIfLowSpace(hours: number) {
    try {
      const free = await FileSystem.getFreeDiskStorageAsync();
      // About 58 MB an hour at this bitrate, and the save copies it once.
      const need = hours * 58e6 * 2;
      if (free < need) {
        logEvent(`low storage at start: ${Math.round(free / 1e6)} MB free, ${hours}h take needs ~${Math.round(need / 1e6)} MB`);
        setStatus(`Only ${(free / 1e9).toFixed(1)} GB free: a ${hours}h recording may not fit.`);
      }
    } catch {}
  }

  /** Per-take state every mode starts from. */
  function resetTakeState(mode: "single" | "chunked" | "live") {
    takeModeRef.current = mode;
    takeStartRef.current = new Date().toISOString();
    startMsRef.current = Date.now();
    pausedRef.current = false;
    pausedMsRef.current = 0;
    ownStopsRef.current.clear();
    segLiveRef.current = false;
    takeInputRef.current = extRef.current?.name;
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
      if (liveOn.current || chunkedRef.current) {
        secs = Math.floor(
          (Date.now() - startMsRef.current - pausedMsRef.current) / 1000
        );
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

  // The marker is what a crash leaves to recover from, so it follows edits
  // made mid-take instead of keeping the values from the start.
  useEffect(() => {
    if (isRecording) writeMarker();
  }, [isRecording, note, isPrivate, tags, folder, names, language]);

  // Your own name in a speaker slot answers "are you in it": yes. An empty
  // or other-names-only list leaves it open — "not me" is answered on the
  // recording's review card, where it is a deliberate choice.
  const takeStartRef = useRef<string | null>(null);

  function meFromSlots(): "yes" | undefined {
    const me = (settings.ownerName || "").trim().toLowerCase();
    return me && resolveSpeakers().some((x) => x.trim().toLowerCase() === me) ? "yes" : undefined;
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
    // Chunked recording needs the cloud to stitch the pieces back together.
    // Offline, keep the single-file path: one continuous file is still the most
    // robust thing available when nothing can merge it afterwards.
    // Chunking costs the whole take when the activity is backgrounded: the
    // roll is a JS timer, RN suspends those, the native cap stops the recorder
    // and nothing restarts it. One file has no JS in its critical path.
    if (isFirebaseConfigured && isSignedIn() && !s.singleFileRecording) {
      return startChunked();
    }

    try {
      setStatus("");
      setElapsed(0);
      elapsedRef.current = 0;
    silenceWarnedRef.current = false;
    micFallbackWarnedRef.current = false;
    takeGenRef.current += 1;
    placeRef.current = undefined;
    (() => {
      const gen = takeGenRef.current;
      capturePlace()
        .then((p) => {
          // A slow fix resolving after the next take began would stamp the
          // wrong place on it, or clear a good one with undefined.
          if (gen === takeGenRef.current) {
            placeRef.current = p;
            markerRef.current();
          }
        })
        .catch(() => {});
    })();
      // Re-assert the recording mode: the global mode may have been changed
      // since mount, and without shouldPlayInBackground the recorder pauses
      // on screen-off.
      await beginTake();
      await recorder.prepareToRecordAsync();
      preferExternalMic();
      // With the native tick, the limit is enforced there (see armLiveness)
      // and can move mid-take; forDuration cannot, so it is only a backstop.
      // A build without the tick keeps forDuration as the limit itself.
      recorder.record({
        forDuration: hasNativeSegmentTimer() ? BACKSTOP_S : Math.round(durationH * 3600),
      });
      recordingRef.current = true;
      resetTakeState("single");
      await activateKeepAwakeAsync();
      acquireWakelock();
      liveSizeRef.current = 0;
      liveStuckRef.current = 0;
      liveWarnedRef.current = false;
      armLiveness();
      logEvent(`start normal: recording, cap=${durationH}h`);
      await writeMarker();
      refreshMic();
      setTimeout(probeRoutedMic, 3000);
      markRecording(true);
      setPaused(false);
      startTick();
      warnIfLowSpace(durationH);
    } catch (e: any) {
      recordingRef.current = false;
      endTake();
      Alert.alert("Could not start", String(e?.message ?? e));
    }
  }

  // ----- live (segmented) mode -----
  async function startLive() {
    setStatus("");
    setElapsed(0);
    elapsedRef.current = 0;
    silenceWarnedRef.current = false;
    micFallbackWarnedRef.current = false;
    takeGenRef.current += 1;
    placeRef.current = undefined;
    (() => {
      const gen = takeGenRef.current;
      capturePlace()
        .then((p) => {
          // A slow fix resolving after the next take began would stamp the
          // wrong place on it, or clear a good one with undefined.
          if (gen === takeGenRef.current) {
            placeRef.current = p;
            markerRef.current();
          }
        })
        .catch(() => {});
    })();
    // Same re-assert as start(): keeps segments recording with the screen off.
    try {
      await beginTake();
    } catch {}
    await FileSystem.makeDirectoryAsync(SEGMENT_DIR, { intermediates: true }).catch(() => {});
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
    resetTakeState("live");
    segMsRef.current = SEGMENT_MS;
    liveShareId.current = null;
    liveOn.current = true;
    await activateKeepAwakeAsync();
    acquireWakelock();
    markRecording(true);
    setPaused(false);
    startTick();
    writeMarker();
    warnIfLowSpace(durationH);

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
    // A private take never gets a public live link.
    if (shareLive && !isPrivate && !alwaysPrivate(folder) && isFirebaseConfigured && isSignedIn()) {
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

  /** One attempt at starting the next segment. Throws if it will not start. */
  async function armSegment(useExternal: boolean, abort?: () => boolean) {
    await recorder.prepareToRecordAsync();
    // prepare is async: a stop or pause during it means this segment must
    // never start, rather than start and be cleaned up afterwards.
    if (abort?.()) throw new Error("segment cancelled");
    if (useExternal) preferExternalMic();
    // Native backstop: if the JS roll timer is suspended (screen off / Doze)
    // the segment stops itself instead of recording forever. Set above
    // SEGMENT_MS so the normal JS roll always wins and this only fires on a
    // freeze — the same durability the normal-mode forDuration cap gives.
    recorder.record({
      forDuration: Math.round(segMsRef.current / 1000) + 10,
    });
  }

  function recordSegment() {
    const index = segUris.current.length;
    const gen = takeGenRef.current;
    const stale = () =>
      gen !== takeGenRef.current ||
      pausedRef.current ||
      (!liveOn.current && !chunkedRef.current);
    (async () => {
      if (stale()) return;
      let started = false;
      let armedOn = "none";
      try {
        // Falling back to the phone's own mic when the dongle will not arm.
        // The trigger is an exception, not a level reading — the level is not
        // trustworthy here, a thrown error is. A 42-minute take once produced
        // 3 minutes because this failed silently for 39 of them.
        for (const useExternal of extRef.current ? [true, false] : [false]) {
          try {
            await armSegment(useExternal, stale);
            segLiveRef.current = true;
            // prepare/record are async: the take may have ended meanwhile.
            if (stale()) {
              segLiveRef.current = false;
              try {
                await stopRecorder();
              } catch {}
              return;
            }
            started = true;
            armedOn = useExternal ? extRef.current?.name ?? "external" : "builtin";
            if (!useExternal && extRef.current) {
              logEvent(`seg${index} armed on the built-in mic; the dongle would not`);
              if (!micFallbackWarnedRef.current) {
                micFallbackWarnedRef.current = true;
                notify(
                  "Switched to the phone mic",
                  "The external microphone stopped working, so the rest of this recording uses the phone's own mic."
                ).catch(() => {});
              }
            }
            break;
          } catch (e: any) {
            logEvent(
              `seg${index} ${useExternal ? "external" : "builtin"} arm failed: ${String(e?.message ?? e)}`
            );
            // A record() that threw leaves the recorder prepared, and the
            // next prepare then throws "already prepared": the fallback to
            // the built-in mic never ran. Reset it first.
            try {
              await stopRecorder();
            } catch {}
            segLiveRef.current = false;
            if (stale()) return;
          }
        }
        if (!started) {
          // Nothing is being captured and the roll below will keep trying, but
          // silence here is how 39 minutes went missing without a word.
          if (!micFallbackWarnedRef.current) {
            micFallbackWarnedRef.current = true;
            notify(
              "Recording has stopped capturing",
              "The recorder could not start a new segment. Stop and restart the recording."
            ).catch(() => {});
          }
        }
        // Records what each segment started on. The level is logged beside it
        // but is not acted on: see the note by SEG_SETTLE_MS.
        setTimeout(() => {
          try {
            const lvl = recorder.getStatus().metering;
            const shown = typeof lvl === "number" ? lvl.toFixed(1) : "n/a";
            logEvent(
              `seg${index} level=${shown} input=${armedOn}`
            );
          } catch {}
        }, SEG_PROBE_MS);
      } catch {}
      if (stale()) return;
      segArmedAtRef.current = Date.now();
      const token = ++segTokenRef.current;
      // Native tick first: it fires with the app backgrounded, which the JS
      // timer does not. The setTimeout stays only as the path for a build that
      // predates the native function — never both, or a boundary rolls twice.
      // Nothing armed: try again soon, not a whole chunk later.
      const delay = segLiveRef.current ? segMsRef.current : ARM_RETRY_MS;
      if (!scheduleSegment(delay, token)) {
        segTimer.current = setTimeout(() => rollSegment(false), delay);
      }
    })();
  }

  function rollSegment(isFinal: boolean): Promise<void> {
    const next = rollQueueRef.current
      .catch(() => {})
      .then(() => doRollSegment(isFinal));
    rollQueueRef.current = next.catch(() => {});
    return next;
  }

  async function doRollSegment(isFinal: boolean) {
    rollingRef.current = true;
    segTokenRef.current += 1; // the tick this roll answers is now spent
    cancelSegment();
    if (segTimer.current) {
      clearTimeout(segTimer.current);
      segTimer.current = null;
    }
    let uri: string | null = null;
    // Nothing to close when the last arm failed or an earlier roll already
    // closed it: stopping an idle recorder hands back its previous file.
    if (segLiveRef.current) {
      segLiveRef.current = false;
      try {
        await stopRecorder();
        uri = recorder.uri ?? null;
      } catch (e: any) {
        // MediaRecorder.stop() throws when the segment holds no usable audio.
        logEvent(`seg${segUris.current.length} stop failed, segment lost: ${String(e?.message ?? e)}`);
      }
    }

    let dest: string | null = null;
    if (uri) {
      // Out of the cache the moment it is closed: Android clears the cache
      // when storage runs low, and until the merge lands this is the only
      // copy. A move, so the recorder's own file does not linger either.
      dest = `${SEGMENT_DIR}seg_${recIdRef.current}_${segUris.current.length}.m4a`;
      try {
        await FileSystem.moveAsync({ from: uri, to: dest });
        segUris.current.push(dest);
        await markerRef.current();
      } catch (e: any) {
        logEvent(`seg${segUris.current.length} not kept, the take has a gap here: ${String(e?.message ?? e)}`);
        dest = null;
      }
    }

    // The duration cap in startTick() lives in a setInterval, so it stops
    // firing the moment the screen locks and the JS engine suspends. Normal
    // mode survives that on the native forDuration cap; chunked mode had
    // nothing, which is how a take ran for 51 hours. This boundary is driven
    // by the native recorder finishing, so it still runs with the screen off —
    // and it reads wall-clock, because elapsedRef goes stale for exactly the
    // same reason the interval does.
    const capMs = durationRef.current * 3600 * 1000;
    const ranMs = Date.now() - startMsRef.current - pausedMsRef.current;
    const capReached = !isFinal && ranMs >= capMs;

    // Start the next segment immediately — unless we're rolling *because* of a
    // pause, in which case the chain resumes on the Resume tap.
    if (
      !isFinal &&
      !capReached &&
      (liveOn.current || chunkedRef.current) &&
      !pausedRef.current
    ) {
      recordSegment();
    }
    rollingRef.current = false;
    // The device keeps its own copy regardless; this is what makes a running
    // take readable remotely. Passes settings so it respects the cellular
    // preference, and flushLog serialises overlapping calls itself.
    flushLog(settings).catch(() => {});

    if (dest && liveOn.current) {
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

    if (capReached) {
      logEvent(`chunked cap ${durationRef.current}h reached → stopping`);
      // Not awaited: stop() queues its final roll behind this one, so
      // awaiting it here waited on itself and the take was never saved.
      void stop();
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
    if (liveOn.current || chunkedRef.current) return pauseSegments();
    stopTick();
    try {
      recorder.pause();
    } catch {}
    // The liveness check skips a paused file instead of calling it stalled,
    // and the limit and the saved length leave the pause out.
    pausedRef.current = true;
    pauseStartRef.current = Date.now();
    setPaused(true);
  }

  /**
   * A segmented take can't just pause the recorder: the chunk currently being
   * recorded would sit unfinished and its audio would be lost. Roll it as a
   * normal chunk instead (so live mode still transcribes it), and hold the
   * chain until Resume.
   */
  async function pauseSegments() {
    pausedRef.current = true;
    takeGenRef.current += 1;
    pauseStartRef.current = Date.now();
    setPaused(true);
    stopTick();
    await rollSegment(false);
  }

  function resumeSegments() {
    takeGenRef.current += 1;
    pausedMsRef.current += Date.now() - pauseStartRef.current;
    pausedRef.current = false;
    setPaused(false);
    startTick();
    recordSegment();
  }

  function resume() {
    if (liveOn.current || chunkedRef.current) return resumeSegments();
    if (pausedRef.current) {
      pausedMsRef.current += Date.now() - pauseStartRef.current;
      pausedRef.current = false;
    }
    try {
      // Re-arm the native timer for the time that's left, so it still holds
      // after a pause/resume: the backstop, or the limit on an old build.
      const left = Math.round(
        (hasNativeSegmentTimer() ? BACKSTOP_S : durationRef.current * 3600) -
          activeMs() / 1000
      );
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
    // A discarded take must not come back as an "interrupted" one on the
    // next launch.
    clearPending();
    recordingRef.current = false;
    takeGenRef.current += 1;
    // Every path that ends or suspends a take must kill the native tick too,
    // or it fires later and rolls a segment on a recorder that is not running.
    cancelSegment();
    if (chunkedRef.current) {
      chunkedRef.current = false;
      if (segTimer.current) {
        clearTimeout(segTimer.current);
        segTimer.current = null;
      }
    }
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
    segLiveRef.current = false;
    pausedRef.current = false;
    try {
      await stopRecorder();
    } catch {}
    endTake();
    setIsRecording(false);
    setPaused(false);
    setLiveText("");
    setDiarUtt([]);
    setLiveAnswer("");
    setLiveUrl("");
    setStatus("Recording discarded.");
  }

  async function stop() {
    cancelSegment();
    if (liveOn.current) return stopLive();
    if (chunkedRef.current) return stopChunked();
    if (!recordingRef.current) return; // already stopping/stopped (idempotent)
    recordingRef.current = false;
    const seq = takeSeqRef.current;
    stopTick();
    // The wall clock, pauses left out: elapsedRef is stale whenever the JS
    // tick was suspended, and a recorder that stopped itself reads 0.
    let seconds = Math.floor(activeMs() / 1000);
    try {
      const derived = Math.floor((recorder.getStatus().durationMillis || 0) / 1000);
      if (derived > 0) seconds = derived;
    } catch {}
    setPaused(false);
    pausedRef.current = false;
    let stopError = "";
    try {
      await stopRecorder();
    } catch (e: any) {
      stopError = String(e?.message ?? e);
    }
    setIsRecording(false);
    updateTakeService("Saving the recording…");
    const uri = recorder.uri;
    logEvent(`stop normal: dur=${seconds}s uri=${!!uri}${stopError ? ` stop failed: ${stopError}` : ""}`);
    if (!uri) {
      setStatus("No audio captured.");
      endTake(seq);
      return;
    }
    // A stop that threw may have left the file without its index.
    let damaged = false;
    if (stopError) {
      try {
        const info = await FileSystem.getInfoAsync(uri);
        damaged = !(await isPlayable(uri, info.exists ? info.size ?? 0 : 0));
      } catch {}
    }
    setStatus("Saving…");
    try {
      const rec = await processStop({
        // The take's id and time are its start, the same value an
        // interrupted-take save would use, so the two can never both exist.
        recordedAt: takeStartRef.current ?? undefined,
        cacheUri: uri,
        durationSeconds: seconds,
        plannedDurationHours: durationRef.current,
        speakers: resolveSpeakers(),
        folder,
        language,
        settings,
        private: isPrivate,
        tags,
        place: placeRef.current,
        note,
        inputName: takeInputRef.current,
        meIncluded: meFromSlots(),
        damaged,
      });
      setStatus(
        `Saved: ${rec.base}\nTranscript: ${rec.transcriptStatus} · Upload: ${rec.uploadStatus}`
      );
      setLastRec(rec);
      setSpeakerHist(await getSpeakerHistory());
    } catch (e: any) {
      setStatus("Failed: " + String(e?.message ?? e));
    } finally {
      endTake(seq);
    }
  }

  /**
   * A normal take, written as SAFETY_CHUNK_MS pieces. Each finished chunk is a
   * complete file on disk, so losing power mid-recording costs the current
   * chunk instead of everything. Stop stitches them back into one file.
   */
  async function startChunked() {
    try {
      setStatus("");
      setElapsed(0);
      elapsedRef.current = 0;
    silenceWarnedRef.current = false;
    micFallbackWarnedRef.current = false;
    takeGenRef.current += 1;
    placeRef.current = undefined;
    (() => {
      const gen = takeGenRef.current;
      capturePlace()
        .then((p) => {
          // A slow fix resolving after the next take began would stamp the
          // wrong place on it, or clear a good one with undefined.
          if (gen === takeGenRef.current) {
            placeRef.current = p;
            markerRef.current();
          }
        })
        .catch(() => {});
    })();
      await beginTake();
      await FileSystem.makeDirectoryAsync(SEGMENT_DIR, { intermediates: true }).catch(() => {});
      segUris.current = [];
      segTextRef.current = [];
      recIdRef.current = String(new Date().getTime());
      resetTakeState("chunked");
      segMsRef.current = SAFETY_CHUNK_MS;
      chunkedRef.current = true;
      await activateKeepAwakeAsync();
      acquireWakelock();
      logEvent(
        `start chunked: cap=${durationH}h chunk=${SAFETY_CHUNK_MS / 1000}s`
      );
      refreshMic();
      setTimeout(probeRoutedMic, 3000);
      markRecording(true);
      setPaused(false);
      startTick();
      writeMarker();
      warnIfLowSpace(durationH);
      recordSegment();
    } catch (e: any) {
      chunkedRef.current = false;
      endTake();
      Alert.alert("Could not start", String(e?.message ?? e));
    }
  }

  async function stopChunked() {
    if (!chunkedRef.current) return; // idempotent
    chunkedRef.current = false;
    const seq = takeSeqRef.current;
    takeGenRef.current += 1;
    cancelSegment();
    stopTick();
    // elapsedRef only moves while the JS tick runs, which it does not with
    // the screen off.
    const seconds = Math.floor(activeMs() / 1000);
    pausedRef.current = false;
    setPaused(false);
    setStatus("Finishing last chunk…");
    await rollSegment(true);
    setIsRecording(false);
    updateTakeService("Saving the recording…");
    logEvent(`stop chunked: chunks=${segUris.current.length} dur=${seconds}s`);
    if (segUris.current.length === 0) {
      setStatus("No audio captured.");
      await clearPending(takeStartRef.current ?? undefined);
      endTake(seq);
      return;
    }
    setStatus("Joining chunks & saving…");
    try {
      const rec = await processStopLive({
        recordedAt: takeStartRef.current ?? undefined,
        segmentUris: segUris.current,
        liveText: "",
        durationSeconds: seconds,
        speakers: resolveSpeakers(),
        folder,
        language,
        settings,
        private: isPrivate,
        tags,
        place: placeRef.current,
        note,
        inputName: takeInputRef.current,
        meIncluded: meFromSlots(),
        transcribeAfterMerge: true,
        provisionalTopic: "untitled",
      });
      setLastRec(rec);
      setStatus(
        rec.mergePending
          ? `Saved: ${rec.base}
Still joining the audio — it finishes on the next launch.`
          : `Saved: ${rec.base}
Transcript: ${rec.transcriptStatus} · Upload: ${rec.uploadStatus}`
      );
      setSpeakerHist(await getSpeakerHistory());
    } catch (e: any) {
      setStatus("Failed: " + String(e?.message ?? e));
    } finally {
      endTake(seq);
    }
  }

  async function stopLive() {
    const wasDiarizing = diarOnRef.current;
    liveOn.current = false;
    const seq = takeSeqRef.current;
    takeGenRef.current += 1;
    cancelSegment();
    stopDiarization();
    stopTick();
    const seconds = Math.floor(activeMs() / 1000);
    pausedRef.current = false;
    setPaused(false);
    setStatus("Finishing last segment…");
    await rollSegment(true);
    setIsRecording(false);
    updateTakeService("Saving the recording…");
    if (segUris.current.length === 0) {
      setStatus("No audio captured.");
      await clearPending(takeStartRef.current ?? undefined);
      endTake(seq);
      return;
    }
    setStatus("Merging segments & saving…");
    try {
      const rec = await processStopLive({
        recordedAt: takeStartRef.current ?? undefined,
        segmentUris: segUris.current,
        liveText: segTextRef.current.join(" "),
        durationSeconds: seconds,
        speakers: resolveSpeakers(),
        folder,
        language,
        settings,
        private: isPrivate,
        tags,
        place: placeRef.current,
        note,
        inputName: takeInputRef.current,
        meIncluded: meFromSlots(),
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
      // Canonical: a merge into the recording's own object makes the server
      // transcribe it. Asking again here superseded that job with a second,
      // paid one.
      const serverTranscribes = await isCanonical();
      if (
        (wasDiarizing || eligible) &&
        !serverTranscribes &&
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
            (serverTranscribes
              ? rec.mergePending ? " · transcribes once the audio is joined" : " · transcribing on the server"
              : eligible ? "" : " · add an AssemblyAI key to transcribe")
        );
      }
      setDiarUtt([]);
      setSpeakerHist(await getSpeakerHistory());
    } catch (e: any) {
      setStatus("Live save failed: " + String(e?.message ?? e));
    } finally {
      endTake(seq);
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

      {!isRecording ? (
        <View style={styles.presetRow}>
          {presets.map((p) => {
            const on = onPreset && applied?.name === p.name;
            return (
              <TouchableOpacity
                key={p.name}
                style={[styles.presetChip, on ? styles.presetChipOn : null]}
                onPress={() => applyPreset(p)}
                onLongPress={() => presetMenu(p)}
              >
                <Text
                  style={[styles.presetTxt, on ? styles.presetTxtOn : null]}
                >
                  {p.name}
                </Text>
              </TouchableOpacity>
            );
          })}
          {applied && !onPreset ? (
            <TouchableOpacity
              style={[styles.presetChip, styles.presetGhost]}
              onPress={() => updatePreset(applied)}
            >
              <Text style={styles.presetGhostTxt}>
                update &ldquo;{applied.name}&rdquo;
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.presetChip, styles.presetGhost]}
            onPress={() => setSavingPreset((v) => !v)}
          >
            <Text style={styles.presetGhostTxt}>save as preset</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {presets.length > 0 && !isRecording ? (
        <Text style={styles.presetHint}>
          Long-press a preset to update or delete it.
        </Text>
      ) : null}

      {savingPreset && !isRecording ? (
        <View style={styles.presetSave}>
          <TextInput
            style={styles.presetInput}
            value={presetName}
            onChangeText={setPresetName}
            placeholder="preset name (e.g. Erica convo)"
            placeholderTextColor="#6b7280"
            autoFocus
            onSubmitEditing={storePreset}
          />
          <TouchableOpacity style={styles.presetSaveBtn} onPress={storePreset}>
            <Text style={styles.presetSaveTxt}>Save</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text
        style={[
          styles.micLine,
          mic || routed?.ext ? styles.micLineOn : null,
        ]}
      >
        {mic
          ? `🎙 ${mic.name}${mic.channels.includes(2) ? " · stereo" : ""}`
          : routed
            ? `🎙 ${routed.name}${routed.ext ? "" : " (phone mic)"}`
            : "🎙 Phone mic"}
      </Text>

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

      <PlacementPicker
        value={{ folder, private: isPrivate, tags }}
        onChange={(p: Placement) => {
          setFolder(p.folder);
          setIsPrivate(p.private);
          setTags(p.tags);
        }}
      />

      <Text style={styles.label}>What is this?</Text>
      <TextInput
        style={styles.noteInput}
        value={note}
        onChangeText={setNote}
        placeholder="e.g. tyler explaining his work"
        placeholderTextColor="#6b7280"
        multiline
      />

      <Text style={styles.label}>
        {isRecording ? "Time limit (hours)" : "Max duration (hours)"}
      </Text>
      <View style={styles.wrap}>
        {DURATION_PRESETS.map((h) => (
          <TouchableOpacity
            key={h}
            // Mid-take, a limit already passed would end the take on the
            // spot, with no question asked.
            disabled={isRecording && h * 3600 <= elapsed}
            style={[
              styles.chip,
              durationH === h && styles.chipOn,
              isRecording && h * 3600 <= elapsed && { opacity: 0.35 },
            ]}
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
          {(
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
          <Text style={[styles.status, { marginTop: 4 }]}>
            {`${lastRec.speakers.length ? `${lastRec.speakers.length} speaker${lastRec.speakers.length > 1 ? "s" : ""}` : "Speakers auto-detected"} · ${
              lastRec.language && lastRec.language !== "Auto" ? lastRec.language : "language auto"
            } — wrong? Change it there`}
          </Text>
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
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  presetChip: {
    backgroundColor: "#1f3350",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  presetTxt: { color: "#cfe0ff", fontSize: 12.5, fontWeight: "700" },
  presetChipOn: { backgroundColor: "#2f6fd0" },
  presetTxtOn: { color: "#fff" },
  presetHint: { color: "#6b7280", fontSize: 11, marginTop: 6 },
  presetGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#2d323b",
  },
  presetGhostTxt: { color: "#7c828a", fontSize: 12 },
  presetSave: { flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" },
  meRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  meTxt: { color: "#e5e7eb", fontSize: 14 },
  noteInput: {
    backgroundColor: "#1a1d23",
    borderRadius: 8,
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    minHeight: 44,
  },
  presetInput: {
    flex: 1,
    backgroundColor: "#1a1d23",
    borderRadius: 8,
    color: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  presetSaveBtn: {
    backgroundColor: "#2f6fd0",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  presetSaveTxt: { color: "#fff", fontSize: 13, fontWeight: "700" },
  micLine: { color: "#7c828a", fontSize: 12, marginTop: 8 },
  micLineOn: { color: "#6fd08c", fontWeight: "700" },
  viewBtn: {
    backgroundColor: "#23262d",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 12,
  },
  viewTxt: { color: "#3b82f6", fontWeight: "700", fontSize: 15 },
});
