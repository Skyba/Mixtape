/**
 * One-time local move from the legacy layout ({folder}/{base}.{ext}) to the
 * id-keyed v2 layout (_v2/{id}/...). Runs on the first launch after the
 * cloud cutover, before anything else touches recordings. Journaled so a
 * crash at any point resumes without losing or duplicating a file:
 *
 *  0  journal: every legacy group (folder/base) with its files, sizes and
 *     md5, written atomically BEFORE any move;
 *  1  decide: ids seen in more than one group use the bundled cloud
 *     decisions (which group is canonical); undecided ones are preserved
 *     under _v2/_dupes/ and reported, never guessed;
 *  2  move: per file, journaled before each step; source only -> move,
 *     destination only -> verify md5 -> done, both -> equal md5 -> drop the
 *     source, else keep both (.conflict-N) and report;
 *  3  queues: outbox entries are keyed by id already; nothing to rewrite;
 *  4  marker: complete.json, refused while any file is unresolved.
 */
import * as FileSystem from "expo-file-system/legacy";
import { ROOT, V2_ROOT, V2_MARKER, idDirName, setLayoutV2, detectLayout } from "./recordings";
import { logEvent } from "./log";

const JOURNAL = V2_ROOT + "journal.json";
const EXTS = [".m4a", ".json", ".txt", ".aai.json"];

type FileEntry = { from: string; to: string; size: number; md5: string | null; state: "planned" | "moved" | "conflict" | "missing" };
type Group = { key: string; folder: string; base: string; id: string | null; files: FileEntry[]; target: "canonical" | "dupe" | "orphan" };
type Journal = { startedAt: string; phase: number; groups: Group[]; report: string[] };

const decisions: Record<string, string> = require("../migration-decisions.json");

function extOf(name: string): string | null {
  return EXTS.find((e) => name.endsWith(e) && !(e === ".json" && name.endsWith(".aai.json"))) ?? null;
}
async function readJournal(): Promise<Journal | null> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(JOURNAL)); } catch { return null; }
}
async function writeJournal(j: Journal): Promise<void> {
  await FileSystem.makeDirectoryAsync(V2_ROOT, { intermediates: true });
  await FileSystem.writeAsStringAsync(JOURNAL + ".tmp", JSON.stringify(j));
  await FileSystem.moveAsync({ from: JOURNAL + ".tmp", to: JOURNAL });
}
const md5Of = async (uri: string) => {
  const i = await FileSystem.getInfoAsync(uri, { md5: true });
  return i.exists ? { size: i.size ?? 0, md5: i.md5 ?? null } : null;
};

/** Target file name inside the id directory for a legacy extension. */
function targetName(ext: string, rev: number): string {
  // Legacy transcripts land under r0: they are whatever the phone had, not
  // the server's current pair. pullTranscripts installs r{current} and only
  // then flips the pointer.
  return { ".m4a": "audio.m4a", ".json": "meta.json", ".txt": `r${rev}/transcript.txt`, ".aai.json": `r${rev}/utterances.aai.json` }[ext]!;
}

