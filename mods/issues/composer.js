// The box an issue is written in — a comment, a new issue's body, the body of
// an issue being edited in place — with a markdown toolbar, three ways to see
// it (write, preview, both) and an image row. One of these is drawn wherever
// markdown is typed, so all three behave the same.
//
// The seams it leaves to its owner: `footer` is the row of buttons under it,
// `md` draws the preview (the owner has the repository and its links), and
// `onChange` / `onSubmit` are told when the text changed and when Ctrl+Enter
// was pressed in it.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState, Input, InputState } from "gpui-base";
import { notify } from "herdr";
import { icons, icon } from "./icons.js";
import { loadPicture, picture, failed } from "./pictures.js";
import { mark, fence, line, link, imageMark } from "./format.js";
import { isImage, keep, fromClipboard, upload } from "./images.js";

export class MarkdownBox {
  constructor(cx, { id = "md", placeholder = "", rows = [3, 12], onChange = null, onSubmit = null } = {}) {
    this.id = id; this.onChange = onChange; this.onSubmit = onSubmit;
    this.tab = "write";
    this.state = TextareaState.new({ placeholder });
    this.state.set_auto_grow(rows[0], rows[1]);
    this.state.on("change", (_e, cx) => this.changed(cx));
    this.state.on("submit", (e, cx) => { if (e.secondary) this.onSubmit?.(cx); });
    // A paste with no text is a screenshot: it goes to the image row, since no
    // comment or issue API takes a file.
    this.state.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.imageOpen = false; this.imageFile = null; this.imageNote = null; this.imageError = null; this.imageBusy = null;
    this.imageUrl = InputState.new({ placeholder: "Image URL" });
    this.imageAlt = InputState.new({ placeholder: "Alt text" });
    this.imageWidth = InputState.new({ placeholder: "Width" });
    this.imageUrl.on("change", (_e, cx) => { this.imageError = null; this.watchImage(cx); cx.notify(); });
    cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
  }

  get value() { return this.state.value(); }
  setValue(text) { this.state.set_value(text); }

  // Back to an empty box in write mode, for the next comment.
  reset() {
    this.state.set_value(""); this.tab = "write";
    this.imageOpen = false; this.imageFile = null; this.imageError = null; this.imageNote = null;
  }

  // The preview only redraws when the view does, so typing in a preview that is
  // on screen asks for one — while writing alone needs it only when the box goes
  // from empty to not, which the owner's onChange decides.
  changed(cx) {
    this.onChange?.(cx);
    if (this.tab !== "write") cx.notify();
  }

  // A mark or an image went in: the owner hears it, and the box redraws — a
  // button may have to light up, and the click was rare enough to pay for it.
  written(cx) {
    this.onChange?.(cx);
    cx.notify();
  }

  // ---- drawing ----

  glyph(name, size, color) {
    return div().size(size).flex_none().when(this.icons, (e) => e.child(svg(icon(name)).size(size).text_color(color)));
  }

