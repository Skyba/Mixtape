import { INBOX, LabelSource, Recording, SpeakerLabel, SyncedField } from "./types";

/**
 * Green means the two first-class questions have answers: which folder, and
 * is the owner one of the voices. Naming the other people is welcome but
 * optional — an unnamed co-speaker means "unknown", not "unreviewed".
 */
/** At least one speaker named by hand, rather than by a model or a channel. */
export function hasUserLabels(r: Recording): boolean {
  return Object.values(r.speakerLabels ?? {}).some((l) => l.by === "user");
}

export function isGreen(r: Recording): boolean {
  // Naming the speakers by hand counts as having attributed the recording.
  // Older takes were labelled long before "are you in it" existed, and asking
  // again for work already done is what made the dot nag rather than inform.
  return r.folder !== INBOX && (r.meIncluded !== undefined || hasUserLabels(r));
}

/**
 * How far the speakers of a recording can be trusted, for the row colour:
 *  - review:    the Mac review found its signals disagreeing (red);
 *  - confirmed: every speaker label was set or confirmed by a person (green);
 *  - likely:    at least one label rests on two agreeing signals (yellow);
 *  - none:      model guesses or nothing yet (no colour).
 */
export type SpeakerStatus = "review" | "confirmed" | "likely" | "none";
export function speakerStatus(r: Recording): SpeakerStatus {
  if (r.reviewFlag) return "review";
  const labels = Object.values(r.speakerLabels ?? {});
  if (labels.length && labels.every((l) => l.by === "user")) return "confirmed";
  if (labels.some((l) => l.by === "ai-review" || l.by === "channel")) return "likely";
  return "none";
}
/**
 * One colour per recording, for the library row and the review card:
 *  - red:    the Mac review found its signals disagreeing;
 *  - green:  you confirmed both the speakers and the folder;
 *  - yellow: something is inferred (a voice match, an AI label, a suggested
 *            folder) or only one of the two is confirmed;
 *  - grey:   nothing yet — no inference, no confirmation.
 */
export type Trust = "grey" | "yellow" | "green" | "red";
/** The voices that count: those of the current transcript when known. */
export function currentKeys(r: Recording): string[] {
  // An explicit empty list means "this transcript has no speech", not
  // "unknown": stale labels must not stand in for it.
  return Array.isArray(r.speakerKeys) ? r.speakerKeys : Object.keys(r.speakerLabels ?? {});
}
/** Every voice of the current transcript carries a name you gave or confirmed
 *  (merging a voice into someone is giving it that name). */
export function speakersConfirmed(r: Recording): boolean {
  const keys = currentKeys(r);
  if (keys.length === 0) return Array.isArray(r.speakerKeys) && r.transcriptStatus === "done"; // no speech: nothing to name
  return keys.every((k) => r.speakerLabels?.[k]?.by === "user");
}
/** A flag raised after your last naming is a new contradiction; one raised
 *  before it was answered by that naming. */
export function flagOpen(r: Recording): boolean {
  if (!r.reviewFlag) return false;
  if (!speakersConfirmed(r)) return true;
  const lastMine = currentKeys(r).map((k) => r.speakerLabels?.[k]?.at || "").sort().pop() || "";
  return r.reviewFlag.at > lastMine;
}
export function folderConfirmed(r: Recording): boolean {
  return r.folder !== INBOX;
}
/** Something inferred is waiting for a tap: a model's or the voice's name for
 *  a voice, AssemblyAI naming a voice directly, or a suggested folder. */
export function hasSuggestion(r: Recording): boolean {
  const keys = currentKeys(r);
  const named = keys.some((k) => {
    const l = r.speakerLabels?.[k];
    return l ? l.by !== "user" : !/^[A-Z]$/.test(k);
  });
  return named || (r.folder === INBOX && !!r.folderSuggestion);
}
/**
 * One colour per recording:
 *  - red:    a review found the signals contradicting each other (or you);
 *  - green:  every current voice named by you, and the folder set;
 *  - yellow: a suggestion is waiting for your ✓;
 *  - grey:   nothing known and nothing suggested.
 */
/** The name a voice carries now: its label, or AssemblyAI's name as key. */
function nameOfKey(r: Recording, k: string): string | null {
  return r.speakerLabels?.[k]?.name ?? (/^[A-Z]$/.test(k) ? null : k);
}
/** Names given to two voices where at least one was not given by you
 *  (a merge you made is fine): one of them is wrong. */
