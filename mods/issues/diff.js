// A pull request's patches, as the panel draws them: one row per line, each
// line numbered the way github.com numbers it — the old number on the left,
// the new one on the right, and the one it doesn't have left blank.

// A hunk's header says both where it starts and how many lines it covers:
// `@@ -12,7 +12,9 @@` (a count of one is written without a comma).
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// A file's status, as GitHub names it and as the panel marks it. Gitee has no
// status of its own: it says added, deleted and renamed with flags instead.
export const LETTER = { added: "A", removed: "D", deleted: "D", modified: "M", renamed: "R", copied: "C", changed: "M" };

// The patch's lines, ready to draw. The hunk header moves both counters; a
// removed line moves the old one, an added line the new one, a context line
// both. Anything else the patch carries (`\ No newline at end of file`) is one
// unnumbered row.
export function lines(patch) {
  const rows = [];
  let old = 0, next = 0;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("@@")) {
      const hunk = HUNK.exec(line);
      if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); }
      rows.push({ kind: "@", text: line });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "-", old: old++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "+", next: next++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: " ", old: old++, next: next++, text: line.slice(1) });
    } else if (line.trim()) {
      rows.push({ kind: "", text: line });
    }
  }
  return rows;
}