  render(cx, { t, md, room = null, footer = null }) {
    const tab = (id, label) => div().id(`${this.id}-tab-${id}`).h(32).px(14).flex().items_center().rounded_t(6).text_size(13).cursor_pointer()
      .when(this.tab === id, (e) => e.bg(t.background).border_1().border_b(0).border_color(t.border).text_color(t.foreground))
      .when(this.tab !== id, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    const writing = this.tab !== "preview", showing = this.tab !== "write";
    return v_flex().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .on_drop((event, cx) => this.imageDropped(event?.paths, cx))
      .child(h_flex().px(8).pt(8).gap(4).items_end().bg(t.raised).border_b(1).border_color(t.border)
        .child(tab("write", "Write")).child(tab("preview", "Preview")).child(tab("split", "Split"))
        .child(div().flex_1()))
      .when(writing, (e) => e.child(this.marks(t, cx)))
      .when(writing, (e) => e.child(div().px(12).py(10).bg(t.background).cursor_text()
        .child(Textarea.new(this.state).w_full().text_size(14).text_color(t.foreground))))
      .when(showing, (e) => e.child(div().when(this.tab === "split", (el) => el.border_t(1).border_color(t.border))
        .child(this.previewBox(t, cx, md, room))))
      .when(Boolean(this.imageOpen), (e) => e.child(this.imageRow(t, cx)))
      .when(Boolean(footer), (e) => e.child(footer));
  }

  // The markdown toolbar: a button per mark, writing over the selection and
  // leaving the caret where the typing that follows belongs.
  marks(t, cx) {
    const button = (id, glyph, label, run) => h_flex().id(`${this.id}-mark-${id}`).size(24).flex_none().items_center().justify_center()
      .rounded(5).text_color(t.muted).tooltip(label).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { run(); this.written(cx); })
      .child(this.glyph(glyph, 14, t.muted));
    const markOp = (name) => () => mark(this.state, name);
    const lineOp = (kind) => () => line(this.state, kind);
    const rule = () => div().w(1).h(16).mx(3).flex_none().bg(t.border);
    return h_flex().flex_none().px(8).py(6).gap(2).items_center().flex_wrap().bg(t.raised).border_b(1).border_color(t.border)
      .child(button("bold", "bold", "Bold", markOp("bold")))
      .child(button("italic", "italic", "Italic", markOp("italic")))
      .child(button("strike", "strike", "Strikethrough", markOp("strike")))
      .child(button("code", "code", "Code", markOp("code")))
      .child(button("fence", "block", "Code block", () => fence(this.state)))
      .child(rule())
      .child(button("quote", "quote", "Quote", lineOp("quote")))
      .child(button("bullet", "list", "Bulleted list", lineOp("bullet")))
      .child(button("ordered", "ordered", "Numbered list", lineOp("ordered")))
      .child(button("task", "task", "Task list", lineOp("task")))
      .child(button("heading", "heading", "Heading", lineOp("heading")))
      .child(rule())
      // The clipboard's URL, when it holds one: a link copied from the browser
      // needs no second paste. A host that grants no read leaves the slot in.
      .child(button("link", "link", "Link", () => {
        let copied = "";
        try { copied = cx.read_from_clipboard() ?? ""; } catch { /* not granted */ }
        link(this.state, copied);
      }))
      .child(button("image", "image", "Image", () => this.openImage(cx)))
      .child(div().flex_1());
  }

  // The text as the platform will draw it, written out again as it is typed.
  previewBox(t, cx, md, room) {
    const value = this.state.value().trim();
    return div().px(16).py(14).min_h(110).bg(t.background).text_size(14)
      .child(value ? md(value, cx, room) : div().text_color(t.muted).child("Nothing to preview"));
  }

  // ---- the image row ----