export function duplicateNames(r: Recording): string[] {
  const by: Record<string, string[]> = {};
  for (const k of currentKeys(r)) {
    const n = nameOfKey(r, k);
    if (n && !/^Other \(/.test(n)) (by[n] ??= []).push(k);
  }
  return Object.entries(by)
    .filter(([, ks]) => ks.length > 1 && ks.some((k) => r.speakerLabels?.[k]?.by !== "user"))
    .map(([n]) => n);
}
export function trustOf(r: Recording): Trust {
  if (duplicateNames(r).length) return "red";
  if (flagOpen(r)) return "red";
  if (speakersConfirmed(r) && folderConfirmed(r)) return "green";
  // Partly named by you is work in progress, not "nothing known".
  const partly = currentKeys(r).some((k) => r.speakerLabels?.[k]?.by === "user");
  return hasSuggestion(r) || partly || (speakersConfirmed(r) && !folderConfirmed(r)) ? "yellow" : "grey";
}
export const TRUST_COLOR: Record<Trust, string> = { grey: "#4b5058", yellow: "#facc15", green: "#4ade80", red: "#ef4444" };
/** Where a speaker's name came from, in words. */
export const SOURCE_WORD: Record<string, string> = {
  user: "you", "ai-review": "AI review", channel: "channel", voiceprint: "voice", claude: "AI guess", aai: "AssemblyAI", none: "old label",
};

/** Labels a person could confirm in one tap (anything a model or the voice set). */
export function confirmableLetters(r: Recording): string[] {
  return Object.entries(r.speakerLabels ?? {}).filter(([, l]) => l.by !== "user").map(([L]) => L);
}

/** What is still missing, for the amber hint. Empty when green. */
export function missingForGreen(r: Recording): string[] {
  const out: string[] = [];
  if (r.folder === INBOX) out.push("folder");
  if (r.meIncluded === undefined && !hasUserLabels(r)) out.push("are you in it");
  return out;
}

/** Stamps a synced field as edited now, so newest-wins sync can compare. */
export function touch(r: Recording, ...fields: string[]): Recording {
  const at = new Date().toISOString();
  const next = { ...(r.fieldsUpdatedAt ?? {}) };
  for (const f of fields) next[f] = at;
  return { ...r, fieldsUpdatedAt: next };
}

/** The legacy letter -> name view, always derived from the labels. */
export function labelsToMap(
  labels?: Record<string, SpeakerLabel>
): Record<string, string> | undefined {
  if (!labels) return undefined;
  const map: Record<string, string> = {};
  for (const [l, v] of Object.entries(labels)) map[l] = v.name;
  return map;
}

/**
 * Assigns a letter to a person and records who said so. Keeps speakerMap in
 * step for readers that predate provenance, and sets speakerId when the name
 * is the owner's. Does not touch other letters: a user confirmation of A must
 * never erase the model's guess for C.
 */
export function setLabel(
  r: Recording,
  letter: string,
  name: string,
  by: LabelSource,
  ownerName?: string
): Recording {
  // A legacy map with no labels is carried forward as labels of unknown
  // provenance, never wiped and never promoted to "user".
  const labels: Record<string, SpeakerLabel> = { ...(r.speakerLabels ?? {}) };
  if (!r.speakerLabels && r.speakerMap) {
    for (const [l, n] of Object.entries(r.speakerMap)) labels[l] = { name: n, by: "none", at: null };
  }
  labels[letter] = { name, by, at: new Date().toISOString() };
  let next: Recording = { ...r, speakerLabels: labels, speakerMap: labelsToMap(labels) };
  const owner = (ownerName ?? "").trim().toLowerCase();
  const isOwner = !!owner && name.trim().toLowerCase() === owner;
  if (isOwner) {
    next = { ...next, speakerId: letter, meIncluded: "yes" };
    return touch(next, `speakerLabels.${letter}`, "speakerId", "meIncluded");
  }
  // Renaming the owner's letter to someone else: the owner is no longer
  // identified, and saying so must carry a stamp or a sync resurrects it.
  if (next.speakerId === letter) {
    next = { ...next, speakerId: undefined };
    return touch(next, `speakerLabels.${letter}`, "speakerId");
  }
  return touch(next, `speakerLabels.${letter}`);
}

/**
 * Applies to `cur` exactly what a preview edit changed — the listed stamp
 * keys, their values and their stamps — so the sidecar carries the same
 * stamps the outbox sent, not a second, later set. Letters are copied one
 * at a time; speakerMap is re-derived.
 */
export function adopt(cur: Recording, preview: Recording, keys: string[]): Recording {
  const out: Recording = { ...cur };
  const stamps: Record<string, string> = { ...(cur.fieldsUpdatedAt ?? {}) };
  const labels: Record<string, SpeakerLabel> = { ...(cur.speakerLabels ?? {}) };
  let touchedLabels = false;
  for (const k of keys) {
    const t = preview.fieldsUpdatedAt?.[k];
    if (t) stamps[k] = t;
    if (k.startsWith("speakerLabels.")) {
      const L = k.slice(14);
      const v = preview.speakerLabels?.[L];
      if (v) labels[L] = v; else delete labels[L];
      touchedLabels = true;
    } else {
      (out as any)[k] = (preview as any)[k];
    }
  }
  if (touchedLabels) {
    out.speakerLabels = Object.keys(labels).length ? labels : undefined;
    out.speakerMap = labelsToMap(out.speakerLabels);
  }
  return { ...out, fieldsUpdatedAt: stamps };
}
/** The stamp keys a preview changed relative to `from`. */
export function changedKeys(from: Recording, preview: Recording): string[] {
  const a = from.fieldsUpdatedAt ?? {}, b = preview.fieldsUpdatedAt ?? {};
  return Object.keys(b).filter((k) => b[k] !== a[k]);
}

/** Who set the owner's letter, derived — never a second source of truth. */
export function speakerIdBy(r: Recording): LabelSource | "none" {
  if (!r.speakerId) return "none";
  return r.speakerLabels?.[r.speakerId]?.by ?? "none";
}

/**
 * Newest edit wins, per field. Both sides call this with the other side's
 * copy; a field the other side edited more recently replaces ours, and one
 * we edited more recently is kept. Fields with no timestamp on either side
 * keep ours, so pre-provenance sidecars are never clobbered by a blank.
 */
export function mergeNewest(
  mine: Recording,
  theirs: Partial<Recording>,
  opts?: { serverWinsTies?: boolean }
): Recording {
  const scalar: SyncedField[] = ["folder", "speakers", "speakerId", "meIncluded", "tags", "private", "note",
    "topic", "place", "inputName", "language", "shareId", "base", "reviewFlag", "folderSuggestion"];
  let out: Recording = { ...mine };
  const stamps: Record<string, string> = { ...(mine.fieldsUpdatedAt ?? {}) };
  const newer = (t?: string, m?: string) =>
    !!t && (!m || t > m || (opts?.serverWinsTies === true && t === m));
  for (const f of scalar) {
    const t = theirs.fieldsUpdatedAt?.[f];
    if (f in theirs && newer(t, mine.fieldsUpdatedAt?.[f])) {
      (out as any)[f] = (theirs as any)[f];
      stamps[f] = t!;
    }
  }
  // Letters merge one at a time, so their edit to B never erases our edit to A.
  if (theirs.speakerLabels || theirs.fieldsUpdatedAt) {
    const labels: Record<string, SpeakerLabel> = { ...(mine.speakerLabels ?? {}) };
    const letters = new Set([
      ...Object.keys(theirs.speakerLabels ?? {}),
      ...Object.keys(theirs.fieldsUpdatedAt ?? {}).filter((k) => k.startsWith("speakerLabels.")).map((k) => k.slice(14)),
    ]);
    for (const L of letters) {
      const key = `speakerLabels.${L}`;
      const t = theirs.fieldsUpdatedAt?.[key];
      if (!newer(t, mine.fieldsUpdatedAt?.[key])) continue;
      const v = theirs.speakerLabels?.[L];
      if (v) labels[L] = v; else delete labels[L];
      stamps[key] = t!;
    }
    out.speakerLabels = Object.keys(labels).length ? labels : undefined;
  }
  if (typeof theirs.transcriptRevision === "number" && theirs.transcriptRevision > (mine.transcriptRevision ?? 0)) {
    out.transcriptRevision = theirs.transcriptRevision;
  }
  if (out.speakerLabels) out.speakerMap = labelsToMap(out.speakerLabels);
  return { ...out, fieldsUpdatedAt: stamps };
}
