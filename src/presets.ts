import AsyncStorage from "@react-native-async-storage/async-storage";

/** A saved starting point for a recording: everything the Record screen asks. */
export type Preset = {
  name: string;
  durationH: number;
  /** Named slots and blanks alike, exactly as the speaker rows hold them. */
  names: (string | null)[];
  language: string;
  folder: string;
  tags: string[];
  private: boolean;
};

const KEY = "recordPresets";

export async function getPresets(): Promise<Preset[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

/** Saving under an existing name replaces it, so a preset can be corrected. */
export async function savePreset(p: Preset): Promise<Preset[]> {
  const all = (await getPresets()).filter(
    (x) => x.name.toLowerCase() !== p.name.toLowerCase()
  );
  const next = [p, ...all].slice(0, 12);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export async function deletePreset(name: string): Promise<Preset[]> {
  const next = (await getPresets()).filter((x) => x.name !== name);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