  imageRow(t, cx) {
    const url = this.imageUrl.value().trim(), file = this.imageFile;
    const field = (state) => div().h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
    const button = (id, label, onClick, { primary = false, enabled = true, glyph = null } = {}) => {
      const solid = primary && enabled;
      return h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().justify_center().rounded(6).text_size(13).font_medium()
        .bg(solid ? "#238636" : t.raised).border_1().border_color(solid ? "#238636" : t.border)
        .text_color(solid ? "#ffffff" : enabled ? t.foreground : t.dim)
        .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(solid ? "#29903b" : t.hover)).on_click(onClick))
        .when(Boolean(glyph), (e) => e.child(this.glyph(glyph, 14, solid ? "#ffffff" : t.muted)))
        .when(label !== "", (e) => e.child(label));
    };
    return v_flex().flex_none().px(10).py(10).gap(8).bg(t.raised).border_t(1).border_color(t.border)
      .child(h_flex().gap(10).items_start()
        .child(this.thumb(t))
        .child(v_flex().flex_1().min_w(0).gap(6)
          .child(field(this.imageUrl))
          .child(h_flex().gap(6)
            .child(div().flex_1().min_w(0).child(field(this.imageAlt)))
            .child(div().w(52).flex_none().child(field(this.imageWidth))))))
      .when(Boolean(this.imageError), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.imageError)))
      .when(Boolean(this.imageNote), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.imageNote)))
      .child(h_flex().gap(8).items_center().flex_wrap().justify_end()
        .when(Boolean(file), (e) => e.child(button(`${this.id}-image-upload`, this.imageBusy ?? "Upload to a gist",
          (_e, cx) => this.uploadImage(cx), { enabled: !this.imageBusy, glyph: "external" })))
        .child(button(`${this.id}-image-cancel`, "Cancel", (_e, cx) => this.closeImage(cx), { enabled: !this.imageBusy }))
        .child(button(`${this.id}-image-insert`, "Insert image", (_e, cx) => this.insertImage(cx),
          { primary: true, enabled: Boolean(url) && !this.imageBusy })));
  }

  // 52px of the picture, its own shape kept: the file's, or the one the URL names
  // once it has been downloaded.
  thumb(t) {
    const box = (inner) => div().size(52).flex_none().rounded(6).overflow_hidden().border_1().border_color(t.border)
      .bg(t.background).flex().items_center().justify_center().child(inner);
    const fit = (source, w, h) => {
      const scale = Math.min(52 / Math.max(1, w ?? 52), 52 / Math.max(1, h ?? 52));
      return image(source).w(Math.max(1, Math.round((w ?? 52) * scale))).h(Math.max(1, Math.round((h ?? 52) * scale)));
    };
    const file = this.imageFile;
    if (file) return box(file.width ? fit(file.rel, file.width, file.height) : this.glyph("image", 16, t.dim));
    const url = this.imageUrl.value().trim();
    if (!/^https?:\/\//.test(url)) return box(this.glyph("image", 16, t.dim));
    const p = picture(url);
    if (p) return box(fit(p.path, p.width, p.height));
    return box(failed(url) ? div().text_size(10).text_color(t.muted).child("no image") : this.glyph("image", 16, t.dim));
  }

  // The Image button: a link pasted in, or a file dropped on the box.
  openImage(cx, file = null) {
    this.imageOpen = true; this.imageFile = file ?? null; this.imageError = null;
    this.imageNote = file
      ? "Neither platform takes a file: Upload puts it in a secret gist on your GitHub account and writes that link."
      : "Drop an image on the box, paste one from the clipboard, or paste its link.";
    if (file) this.imageUrl.set_value("");
    else this.watchImage(cx);
    cx.notify();
  }

  closeImage(cx) {
    this.imageOpen = false; this.imageFile = null; this.imageError = null; this.imageNote = null;
    cx.notify();
  }

  // The picture a URL names, downloaded once and drawn in the row: worth waiting
  // a moment on, since the URL is typed a character at a time.
  watchImage(cx) {
    const url = this.imageUrl.value().trim();
    if (!/^https?:\/\//.test(url)) return;
    const run = (this.imageRun = (this.imageRun ?? 0) + 1);
    cx.spawn(async (cx) => {
      await cx.sleep(300);
      if (run !== this.imageRun) return;
      const loading = loadPicture(url);
      if (loading) await loading;
      if (run === this.imageRun) cx.notify();
    });
  }

  insertImage(cx) {
    const url = this.imageUrl.value().trim();
    if (!url) { this.imageError = "An image needs a URL"; cx.notify(); return; }
    const width = Number(this.imageWidth.value().trim()) || null;
    imageMark(this.state, { url, alt: this.imageAlt.value().trim(), width });
    this.imageOpen = false; this.imageFile = null; this.imageNote = null; this.imageError = null;
    this.imageUrl.set_value(""); this.imageAlt.set_value(""); this.imageWidth.set_value("");
    this.written(cx);
  }

  // A file has no URL of its own, and neither platform takes one: a secret gist,
  // made with the gh token the panel already reads its issues with, gives it a
  // link the platform can fetch.
  uploadImage(cx) {
    const file = this.imageFile;
    if (!file || this.imageBusy) return;
    this.imageBusy = "Uploading"; this.imageError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.imageUrl.set_value(await upload({ file: file.file }));
        this.imageFile = null; this.imageNote = null; this.imageBusy = null;
        this.insertImage(cx);
        notify({ title: "Uploaded", body: "The picture is in a secret gist; its link is in the text.", level: "success", timeout: 4000 });
      } catch (e) {
        this.imageError = String(e?.message ?? e);
        this.imageBusy = null;
        cx.notify();
      }
    });
  }

  // A file dropped on the box: kept where image() can draw it, then the row's.
  imageDropped(paths, cx) {
    const path = (paths ?? []).find((p) => isImage(p));
    if (!path) {
      notify({ title: "Not an image", body: "Only a picture can go here.", level: "info", timeout: 3000 });
      return;
    }
    cx.spawn(async (cx) => {
      const file = await keep(path).catch(() => null);
      if (!file) { this.imageOpen = true; this.imageError = "That file could not be read"; cx.notify(); return; }
      this.openImage(cx, file);
    });
  }

  // A screenshot on the clipboard arrives as a paste with no text.
  async pasteImage(cx) {
    const file = await fromClipboard(`data/issues/images/paste-${Date.now().toString(36)}.png`).catch(() => null);
    if (!file) {
      notify({ title: "No picture", body: "The clipboard holds no image; paste an image's URL instead.", level: "info", timeout: 3500 });
      return;
    }
    this.openImage(cx, file);
  }
}
