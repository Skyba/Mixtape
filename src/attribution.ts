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
export function touch(r: Recording, ...fields: SyncedField[]): Recording {
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
  const labels = { ...(r.speakerLabels ?? {}) };
  labels[letter] = { name, by, at: new Date().toISOString() };
  let next: Recording = { ...r, speakerLabels: labels, speakerMap: labelsToMap(labels) };
  if (ownerName && name.trim().toLowerCase() === ownerName.trim().toLowerCase()) {
    next = { ...next, speakerId: letter, meIncluded: "yes" };
    return touch(next, "speakerLabels", "speakerId", "meIncluded");
  }
  return touch(next, "speakerLabels");
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
export function mergeNewest(mine: Recording, theirs: Partial<Recording>): Recording {
  const fields: SyncedField[] = [
    "folder", "speakers", "speakerLabels", "speakerId", "meIncluded", "tags", "private", "note",
  ];
  let out: Recording = { ...mine };
  const stamps = { ...(mine.fieldsUpdatedAt ?? {}) };
  for (const f of fields) {
    const t = theirs.fieldsUpdatedAt?.[f];
    const m = mine.fieldsUpdatedAt?.[f];
    if (t && (!m || t > m) && f in theirs) {
      (out as any)[f] = (theirs as any)[f];
      stamps[f] = t;
    }
  }
  if (out.speakerLabels) out.speakerMap = labelsToMap(out.speakerLabels);
  return { ...out, fieldsUpdatedAt: stamps };
}
