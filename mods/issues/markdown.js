// Markdown as the panel draws it: the text as `TextView.markdown`, and the
// images cut out of it and drawn between the runs (the markdown view draws
// none). Shared, because a comment, a timeline card and a preview of what is
// being written all show the same thing.
import { div, image } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { exec } from "herdr";
import { blocks, picture, failed, loadPicture } from "./pictures.js";

export function openUrl(url) {
  exec("sh", ["-c", 'xdg-open "$1" >/dev/null 2>&1 &', "sh", url]).catch(() => exec("open", [url]).catch(() => null));
}

// #123 (GitHub) or #IKS135 (Gitee), and owner/repo#123, outside code become links.
export function linkify(markdown, repo, api) {
  const ref = api.name === "gitee" ? /(^|[\s(])(?:([\w.-]+\/[\w.-]+))?#([A-Za-z][A-Za-z0-9]{3,9})\b/g : /(^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;
  return markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, n) => n % 2 ? part
    : part.replace(ref, (_m, pre, other, number) => `${pre}[${other ?? ""}#${number}](${api.web}/${other ?? repo}/issues/${number})`)).join("");
}

// One picture, as GitHub sizes it: its width attribute, else its own, never
// wider than the column (`room`).
function pictureView({ key, b, t, cx, room }) {
  const loading = loadPicture(b.image);
  if (loading) cx.spawn(async (cx) => { await loading; cx.notify(); });
  const p = picture(b.image);
  if (!p) return div().h(failed(b.image) ? 36 : 120).w_full().flex_none().rounded(6).border_1().border_color(t.border).bg(t.raised)
    .flex().items_center().justify_center().px(12).text_size(12).text_color(t.muted).truncate()
    .child(failed(b.image) ? `Image could not be loaded${b.alt ? `: ${b.alt}` : ""}` : "Loading image…");
  const w = Math.min(b.width ?? p.width, Math.max(240, room)), h = Math.round(p.height * w / p.width);
  return div().id(key).flex_none().cursor_pointer().on_click(() => openUrl(p.file)).child(image(p.path).w(w).h(h).rounded(6));
}

// The body as runs of markdown and the images between them. `onLink` gets the
// link a person clicked; `room` is how wide a picture may be drawn.
export function markdownView({ key, body, t, cx, room, repo, api, onLink }) {
  const parts = blocks(body);
  return v_flex().gap(12).children(parts.map((b, n) => b.image
    ? pictureView({ key: `${key}-${n}`, b, t, cx, room })
    : TextView.markdown(`${key}-${n}`, linkify(b.text, repo, api)).selectable(true).on_link_click((url, cx) => onLink(url, cx))));
}
