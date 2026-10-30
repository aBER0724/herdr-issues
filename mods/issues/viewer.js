import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, theme, closeOverlay, setShared } from "herdr";
import { icons, icon } from "./icons.js";

export const FIELDS = "number,title,body,author,state,stateReason,labels,assignees,createdAt,updatedAt,comments,url";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;

// As GitHub says it: "3h ago" this month, "on Sep 21" before that.
export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  const d = new Date(iso), year = d.getFullYear() === new Date().getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

export function openUrl(url) {
  exec("sh", ["-c", 'xdg-open "$1" >/dev/null 2>&1 &', "sh", url]).catch(() => exec("open", [url]).catch(() => null));
}

// #123 and owner/repo#123 outside code become links, as on GitHub.
function linkify(markdown, repo) {
  return markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, n) => n % 2 ? part
    : part.replace(/(^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g, (_m, pre, other, number) =>
      `${pre}[${other ?? ""}#${number}](https://github.com/${other ?? repo}/issues/${number})`)).join("");
}

const login = (author) => (author?.login ?? "ghost").replace(/^app\//, "");

// A label as GitHub tints it: its color faint behind, its color as text unless too dark to read.
export function labelChip(l, t, extra = (e) => e) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(l.color.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.35;
  return extra(h_flex().h(22).px(8).gap(5).flex_none().items_center().rounded(11).border_1().border_color(`#${l.color}88`).bg(`#${l.color}2e`)
    .text_size(11).font_semibold().text_color(light ? `#${l.color}` : t.foreground).child(l.name));
}

function avatar(name, t, size = 32) {
  const colors = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
  const color = colors[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % colors.length];
  return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().bg(color + "30").border_1().border_color(color + "70")
    .text_size(Math.round(size * 0.42)).font_semibold().text_color(color).child(name.slice(0, 1).toUpperCase());
}

// One issue in a dialog: { repo, number, on, data?, me? } from the panel. With
// data (the panel's cached copy) it shows at once and refreshes behind it. Links
// to other issues and pull requests open here too, with Back to return.
export class Viewer {
  constructor({ repo, number, on, data, me }, overlay, cx) {
    this.repo = repo; this.number = number; this.on = on; this.me = me; this.overlay = overlay;
    this.history = []; this.cache = {}; this.labels = {};
    if (data) this.cache[`${repo}#${number}`] = data;
    this.reply = TextareaState.new({ placeholder: "Leave a comment" });
    this.reply.set_auto_grow(3, 12);
    this.reply.on("change", (_e, cx) => { const has = Boolean(this.reply.value().trim()); if (has !== this.replying) { this.replying = has; cx.notify(); } });
    this.reply.on("submit", (e, cx) => { if (e.secondary) this.comment(cx); });
    cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
    this.load(cx);
  }

  load(cx) {
    const repo = this.repo, number = this.number, id = `${repo}#${number}`, current = () => this.repo === repo && this.number === number;
    this.issue = this.cache[id] ?? null; this.error = null; this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["issue", "view", String(number), "-R", repo, "--json", FIELDS], { on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.cache[id] = JSON.parse(r.stdout);
        if (current()) this.issue = this.cache[id];
      } catch (e) { if (current()) this.error = String(e?.message ?? e); }
      finally { if (current()) { this.loading = false; cx.notify(); } }
    });
  }

  go(repo, number, cx) {
    if (repo === this.repo && number === this.number) return;
    this.history.push({ repo: this.repo, number: this.number });
    this.repo = repo; this.number = number; this.editing = false;
    this.load(cx); cx.notify();
  }

  back(cx) {
    const prev = this.history.pop();
    if (!prev) return;
    this.repo = prev.repo; this.number = prev.number; this.editing = false;
    this.load(cx); cx.notify();
  }

  link(url, cx) {
    const m = ISSUE_URL.exec(url);
    if (m) this.go(m[1], Number(m[2]), cx); else openUrl(url);
  }

  // Runs `gh issue <args>` on this issue, then reloads it and tells the panel.
  change(label, args, cx, after) {
    if (this.busy) return;
    const repo = this.repo, number = this.number;
    this.busy = label; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["issue", args[0], String(number), "-R", repo, ...args.slice(1)], { on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        after?.();
      } catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.busy = null;
        setShared("issues.changed", { repo, number, on: this.on, at: Date.now() });
        if (this.repo === repo && this.number === number) this.load(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  comment(cx) {
    const body = this.reply.value().trim();
    if (body) this.change("Commenting", ["comment", "--body", body], cx, () => { this.reply.set_value(""); this.replying = false; });
  }

  // Closing or reopening takes what's in the comment box along.
  setState(close, reason, cx) {
    const body = this.reply.value().trim(), args = close ? ["close", "--reason", reason] : ["reopen"];
    if (body) args.push("--comment", body);
    this.change(close ? "Closing" : "Reopening", args, cx, () => { this.reply.set_value(""); this.replying = false; });
  }

  // Shows the change at once; the reload after gh confirms it.
  toggleLabel(l, cx) {
    const has = this.issue.labels.some((x) => x.name === l.name);
    this.issue.labels = has ? this.issue.labels.filter((x) => x.name !== l.name) : [...this.issue.labels, l];
    this.change("Saving labels", ["edit", has ? "--remove-label" : "--add-label", l.name], cx);
  }

  editLabels(cx) {
    this.editing = !this.editing;
    const repo = this.repo;
    if (this.editing && !this.labels[repo]) cx.spawn(async (cx) => {
      const r = await exec("gh", ["label", "list", "-R", repo, "--limit", "200", "--json", "name,color,description"], { on: this.on }).catch(() => null);
      this.labels[repo] = r?.code === 0 ? JSON.parse(r.stdout).sort((a, b) => a.name.localeCompare(b.name)) : [];
      cx.notify();
    });
    cx.notify();
  }

  button(id, label, t, onClick, { primary = false, danger = false, enabled = true, icon: glyph = null } = {}) {
    const color = danger ? t.ansi1 : primary ? t.solid_foreground : t.muted, solid = primary && enabled;
    return h_flex().id(id).h(30).px(12).gap(6).flex_none().items_center().justify_center().rounded(7).text_size(12).font_semibold()
      .bg(solid ? t.solid : primary ? t.raised : t.background).border_1().border_color(solid ? t.solid : t.border).text_color(enabled ? color : t.dim)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover).text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)).on_click(onClick))
      .when(Boolean(glyph) && this.icons, (e) => e.child(svg(icon(glyph)).size(13)))
      .child(label);
  }

  // A comment as GitHub draws it: an avatar beside a card, who and when on its bar.
  entry(id, author, when, body, t, { first = false } = {}) {
    return h_flex().flex_none().gap(12).items_start()
      .child(avatar(author, t))
      .child(v_flex().flex_1().min_w(0).rounded(8).border_1().border_color(first ? t.accent + "66" : t.border).overflow_hidden()
        .child(h_flex().h(38).px(14).gap(6).items_center().bg(first ? t.accent + "14" : t.raised).border_b(1).border_color(first ? t.accent + "44" : t.border).text_size(12)
          .child(div().font_semibold().child(author))
          .child(div().text_color(t.dim).child(`commented ${ago(when)}`))
          .child(div().flex_1())
          .when(author === login(this.issue.author), (e) => e.child(div().px(7).py(1).rounded(10).border_1().border_color(t.border).text_size(11).text_color(t.muted).child("Author"))))
        .child(div().px(16).py(14).text_size(13).child(body?.trim()
          ? TextView.markdown(id, linkify(body, this.repo)).selectable(true).on_link_click((url, cx) => this.link(url, cx))
          : div().text_color(t.dim).italic().child("No description provided."))));
  }

  // The thin line GitHub draws between comments, under the avatars.
  joint(t) { return div().flex_none().ml(15).w(2).h(16).bg(t.border); }

  composer(i, t) {
    const open = i.state === "OPEN", busy = Boolean(this.busy), text = Boolean(this.replying);
    return h_flex().flex_none().gap(12).items_start()
      .child(avatar(this.me ?? "?", t))
      .child(v_flex().flex_1().min_w(0).rounded(8).border_1().border_color(t.border).overflow_hidden()
        .child(div().id("issue-reply").px(12).py(10).bg(t.background).cursor_text().child(Textarea.new(this.reply).w_full().text_size(13).text_color(t.foreground)))
        .child(h_flex().px(10).py(8).gap(8).items_center().bg(t.raised).border_t(1).border_color(t.border)
          .child(div().flex_1().text_size(11).text_color(t.dim).child("Markdown · Ctrl+Enter to comment"))
          .child(open
            ? this.button("issue-close-reason", text ? "Close with comment" : "Close issue", t, (_e, cx) => this.setState(true, "completed", cx), { enabled: !busy })
            : this.button("issue-reopen-bottom", text ? "Reopen with comment" : "Reopen issue", t, (_e, cx) => this.setState(false, null, cx), { enabled: !busy }))
          .child(this.button("issue-comment", "Comment", t, (_e, cx) => this.comment(cx), { primary: true, enabled: text && !busy }))));
  }

  section(title, t, action = null) {
    return h_flex().h(24).items_center().text_size(12).font_semibold().text_color(t.muted)
      .child(div().flex_1().child(title)).when(Boolean(action), (e) => e.child(action));
  }

  sidebar(i, t) {
    const pr = i.url.includes("/pull/"), open = i.state === "OPEN", busy = Boolean(this.busy);
    const mine = i.assignees.some((a) => a.login === this.me), all = this.labels[this.repo];
    const link = (id, label, onClick) => div().id(id).text_size(11).text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(onClick).child(label);
    return v_flex().id("issue-sidebar").w(250).flex_none().min_h(0).overflow_y_scrollbar().px(18).py(18).gap(18).border_l(1).border_color(t.border)
      .child(v_flex().gap(8)
        .child(this.section("Assignees", t, pr || !this.me ? null : link("issue-assign", mine ? "Unassign me" : "Assign yourself",
          (_e, cx) => this.change(mine ? "Unassigning" : "Assigning", ["edit", mine ? "--remove-assignee" : "--add-assignee", "@me"], cx))))
        .child(i.assignees.length
          ? v_flex().gap(6).children(i.assignees.map((a) => h_flex().gap(8).items_center().text_size(12).child(avatar(a.login, t, 20)).child(a.login)))
          : div().text_size(12).text_color(t.dim).child("No one assigned")))
      .child(div().h(1).bg(t.border))
      .child(v_flex().gap(8)
        .child(this.section("Labels", t, pr ? null : link("issue-labels-edit", this.editing ? "Done" : "Edit", (_e, cx) => this.editLabels(cx))))
        .when(!this.editing, (e) => e.child(i.labels.length
          ? h_flex().gap(6).flex_wrap().children(i.labels.map((l) => labelChip(l, t)))
          : div().text_size(12).text_color(t.dim).child("None yet")))
        .when(this.editing, (e) => e.child(!all
          ? div().text_size(12).text_color(t.dim).child("Loading labels…")
          : v_flex().gap(2).children(all.map((l) => {
            const on = i.labels.some((x) => x.name === l.name);
            return h_flex().id(`label-${l.name}`).px(6).py(5).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.toggleLabel(l, cx))
              .child(div().w(14).flex_none().text_size(12).text_color(t.accent).child(on ? "✓" : ""))
              .child(div().size(10).flex_none().rounded(5).bg(`#${l.color}`))
              .child(v_flex().flex_1().min_w(0).child(div().text_size(12).child(l.name))
                .when(Boolean(l.description), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(l.description))));
          })))))
      .when(!pr, (e) => e.child(div().h(1).bg(t.border))
        .child(v_flex().gap(8)
          .child(this.section("State", t))
          .when(open, (e) => e
            .child(this.button("issue-close-done", "Close as completed", t, (_e, cx) => this.setState(true, "completed", cx), { enabled: !busy }))
            .child(this.button("issue-close-skip", "Close as not planned", t, (_e, cx) => this.setState(true, "not planned", cx), { enabled: !busy })))
          .when(!open, (e) => e.child(this.button("issue-reopen", "Reopen issue", t, (_e, cx) => this.setState(false, null, cx), { enabled: !busy })))));
  }

  render(cx) {
    const t = theme(), i = this.issue;
    const bar = h_flex().gap(8).items_center()
      .when(this.history.length > 0, (e) => e.child(this.button("issue-back", "← Back", t, (_e, cx) => this.back(cx))))
      .child(div().text_size(12).text_color(t.dim).child(i?.url.includes("/pull/") ? `${this.repo} · pull request` : this.repo))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.ansi1).truncate().child(i && this.error ? this.error : ""))
      .when(this.loading || Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(this.busy ?? "Refreshing")))
      .when(Boolean(i) && !this.loading && !this.busy, (e) => e.child(this.button("issue-refresh", "Refresh", t, (_e, cx) => { this.load(cx); cx.notify(); }, { icon: "refresh" })))
      .when(Boolean(i), (e) => e.child(this.button("issue-github", "Open on GitHub", t, () => openUrl(i.url))))
      .child(this.button("issue-close", "✕", t, () => closeOverlay(this.overlay)));
    if (!i) return v_flex().id("issue").size_full().bg(t.background).text_color(t.foreground).text_size(13).px(28).pt(18).gap(16)
      .child(bar)
      .child(this.loading ? div().text_color(t.dim).child(`Loading #${this.number}…`) : div().text_color(t.ansi1).child(this.error ?? ""));

    const [state, color] = i.state === "OPEN" ? ["Open", t.ansi2] : i.state === "MERGED" ? ["Merged", t.ansi5]
      : i.stateReason === "NOT_PLANNED" ? ["Not planned", t.dim] : ["Closed", t.ansi5];
    const pr = i.url.includes("/pull/");
    return v_flex().id("issue").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(28).pt(16).pb(16).gap(12).border_b(1).border_color(t.border)
        .child(bar)
        .child(div().text_size(24).child(h_flex().gap(10).flex_wrap()
          .child(div().child(i.title)).child(div().text_color(t.dim).child(`#${i.number}`))))
        .child(h_flex().gap(10).items_center().flex_wrap().text_size(13)
          .child(h_flex().h(30).px(12).gap(6).items_center().rounded(15).bg(color).text_color("#ffffff").font_semibold()
            .when(this.icons, (e) => e.child(svg(icon("issue")).size(14))).child(state))
          .child(div().text_color(t.muted).child(h_flex().gap(4)
            .child(div().font_semibold().text_color(t.foreground).child(login(i.author)))
            .child(`opened this ${pr ? "pull request" : "issue"} ${ago(i.createdAt)} · ${i.comments.length} ${i.comments.length === 1 ? "comment" : "comments"}`)))))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().id(`issue-thread-${this.repo}-${i.number}`).flex_1().min_w(0).min_h(0).overflow_y_scrollbar().px(28).py(20)
          .child(this.entry("issue-body", login(i.author), i.createdAt, i.body, t, { first: true }))
          .children(i.comments.flatMap((c, n) => [this.joint(t), this.entry(`issue-comment-${n}`, login(c.author), c.createdAt, c.body, t)]))
          .when(!pr, (e) => e.child(this.joint(t)).child(div().flex_none().h(1).mb(16).bg(t.border)).child(this.composer(i, t))))
        .child(this.sidebar(i, t)));
  }
}
