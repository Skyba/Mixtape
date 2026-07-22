export const DEFAULT_SUMMARY_PROMPT =
  "Summarize this conversation in a few bullet points, then list any action items with owners.";

export const PROMPT_PRESETS: {
  key: string;
  label: string;
  text: string | null;
}[] = [
  { key: "summary", label: "Summary + action items", text: DEFAULT_SUMMARY_PROMPT },
  {
    key: "tldr",
    label: "One-paragraph TL;DR",
    text: "Give a single concise paragraph summarizing this conversation.",
  },
  {
    key: "actions",
    label: "Action items only",
    text: "List only the action items — each with who's responsible and a due date if mentioned.",
  },
  {
    key: "decisions",
    label: "Key decisions",
    text: "List the key decisions made in this conversation, with one line of context each.",
  },
  {
    key: "highlights",
    label: "Highlights & quotes",
    text: "Pull out the highlights and most memorable or striking quotes, attributed to who said them.",
  },
  {
    key: "catchup",
    label: "Catch-up: what's new",
    text: "Summarize what's new in each person's life and any news they shared.",
  },
  { key: "custom", label: "Custom…", text: null },
];