async function buildJournal(): Promise<Journal> {
  const groups: Group[] = [];
  const folders = (await FileSystem.readDirectoryAsync(ROOT)).filter((f) => !f.startsWith("_"));
  const byId = new Map<string, Group[]>();
  for (const folder of folders) {
    const dir = `${ROOT}${folder}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) continue;
    const files = await FileSystem.readDirectoryAsync(dir);
    const byBase = new Map<string, string[]>();
    for (const f of files) {
      const ext = extOf(f);
      if (!ext) continue;
      const base = f.slice(0, -ext.length);
      byBase.set(base, [...(byBase.get(base) ?? []), f]);
    }
    for (const [base, names] of byBase) {
      let id: string | null = null;
      try {
        const raw = JSON.parse(await FileSystem.readAsStringAsync(`${dir}${base}.json`));
        id = raw.id ?? null;
      } catch {}
      const g: Group = { key: `${folder}/${base}`, folder, base, id, files: [], target: id ? "canonical" : "orphan" };
      for (const f of names) {
        const m = await md5Of(dir + f);
        g.files.push({ from: dir + f, to: "", size: m?.size ?? 0, md5: m?.md5 ?? null, state: "planned" });
      }
      groups.push(g);
      if (id) byId.set(id, [...(byId.get(id) ?? []), g]);
    }
  }
  const report: string[] = [];
  for (const [id, gs] of byId) {
    if (gs.length < 2) continue;
    const chosen = decisions[id];
    for (const g of gs) {
      if (chosen && g.key === chosen) continue;
      g.target = "dupe";
      if (!chosen || !gs.some((x) => x.key === chosen)) report.push(`undecided duplicate ${id}: ${g.key} preserved under _dupes`);
    }
    if (!chosen || !gs.some((x) => x.key === chosen)) for (const g of gs) g.target = "dupe";
  }
  for (const g of groups) {
    const rev = 0;
    for (const f of g.files) {
      const name = f.from.split("/").pop()!;
      const ext = extOf(name)!;
      f.to =
        g.target === "canonical" ? `${V2_ROOT}${idDirName(g.id!)}/${targetName(ext, rev)}` :
        g.target === "dupe" ? `${V2_ROOT}_dupes/${idDirName(g.id!)}/${encodeURIComponent(g.key)}/${name}` :
        `${V2_ROOT}_orphans/${encodeURIComponent(g.key)}/${name}`;
    }
  }
  return { startedAt: new Date().toISOString(), phase: 0, groups, report };
}

let running: Promise<boolean> | null = null;
/** Runs or resumes the migration. Returns true when the v2 layout is live. One at a time. */
export function runLocalMigration(): Promise<boolean> {
  if (running) return running;
  running = doMigration().finally(() => { running = null; });
  return running;
}
async function doMigration(): Promise<boolean> {
  if (await detectLayout()) return true;
  let j = await readJournal();
  if (!j) {
    j = await buildJournal();
    await writeJournal(j);
    logEvent(`local migration: journal with ${j.groups.length} groups`);
  }
  let unresolved = 0;
  for (const g of j.groups) {
    for (const f of g.files) {
      if (f.state === "moved" || f.state === "conflict") continue;
      const src = await FileSystem.getInfoAsync(f.from);
      const dst = await FileSystem.getInfoAsync(f.to);
      const dir = f.to.slice(0, f.to.lastIndexOf("/") + 1);
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      if (src.exists && !dst.exists) {
        await FileSystem.moveAsync({ from: f.from, to: f.to });
        f.state = "moved";
      } else if (!src.exists && dst.exists) {
        const m = await md5Of(f.to);
        if (m && (f.md5 === null || m.md5 === f.md5)) f.state = "moved";
        else { f.state = "conflict"; j.report.push(`destination differs from journal: ${f.to}`); }
      } else if (src.exists && dst.exists) {
        const a = await md5Of(f.from), b = await md5Of(f.to);
        if (a && b && a.md5 === b.md5) { await FileSystem.deleteAsync(f.from, { idempotent: true }); f.state = "moved"; }
        else {
          let n = 1;
          while ((await FileSystem.getInfoAsync(`${f.to}.conflict-${n}`)).exists) n++;
          j.report.push(`conflict: ${f.from} kept as ${f.to}.conflict-${n}`);
          await writeJournal(j); // the destination name is on disk before the move
          await FileSystem.moveAsync({ from: f.from, to: `${f.to}.conflict-${n}` });
          f.state = "conflict";
        }
      } else {
        f.state = "missing"; unresolved++;
        j.report.push(`missing on both sides: ${f.from}`);
      }
      await writeJournal(j);
    }
    // The sidecar of a canonical group gets its v2 pointer fields.
    if (g.target === "canonical") {
      const meta = `${V2_ROOT}${idDirName(g.id!)}/meta.json`;
      try {
        const raw = JSON.parse(await FileSystem.readAsStringAsync(meta));
        // remoteCreated is NOT asserted here: the listener sets it when the
        // document is seen, and flushUploads creates it for a recording that
        // never went up.
        const next = { ...raw, folder: g.folder, base: g.base, transcriptLocalRev: undefined };
        await FileSystem.writeAsStringAsync(meta + ".tmp", JSON.stringify(next, null, 2));
        await FileSystem.moveAsync({ from: meta + ".tmp", to: meta });
      } catch {}
    }
  }
  if (unresolved) {
    logEvent(`local migration: ${unresolved} unresolved; no marker written`);
    return false;
  }
  await FileSystem.writeAsStringAsync(V2_MARKER + ".tmp", JSON.stringify({ completedAt: new Date().toISOString(), report: j.report }));
  await FileSystem.moveAsync({ from: V2_MARKER + ".tmp", to: V2_MARKER });
  setLayoutV2(true);
  logEvent(`local migration complete; ${j.report.length} notes`);
  return true;
}
