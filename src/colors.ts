// Stable color per speaker, used consistently across selection chips,
// transcript name stamps, the talk-time timeline, and the legend.
export const SPEAKER_PALETTE = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#10b981", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
];

/** Color for an AssemblyAI speaker letter: A -> 0, B -> 1, … */
export function colorForLetter(letter: string): string {
  const i = letter.charCodeAt(0) - 65;
  return SPEAKER_PALETTE[((i % SPEAKER_PALETTE.length) + SPEAKER_PALETTE.length) % SPEAKER_PALETTE.length];
}

/** Color by position in a list (speaker slot index). */
export function colorForIndex(i: number): string {
  return SPEAKER_PALETTE[((i % SPEAKER_PALETTE.length) + SPEAKER_PALETTE.length) % SPEAKER_PALETTE.length];
}
