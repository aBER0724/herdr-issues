// The marks the comment box's toolbar writes, apart from the box itself: each
// one rewrites the value and leaves the selection where typing should go on.
//
// gpui's text state has no getter for the caret or the selection — only
// set_selected_range and replace — so `selection()` finds them by writing a
// marker in and taking it out again: `replace` writes over whatever is
// selected, so where the marker lands and how much shorter the value got give
// both ends back. The value is put back before the caller sees it.

const probe = () => `\u2063${Math.random().toString(36).slice(2, 9)}\u2063`;

// { start, end } of the selection, equal at a bare caret, with the state left
// as it was — or null when the marker did not come back intact, in which case
// the caret is put at the end of the text.
export function selection(state) {
  const before = state.value();
  const mark = probe();
  let after;
  try {
    state.replace(mark);
    after = state.value();
  } catch {
    state.set_value(before);
    return null;
  }
  const at = after.indexOf(mark);
  const start = at, end = at + before.length - (after.length - mark.length);
  state.set_value(before);
  const whole = at >= 0 && end >= start && end <= before.length
    && after.slice(0, start) === before.slice(0, start)
    && after.slice(at + mark.length) === before.slice(end);
  state.set_selected_range(whole ? { start, end } : { start: before.length, end: before.length });
  return whole ? { start, end } : null;
}

const place = (state) => selection(state) ?? { start: state.value().length, end: state.value().length };

// The value with `text` written over [start, end), and the selection on `select`.
function write(state, start, end, text, select) {
  const value = state.value();
  state.set_value(value.slice(0, start) + text + value.slice(end));
  const caret = select ?? { start: start + text.length, end: start + text.length };
  state.set_selected_range(caret);
}

// `before` and `after` around the selection — or around `placeholder` when
// nothing is selected — with what went between them still selected.
export function wrap(state, before, after, placeholder = "") {
  const value = state.value(), { start, end } = place(state);
  const chosen = value.slice(start, end) || placeholder;
  write(state, start, end, before + chosen + after,
    { start: start + before.length, end: start + before.length + chosen.length });
}

// The markdown at the caret (or over the selection).
export function insert(state, text) {
  const { start, end } = place(state);
  write(state, start, end, text);
}

const MARKS = {
  bold: ["**", "**", "bold"],
  italic: ["*", "*", "italic"],
  strike: ["~~", "~~", "struck through"],
  code: ["`", "`", "code"],
};

export function mark(state, name) {
  const [before, after, placeholder] = MARKS[name];
  wrap(state, before, after, placeholder);
}

// A fenced block, the text inside it on lines of its own.
export const fence = (state) => wrap(state, "```\n", "\n```", "code");

// Each line the selection touches gets the mark — a quote, a list, a heading —
// or has it taken off again when every one of them already has it.
const LEAD = {
  bullet: /^[-*+]\s+/,
  ordered: /^\d+[.)]\s+/,
  task: /^[-*+]\s+\[[ xX]\]\s*/,
  quote: /^>\s?/,
  heading: /^#{1,6}\s+/,
};
const ADD = { bullet: "- ", ordered: (n) => `${n + 1}. `, task: "- [ ] ", quote: "> ", heading: "### " };

export function line(state, kind) {
  const value = state.value(), sel = place(state);
  const from = value.lastIndexOf("\n", Math.max(0, sel.start - 1)) + 1;
  // A selection that ends where a line starts does not reach into that line.
  const last = value[sel.end - 1] === "\n" && sel.end > from ? sel.end - 1 : sel.end;
  const at = value.indexOf("\n", last), to = at < 0 ? value.length : at;
  const rows = value.slice(from, to).split("\n");
  const lead = LEAD[kind];
  const on = rows.some((row) => row.trim()) && rows.every((row) => !row.trim() || lead.test(row));
  const next = rows.map((row, n) => {
    const bare = row.replace(lead, "");
    if (on) return bare;
    const add = ADD[kind];
    return (typeof add === "function" ? add(n) : add) + bare;
  }).join("\n");
  write(state, from, to, next, { start: from, end: from + next.length });
}

const URL = /^(?:https?:\/\/|mailto:)\S+$/;

// [text](url): the clipboard's URL when it holds one, so a link copied from
// the browser needs no second paste. The selection covers whichever of the two
// the person still has to type.
export function link(state, clipboard = "") {
  const value = state.value(), { start, end } = place(state);
  const chosen = value.slice(start, end) || "link text";
  const copied = String(clipboard ?? "").trim();
  const href = URL.test(copied) ? copied : "url";
  write(state, start, end, `[${chosen}](${href})`, href === "url"
    ? { start: start + chosen.length + 3, end: start + chosen.length + 3 + href.length }
    : { start: start + 1, end: start + 1 + chosen.length });
}

// An image as both platforms read one: markdown, or a <img> when a width is
// given (markdown has no way to say how wide a picture is).
export function imageMark(state, { url, alt = "", width = null }) {
  const text = String(alt ?? "").replace(/[["\]]/g, "");
  if (width) insert(state, `<img src="${url}"${text ? ` alt="${text}"` : ""} width="${width}">`);
  else insert(state, `![${text}](${url})`);
}
