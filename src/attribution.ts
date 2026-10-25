import { INBOX, LabelSource, Recording, SpeakerLabel, SyncedField } from "./types";

/**
 * Green means the two first-class questions have answers: which folder, and
 * is the owner one of the voices. Naming the other people is welcome but
 * optional — an unnamed co-speaker means "unknown", not "unreviewed".
 */
export function isGreen(r: Recording): boolean {
  return r.folder !== INBOX && r.meIncluded !== undefined;
}

/** What is still missing, for the amber hint. Empty when green. */
export function missingForGreen(r: Recording): string[] {
  const out: string[] = [];
  if (r.folder === INBOX) out.push("folder");
  if (r.meIncluded === undefined) out.push("are you in it");
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
    "topic", "place", "inputName", "language", "shareId", "base"];
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
