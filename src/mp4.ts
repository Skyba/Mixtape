import * as FileSystem from "expo-file-system/legacy";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Bytes(s: string): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

async function readBytes(uri: string, position: number, length: number) {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position,
    length,
  });
  return b64Bytes(b64);
}

const be32 = (b: number[], i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/**
 * True if the file carries an MP4 index. The recorder streams audio into an
 * `mdat` box whose size field is a placeholder until it stops and writes
 * `moov`; if the process is killed first (restart, flat battery) the
 * placeholder is never patched, so walking the box chain runs off the rails.
 * That's the signature of an unfinalised recording.
 */
export async function isPlayable(uri: string, size: number): Promise<boolean> {
  try {
    let pos = 0;
    for (let i = 0; i < 8; i++) {
      const h = await readBytes(uri, pos, 16);
      if (h.length < 8) return false;
      const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
      if (type === "moov") return true;
      let boxSize = be32(h, 0);
      let header = 8;
      if (boxSize === 1) {
        // 64-bit size: the high word is 0 in any real file, but stays as the
        // writer's placeholder in one that was never closed.
        if (h.length < 16 || be32(h, 8) !== 0) return false;
        boxSize = be32(h, 12);
        header = 16;
      }
      if (boxSize < header || pos + boxSize > size) return false;
      pos += boxSize;
      if (pos >= size) return false;
    }
    return false;
  } catch {
    return true; // unreadable for another reason — don't cry wolf
  }
}
