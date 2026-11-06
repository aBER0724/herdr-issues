import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, TextView, Input, InputState } from "gpui-base";
import { exec, run, home, knownAgents, spaces, shared, settings, theme, openOverlay, setShared } from "herdr";
import { icons, icon, avatarPath, loadAvatar } from "./icons.js";
import { openUrl, markdownView } from "./markdown.js";
import { lines as patchLines, LETTER } from "./diff.js";
import { MarkdownBox } from "./composer.js";
import { providerOf, providerAt } from "./api.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISSUE_URL = /^https:\/\/(github\.com|gitee\.com)\/([\w.-]+\/[\w.-]+?)\/(issues|pull|pulls)\/([\w-]+)(?:[/?#].*)?$/;
// GitHub's own state colors, the same in every theme so they read as GitHub's.
const GITHUB = { open: "#238636", done: "#8957e5", skipped: "#6e7681", link: "#4493f8" };
const EMOJI = {
  "+1": "👍", "-1": "👎", laugh: "😄", hooray: "🎉", confused: "😕", heart: "❤️", rocket: "🚀", eyes: "👀",
  THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉", CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀",
};
const ROLES = { OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor" };
// A title with these has no spaces to wrap at: it wraps as text, not word by word.
const CJK = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
// A pull request's changes: a file's row, a line of its patch, and the cap on
// how much of a long diff is drawn. Past it the web page has the rest.
const FILE_ROW = 28, LINE_ROW = 18, HUNK_ROW = 18, NOTE_ROW = 24, DIFF_ROWS = 8000;

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

// gh says app/name for apps, the REST API name[bot]; GitHub shows the name with a bot badge.
const login = (user) => user?.login ?? "ghost";
const shown = (name) => name.replace(/^app\//, "").replace(/\[bot\]$/, "");
const bot = (name) => /^app\/|\[bot\]$/.test(name);

function reactions(r) {
  if (Array.isArray(r)) return r.filter((g) => g.users?.totalCount > 0 && EMOJI[g.content]).map((g) => ({ emoji: EMOJI[g.content], count: g.users.totalCount }));
  return Object.entries(r ?? {}).filter(([k, n]) => EMOJI[k] && n > 0).map(([k, n]) => ({ emoji: EMOJI[k], count: n }));
}

// The REST timeline as GitHub draws it: comments, and the events between them
// (a burst of label changes by one person is one line).
function timeline(raw) {
  const items = [];
  for (const e of raw) {
    const who = e.actor ?? e.user, base = { login: login(who), avatar: who?.avatar_url, at: e.created_at };
    switch (e.event) {
      case "commented":
        items.push({ ...base, kind: "comment", body: e.body, role: e.author_association, reactions: reactions(e.reactions), url: e.html_url });
        break;
      case "labeled": case "unlabeled": {
        const last = items.at(-1), added = e.event === "labeled";
        if (last?.kind === "labels" && last.login === base.login && Date.parse(base.at) - Date.parse(last.at) < 60000) (added ? last.added : last.removed).push(e.label);
        else items.push({ ...base, kind: "labels", added: added ? [e.label] : [], removed: added ? [] : [e.label] });
        break;
      }
      case "assigned": case "unassigned":
        items.push({ ...base, kind: "assign", added: e.event === "assigned", who: login(e.assignee) });
        break;
      case "closed": items.push({ ...base, kind: "closed", reason: e.state_reason }); break;
      case "reopened": items.push({ ...base, kind: "reopened" }); break;
      case "renamed": items.push({ ...base, kind: "renamed", from: e.rename?.from, to: e.rename?.to }); break;
      case "milestoned": case "demilestoned":
        items.push({ ...base, kind: "milestone", added: e.event === "milestoned", title: e.milestone?.title });
        break;
      case "cross-referenced": {
        const s = e.source?.issue;
        if (s) items.push({ ...base, kind: "mention", number: s.number, title: s.title, state: s.state, pr: Boolean(s.pull_request),
          merged: Boolean(s.pull_request?.merged_at), repo: s.repository?.full_name, url: s.html_url });
        break;
      }
      case "referenced": {
        const repo = /repos\/([^/]+\/[^/]+)\/commits/.exec(e.commit_url ?? "")?.[1];
        if (e.commit_id && repo) items.push({ ...base, kind: "commit", sha: e.commit_id, url: `https://github.com/${repo}/commit/${e.commit_id}` });
        break;
      }
    }
  }
  return items;
}

// Copy link, with the reference and number beside it: a popup of the panel's mod.
export function copyMenu({ repo, provider, kind, number, ref, title, url }, at) {
  const base = `${providerOf(provider).web}/${repo}/${kind === "pull" ? "pulls" : "issues"}/${number}`;
  const copyRef = kind === "pull" ? `${repo}!${number}` : `${repo}${ref ?? `#${number}`}`;
  openOverlay({ mod: "issues", kind: "popup", width: 300, height: 222, ...(at ? { at } : {}),
    props: { copyMenu: { url: url ?? base, ref: copyRef, number: ref ?? `#${number}`, title: title ? `${ref ?? `#${number}`} ${title}` : null } } });
}

// A label as GitHub tints it: its color faint behind, its color as text unless too dark to read.
export function labelChip(l, t) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(l.color.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.35;
  return div().h(20).px(7).flex_none().flex().items_center().rounded(10).border_1().border_color(`#${l.color}66`).bg(`#${l.color}2e`)
    .text_size(12).font_semibold().text_color(light ? `#${l.color}` : t.foreground).child(l.name);
}

// Start work: the dialog picks the harness, its model, the branch and the brief; it makes
// the worktree and the space. The creator is this mod itself, as an overlay.
const startProps = (viewer) => {
  const i = viewer.issue, api = viewer.api;
  return {
    repo: viewer.repo, provider: api.name, kind: viewer.kind, number: i.number,
    ref: i.ref ?? `#${i.number}`, title: i.title, url: i.url, body: i.body ?? "",
    head: i.head ?? null, base: i.base ?? null, folder: viewer.folder, on: viewer.on,
  };
};

// One issue or pull request where the panel's list was: { repo, provider, kind,
// number, data?, me? } from the panel, with Back to the list. Links to other
// items open here too, with Back to return.
export class Viewer {
  constructor({ repo, kind, provider, number, on, data, me, folder }, cx, { onBack }) {
    this.repo = repo; this.number = number; this.kind = kind ?? "issue"; this.on = on; this.me = me;
    this.folder = folder;
    this.api = providerOf(provider); this.onBack = onBack;
    this.history = []; this.cache = {}; this.timelines = {}; this.labels = {};
    // A pull request opens on its conversation and keeps its changes a tab
    // away: `files` holds them per item, `folded` the files whose patch is
    // shut, and `rows` the list they are drawn from.
    this.tab = "conversation";
    this.files = {}; this.filesBusy = {}; this.filesError = null;
    this.folded = new Set(); this.rows = null; this.span = 320;
    // A pull request's own actions: the review and merge menus under their
    // buttons, and the one re-read that asks GitHub again whether it merges.
    this.reviewMenu = false; this.mergeMenu = false; this.rechecking = false;
    if (data) this.cache[`${this.kind}:${repo}#${number}`] = data;
    // The comment box: a markdown box whose text drives the Comment button.
    this.replyBox = new MarkdownBox(cx, {
      id: "item-reply", placeholder: "Leave a comment",
      onChange: (cx) => { const has = Boolean(this.replyBox.value.trim()); if (has !== this.replying) { this.replying = has; cx.notify(); } },
      onSubmit: (cx) => this.comment(cx),
    });
    this.reply = this.replyBox.state;
    // Its author may change the title and the body: the same box for the body, as
    // the new issue's form has one, and a field for the title above it.
    this.titleDraft = InputState.new({ placeholder: "Title" });
    this.titleDraft.on("change", (_e, cx) => cx.notify());
    this.bodyBox = new MarkdownBox(cx, { id: "item-body-edit", placeholder: "Describe it", rows: [6, 60], onSubmit: (cx) => this.saveEdit(cx) });
    this.editingBody = false;
    cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
    this.load(cx);
  }

  // Start work: the dialog does the worktree, the branch, the harness and the
  // brief. `mode` says what the agent is asked to do — for a pull request,
  // Review, Fix, or Resolve conflicts, which merges the base into its head in
  // the worktree first.
  startWork(mode) {
    if (!this.issue) return;
    openOverlay({ mod: "issues", kind: "dialog", width: 660, height: 720,
      props: { start: { ...startProps(this), ...(mode ? { mode } : {}) } } });
  }

  // GitHub answers UNKNOWN until it has worked the merge out: one more look a
  // moment later, and the same item is redrawn with the answer.
  recheck(id, cx) {
    if (this.rechecking) return;
    this.rechecking = true;
    const repo = this.repo, number = this.number, on = this.on, api = this.api;
    cx.spawn(async (cx) => {
      try {
        await cx.sleep(2500);
        const item = await api.view({ kind: "pull", repo, number, on });
        if (this.id() === id && item?.mergeable && item.mergeable !== "UNKNOWN") { this.cache[id] = item; this.issue = item; }
      } catch { /* the next open asks again */ }
      finally { this.rechecking = false; cx.notify(); }
    });
  }

  // Approve or ask for changes: the platform takes the verdict with the box's
  // text, the box empties, and the item reloads with the review state on it.
  // Request changes needs that text — the reason is the point of it.
  review(event, cx) {
    const body = this.reply.value().trim();
    if (event === "request" && !body) return;
    this.reviewMenu = false; this.closeMenu = false;
    this.change(event === "approve" ? "Approving" : "Requesting changes",
      () => this.api.review({ kind: this.kind, repo: this.repo, number: this.number, event, body, on: this.on }), cx, () => this.cleared());
  }

  // Merged the way it was asked, then reloaded: the state pill reads Merged and
  // the panel's list follows through `issues.changed`.
  merge(method, cx) {
    this.mergeMenu = false;
    this.change("Merging", () => this.api.merge({ kind: this.kind, repo: this.repo, number: this.number, method, on: this.on }), cx);
  }

  id() { return `${this.kind}:${this.repo}#${this.number}`; }

  // ---- the changes ----

  // Which half of a pull request shows: its conversation, or its changes. The
  // changes are fetched the first time they are asked for.
  setTab(tab, cx) {
    if (this.tab === tab) return;
    this.tab = tab; this.filesError = null;
    if (tab === "files") this.loadFiles(cx);
    cx.notify();
  }

  // A pull request's files and their patches: once per open, and again on
  // Refresh, which drops them before it reloads the item.
  loadFiles(cx) {
    const id = this.id(), repo = this.repo, number = this.number, on = this.on, api = this.api;
    if (this.filesBusy[id]) return;
    this.filesBusy[id] = true; this.filesError = null;
    cx.spawn(async (cx) => {
      try {
        const files = await api.files({ kind: "pull", repo, number, on });
        if (this.id() === id) { this.files[id] = files ?? []; this.rows = null; }
      } catch (e) { if (this.id() === id) this.filesError = String(e?.message ?? e); }
      finally { this.filesBusy[id] = false; cx.notify(); }
    });
  }

  // A file's row folds its patch away and back.
  fold(key, cx) {
    if (!key.startsWith("file:")) return;
    const file = this.files[this.id()]?.[Number(key.slice(5))];
    if (!file) return;
    const path = file.path;
    if (this.folded.has(path)) this.folded.delete(path); else this.folded.add(path);
    this.rows = null;
    cx.notify();
  }

  // The list the changes pane draws: a row per file, then its patch's lines
  // while the file is open. Built once per load or fold, and capped: a diff of
  // ten thousand lines costs a frame every scroll, and the web page has it all.
  changeRows(files) {
    const rows = [];
    files.forEach((file, index) => {
      rows.push({ kind: "file", key: `file:${index}`, file, open: !this.folded.has(file.path) });
      if (this.folded.has(file.path)) return;
      if (!file.patch) {
        rows.push({ kind: "note", key: `note:${index}`,
          text: file.tooLarge ? "Too large to show here — open it on the web" : "No text diff: a binary file, or a patch this long is left out" });
        return;
      }
      patchLines(file.patch).forEach((line, n) => rows.push({ ...line, key: `line:${index}:${n}` }));
    });
    if (rows.length > DIFF_ROWS) {
      rows.length = DIFF_ROWS;
      rows.push({ kind: "note", key: "more", text: "The rest of this diff is on the web page" });
    }
    let longest = 0;
    for (const r of rows) longest = Math.max(longest, r.text?.length ?? 0);
    this.span = Math.min(2400, Math.max(320, Math.round(longest * 6.6) + 104));
    return rows;
  }

  load(cx) {
    const repo = this.repo, number = this.number, kind = this.kind, id = this.id(), on = this.on, api = this.api;
    const current = () => this.id() === id;
    this.issue = this.cache[id] ?? null; this.error = null; this.loading = true;
    delete this.files[id];
    cx.spawn(async (cx) => {
      try {
        const [item, raw] = await Promise.all([
          api.view({ kind, repo, number, on }),
          api.timeline({ kind, repo, number, on }).catch(() => null),
        ]);
        this.cache[id] = item;
        if (raw) this.timelines[id] = timeline(raw);
        if (current()) this.issue = item;
        if (current() && this.tab === "files") this.loadFiles(cx);
        // A pull request's mergeability comes back UNKNOWN until GitHub has
        // worked it out: ask once more rather than sit on "checking".
        if (current() && kind === "pull" && item.mergeable === "UNKNOWN") this.recheck(id, cx);
      } catch (e) { if (current()) this.error = String(e?.message ?? e); }
      finally { if (current()) { this.loading = false; cx.notify(); } }
    });
  }

  go(repo, kind, number, cx) {
    if (repo === this.repo && kind === this.kind && number === this.number) return;
    this.history.push({ repo: this.repo, kind: this.kind, number: this.number });
    this.repo = repo; this.kind = kind; this.number = number; this.editing = false; this.editingBody = false; this.closeMenu = false;
    this.tab = "conversation"; this.filesError = null; this.reviewMenu = false; this.mergeMenu = false;
    this.load(cx); cx.notify();
  }

  back(cx) {
    const prev = this.history.pop();
    if (!prev) { this.onBack(cx); return; }
    this.repo = prev.repo; this.kind = prev.kind; this.number = prev.number; this.editing = false; this.editingBody = false; this.closeMenu = false;
    this.tab = "conversation"; this.filesError = null; this.reviewMenu = false; this.mergeMenu = false;
    this.load(cx); cx.notify();
  }

  link(url, cx) {
    const m = ISSUE_URL.exec(url);
    if (m && providerAt(m[1]) === this.api.name) this.go(m[2], m[3] === "issues" ? "issue" : "pull", m[4], cx);
    else openUrl(url);
  }

  // Runs the change on this item through its platform, then reloads it and
  // tells the panel.
  change(label, work, cx, after) {
    if (this.busy) return;
    const repo = this.repo, provider = this.api.name, kind = this.kind, number = this.number, id = this.id();
    this.busy = label; this.error = null; this.closeMenu = false;
    cx.spawn(async (cx) => {
      try {
        await work();
        after?.();
      } catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.busy = null;
        setShared("issues.changed", { repo, provider, kind, number, on: this.on, at: Date.now() });
        if (this.id() === id) this.load(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  cleared() { this.replyBox.reset(); this.replying = false; }

  comment(cx) {
    const body = this.reply.value().trim();
    if (body) this.change("Commenting", () => this.api.comment({ kind: this.kind, repo: this.repo, number: this.number, body, on: this.on }), cx, () => this.cleared());
  }

  // Closing or reopening takes what's in the comment box along, as on GitHub.
  setState(close, reason, cx) {
    const body = this.reply.value().trim();
    this.change(close ? "Closing" : "Reopening", () => this.api.setState({ kind: this.kind, repo: this.repo, number: this.number, close, reason, body, on: this.on }), cx, () => this.cleared());
  }

  // Shows the change at once; the reload after the platform confirms it.
  toggleLabel(l, cx) {
    const has = this.issue.labels.some((x) => x.name === l.name);
    this.issue.labels = has ? this.issue.labels.filter((x) => x.name !== l.name) : [...this.issue.labels, l];
    const labels = this.issue.labels.map((x) => x.name);
    this.change("Saving labels", () => this.api.toggleLabel({ kind: this.kind, repo: this.repo, number: this.number, name: l.name, add: !has, labels, on: this.on }), cx);
  }

  editLabels(cx) {
    this.editing = !this.editing;
    const repo = this.repo;
    if (this.editing && !this.labels[repo]) cx.spawn(async (cx) => {
      this.labels[repo] = await this.api.labels({ repo, on: this.on }).catch(() => []);
      cx.notify();
    });
    cx.notify();
  }

  // The title and the body are their author's to change; that, and who you are,
  // is all the panel knows — a repository's permissions are never fetched.
  canEdit() {
    return Boolean(this.issue) && Boolean(this.me) && login(this.issue.author) === this.me;
  }

  // In place: the title becomes a field and the body the editor, where the
  // markdown was, until Save or Cancel.
  beginEdit(cx) {
    const i = this.issue;
    if (!i || this.busy) return;
    this.titleDraft.set_value(i.title ?? "");
    this.bodyBox.setValue(i.body ?? "");
    this.editingBody = true; this.error = null;
    cx.notify();
  }

  endEdit(cx) {
    this.editingBody = false; this.error = null;
    cx.notify();
  }

  saveEdit(cx) {
    const title = this.titleDraft.value().trim();
    if (!title || this.busy || !this.editingBody) return;
    const body = this.bodyBox.value;
    this.change("Saving", () => this.api.edit({ kind: this.kind, repo: this.repo, number: this.number, title, body, on: this.on }), cx,
      () => { this.editingBody = false; });
  }

  // ---- drawing ----

  // A tab over the changes: its title over a 2px underline in GitHub's link
  // blue while it shows.
  tabButton(id, label, on, t, onClick) {
    return h_flex().id(`item-tab-${id}`).h(34).px(10).flex_none().items_center().cursor_pointer()
      .border_b(2).border_color(on ? GITHUB.link : t.background)
      .text_size(13).font_semibold().text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click(onClick)
      .child(label);
  }

  // Conversation | Files changed, for a pull request only, under its title.
  tabs(t, cx) {
    const pad = (this.width ?? 600) < 620 ? 14 : 32;
    return h_flex().flex_none().px(pad).gap(6).border_b(1).border_color(t.border)
      .child(this.tabButton("conversation", "Conversation", this.tab !== "files", t, (_e, cx) => this.setTab("conversation", cx)))
      .child(this.tabButton("files", "Files changed", this.tab === "files", t, (_e, cx) => this.setTab("files", cx)));
  }

  // Files changed: a line for every file with its additions and deletions and
  // its patch under it, both line numbers down the side as github.com numbers
  // them. A file's line folds its patch away; the list is virtual, since a pull
  // request can change more lines than a frame would survive.
  changesPane(t, cx) {
    const id = this.id(), files = this.files[id];
    const empty = (text, color) => v_flex().flex_1().min_h(0).items_center().justify_center().px(28)
      .child(div().text_size(12).text_center().text_color(color ?? t.muted).child(text));
    if (this.filesError) return empty(this.filesError, t.ansi1);
    if (!files) return empty(this.filesBusy[id] ? "Loading files changed…" : "The changes did not load");
    if (!files.length) return empty("This pull request changes no files");
    const adds = files.reduce((n, f) => n + (f.additions ?? 0), 0), dels = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
    if (!this.rows) this.rows = this.changeRows(files);
    const rows = this.rows;
    const list = v_virtual_list(`${id}-changes`, rows.length,
      rows.map((r) => (r.kind === "file" ? FILE_ROW : r.kind === "note" ? NOTE_ROW : r.kind === "@" ? HUNK_ROW : LINE_ROW)),
      (n) => rows[n].key,
      (range) => rows.slice(range.start, range.end).map((r) => this.changeLine(r, t)))
      .on_item_click((key, cx) => this.fold(key, cx));
    const head = h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(div().flex_none().child(`${files.length} file${files.length === 1 ? "" : "s"} changed`))
      .when(adds > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${adds}`)))
      .when(dels > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${dels}`)))
      .child(div().flex_1().min_w(0).truncate().text_right().child(this.filesBusy[id] ? "Loading…" : ""));
    return v_flex().flex_1().min_h(0).min_w(0)
      .child(head)
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .child(div().id(`${id}-changes-x`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.span).h_full().child(list)))
        .child(Scrollbar.vertical(`${id}-changes`).viewport_from_layout().absolute().inset_0()));
  }

  // One row of the changes: a file's header, a hunk's header or note, or a line
  // of a patch with the number it has on each side.
  changeLine(r, t) {
    if (r.kind === "file") {
      const f = r.file, adds = f.additions ?? 0, dels = f.deletions ?? 0;
      const tint = f.status === "added" ? t.ansi2 : f.status === "removed" || f.status === "deleted" ? t.ansi1
        : f.status === "renamed" || f.status === "copied" ? GITHUB.link : t.muted;
      return h_flex().w_full().h(FILE_ROW).flex_none().px(8).gap(6).items_center().overflow_hidden().cursor_pointer()
        .bg(t.raised).border_t(1).border_color(t.border)
        .child(div().w(10).flex_none().text_size(10).text_color(t.muted).child(r.open ? "▾" : "▸"))
        .child(div().w(10).flex_none().text_size(10).font_semibold().text_color(tint).child(LETTER[f.status] ?? "M"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(f.from ? `${f.from} → ${f.path}` : f.path))
        .when(adds > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${adds}`)))
        .when(dels > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${dels}`)));
    }
    if (r.kind === "note") return h_flex().w_full().h(NOTE_ROW).flex_none().px(28).items_center().overflow_hidden()
      .child(div().truncate().text_size(11).text_color(t.dim).child(r.text));
    if (r.kind === "@") return div().w_full().h(HUNK_ROW).flex_none().px(8).overflow_hidden().truncate()
      .bg(t.raised).text_size(11).text_color(t.dim).child(r.text);
    const color = r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.foreground;
    return h_flex().w_full().h(LINE_ROW).flex_none().gap(6).overflow_hidden()
      .when(r.kind === "+" || r.kind === "-", (e) => e.bg(color + "18"))
      .child(div().w(26).flex_none().text_right().text_color(t.dim).child(r.kind === "-" || r.kind === " " ? String(r.old ?? "") : ""))
      .child(div().w(26).flex_none().text_right().text_color(t.dim).child(r.kind === "+" || r.kind === " " ? String(r.next ?? "") : ""))
      .child(div().w(8).flex_none().text_color(color).child(r.kind === "-" || r.kind === "+" ? r.kind : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(r.kind === " " ? t.foreground : color).child(r.text || " "));
  }

  pic(name, url, size, t, cx) {
    const loading = loadAvatar(name, url);
    if (loading) cx.spawn(async (cx) => { if (await loading) cx.notify(); });
    const path = avatarPath(name);
    if (path) return image(path).size(size).flex_none().rounded(size / 2);
    const colors = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
    const color = colors[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % colors.length];
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().bg(color + "33")
      .text_size(Math.round(size * 0.5)).font_semibold().text_color(color).child(shown(name).slice(0, 1).toUpperCase());
  }

  glyph(name, size, color) { return div().size(size).flex_none().when(this.icons, (e) => e.child(svg(icon(name)).size(size).text_color(color))); }

  button(id, label, t, onClick, { primary = false, enabled = true, glyph = null, tint = null } = {}) {
    const solid = primary && enabled;
    return h_flex().id(id).h(32).px(12).gap(6).flex_none().items_center().justify_center().rounded(6).text_size(13).font_medium()
      .bg(solid ? GITHUB.open : t.raised).border_1().border_color(solid ? GITHUB.open : t.border).text_color(solid ? "#ffffff" : enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(solid ? "#29903b" : t.hover)).on_click(onClick))
      .when(Boolean(glyph), (e) => e.child(this.glyph(glyph, 14, tint ?? (solid ? "#ffffff" : t.muted))))
      .when(label !== "", (e) => e.child(label));
  }

  badge(label, t) {
    return div().h(20).px(7).flex_none().flex().items_center().rounded(10).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(label);
  }

  // A comment card: the avatar, who and when on its header bar, roles on the right,
  // then the markdown and its reactions.
  card(key, c, t, cx) {
    const author = login(this.issue.author);
    return v_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().bg(t.background)
      .child(h_flex().h(38).px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13)
        .child(this.pic(c.login, c.avatar, 20, t, cx))
        .child(div().font_semibold().text_color(t.foreground).child(shown(c.login)))
        .when(bot(c.login), (e) => e.child(this.badge("bot", t)))
        .child(div().text_color(t.muted).child(c.first ? `opened ${ago(c.at)}` : ago(c.at)))
        .child(div().flex_1())
        .when(!c.first && c.login === author, (e) => e.child(this.badge("Author", t)))
        .when(!c.first && Boolean(ROLES[c.role]), (e) => e.child(this.badge(ROLES[c.role], t)))
        .when(c.first && !this.editingBody && this.canEdit(), (e) => e.child(div().id("item-edit").text_size(12).text_color(GITHUB.link).cursor_pointer()
          .hover((s) => s.underline()).on_click((_e, cx) => this.beginEdit(cx)).child("Edit"))))
      .child(div().px(16).py(14).text_size(14).child(c.first && this.editingBody
        ? this.editForm(t, cx)
        : c.body?.trim()
          ? this.markdown(key, c.body, t, cx)
          : div().text_color(t.muted).italic().child("No description provided.")))
      .when(c.reactions?.length > 0, (e) => e.child(h_flex().px(16).pb(14).gap(6).flex_wrap()
        .children(c.reactions.map((r) => h_flex().h(26).px(8).gap(5).items_center().rounded(13).border_1().border_color(t.border).bg(t.raised)
          .text_size(12).text_color(t.muted).child(div().text_size(14).child(r.emoji)).child(String(r.count))))));
  }

  // The body while it is being changed: the editor, then Save and Cancel. The
  // editor wants a height of its own, so it takes what the panel leaves it.
  editForm(t, cx) {
    const ready = Boolean(this.titleDraft.value().trim()) && !this.busy;
    const footer = h_flex().px(10).py(10).gap(8).items_center().flex_wrap().justify_end().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(ready || this.busy ? "" : "A title is needed"))
      .child(this.button("item-edit-cancel", "Cancel", t, (_e, cx) => this.endEdit(cx), { enabled: !this.busy }))
      .child(this.button("item-edit-save", "Save", t, (_e, cx) => this.saveEdit(cx), { primary: true, enabled: ready }));
    return this.bodyBox.render(cx, { t, md: this.previewer("item-edit-preview", t), room: this.columnRoom(), footer });
  }


  // Markdown with its images drawn in between the text; `room` narrows a picture
  // for a preview that sits beside the sidebar.
  markdown(key, body, t, cx, room = null) {
    return markdownView({ key, body, t, cx, room: room ?? (this.width ?? 1100) - 60,
      repo: this.repo, api: this.api, onLink: (url, cx) => this.link(url, cx) });
  }

  // An event on the timeline: a round icon on the line, then who did what, when.
  event(key, e, t, cx) {
    const strong = (text) => div().font_semibold().text_color(t.foreground).child(text);
    const muted = (text) => div().child(text);
    const [glyph, fill] = e.kind === "closed" ? [e.reason === "not_planned" ? "skipped" : "done", e.reason === "not_planned" ? GITHUB.skipped : GITHUB.done]
      : e.kind === "reopened" ? ["issue", GITHUB.open]
      : [{ labels: "tag", assign: "user", renamed: "pencil", milestone: "milestone", mention: "link", commit: "commit" }[e.kind], null];
    const parts = [];
    switch (e.kind) {
      case "labels":
        if (e.added.length) parts.push(muted("added"), ...e.added.map((l) => labelChip(l, t)));
        if (e.added.length && e.removed.length) parts.push(muted("and"));
        if (e.removed.length) parts.push(muted("removed"), ...e.removed.map((l) => labelChip(l, t)));
        parts.push(muted(e.added.length + e.removed.length === 1 ? "label" : "labels"));
        break;
      case "assign":
        parts.push(...(e.who === e.login ? [muted(e.added ? "self-assigned this" : "removed their assignment")] : [muted(e.added ? "assigned" : "unassigned"), strong(shown(e.who))]));
        break;
      case "closed": parts.push(muted(`closed this as ${e.reason === "not_planned" ? "not planned" : "completed"}`)); break;
      case "reopened": parts.push(muted("reopened this")); break;
      case "renamed": parts.push(muted("changed the title"), div().line_through().child(e.from ?? ""), strong(e.to ?? "")); break;
      case "milestone": parts.push(muted(e.added ? "added this to the" : "removed this from the"), strong(e.title ?? ""), muted("milestone")); break;
      case "mention": parts.push(muted("mentioned this")); break;
      case "commit": parts.push(muted("added a commit that references this issue")); break;
    }
    const color = e.state === "OPEN" || e.state === "open" ? GITHUB.open : e.merged || e.state === "closed" ? GITHUB.done : t.muted;
    return v_flex().flex_none().gap(6)
      .child(h_flex().pl(6).gap(10).items_center()
        .child(div().size(28).flex_none().rounded(14).flex().items_center().justify_center().bg(fill ?? t.raised).border_1().border_color(fill ?? t.border)
          .child(this.glyph(glyph, 14, fill ? "#ffffff" : t.muted)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center().flex_wrap().text_size(13).text_color(t.muted)
          .child(this.pic(e.login, e.avatar, 16, t, cx)).child(strong(shown(e.login))).children(parts)
          .child(div().underline().child(ago(e.at)))))
      .when(e.kind === "mention", (el) => el.child(h_flex().id(key).ml(44).gap(8).items_start().cursor_pointer().text_size(13)
        .on_click((_ev, cx) => this.link(e.url, cx))
        .child(this.glyph(e.pr ? "pull" : "issue", 16, color))
        .child(div().flex_1().min_w(0).child(h_flex().gap(6).flex_wrap()
          .child(div().font_semibold().text_color(t.foreground).hover((s) => s.text_color(GITHUB.link)).child(e.title ?? ""))
          .child(div().text_color(t.muted).child(`${e.repo === this.repo ? "" : e.repo}#${e.number}`))))))
      .when(e.kind === "commit", (el) => el.child(h_flex().id(key).ml(44).gap(8).items_center().cursor_pointer().text_size(12)
        .on_click(() => openUrl(e.url))
        .child(div().px(6).py(1).rounded(5).bg(t.raised).border_1().border_color(t.border).text_color(t.muted).hover((s) => s.text_color(GITHUB.link))
          .child(e.sha.slice(0, 7)))));
  }

  joint(t) { return div().flex_none().ml(19).w(2).h(16).bg(t.border); }

  thread(i, t, cx) {
    const items = this.timelines[this.id()]
      ?? i.comments.map((c) => ({ kind: "comment", login: login(c.author), at: c.createdAt, body: c.body, role: c.authorAssociation, reactions: reactions(c.reactionGroups) }));
    const first = { kind: "comment", first: true, login: login(i.author), avatar: i.author?.avatarUrl, at: i.createdAt, body: i.body, reactions: reactions(i.reactionGroups) };
    return [this.card("item-body", first, t, cx), ...items.flatMap((e, n) => [this.joint(t),
      e.kind === "comment" ? this.card(`item-comment-${n}`, e, t, cx) : this.event(`item-event-${n}`, e, t, cx)])];
  }

  // The comment box, and the buttons that send it: the box is the same one a new
  // issue's body and an edited body are written in.
  composer(i, t, cx) {
    const open = i.state === "OPEN", busy = Boolean(this.busy), text = Boolean(this.replying);
    const tight = (this.width ?? 600) < 430;
    // Gitee's API can't set its rejected state, and a pull request has no reason.
    const reasons = this.kind === "issue" && this.api.name !== "gitee";
    const pull = this.kind === "pull";
    const footer = v_flex().flex_none()
      .child(h_flex().px(tight ? 8 : 12).py(10).gap(8).items_center().flex_wrap().justify_end().bg(t.background).border_t(1).border_color(t.border)
        .when(!tight, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child("Markdown is supported · ⌘/Ctrl+Enter comments")))
        .child(div().flex_1().when(!tight, (e) => e.w(0)))
        .child(open
          ? h_flex().gap(0).flex_none()
            .child(this.button("item-close-done", text && !tight ? "Close with comment" : "Close", t, (_e, cx) => this.setState(true, "completed", cx), { enabled: !busy, glyph: "done", tint: GITHUB.done }))
            .when(reasons, (e) => e.child(this.button("item-close-more", "▾", t, (_e, cx) => { this.closeMenu = !this.closeMenu; cx.notify(); }, { enabled: !busy })))
          : this.button("item-reopen", text && !tight ? "Reopen with comment" : "Reopen", t, (_e, cx) => this.setState(false, null, cx), { enabled: !busy, glyph: "issue", tint: GITHUB.open }))
        .when(pull, (e) => e.child(this.button("item-review", tight ? "" : "Review", t, (_e, cx) => { this.reviewMenu = !this.reviewMenu; this.closeMenu = false; cx.notify(); }, { enabled: !busy, glyph: "done", tint: GITHUB.open })))
        .child(this.button("item-comment", "Comment", t, (_e, cx) => this.comment(cx), { primary: true, enabled: text && !busy })))
      .when(open && Boolean(this.closeMenu) && reasons, (e) => e.child(v_flex().px(8).py(6).border_t(1).border_color(t.border).bg(t.raised)
        .children([["done", "Close as completed", "Done, closed, fixed, resolved", "completed", GITHUB.done], ["skipped", "Close as not planned", "Won't fix, can't repro, stale", "not planned", GITHUB.skipped]]
          .map(([glyph, title, note, reason, tint]) => h_flex().id(`item-close-${reason}`).px(8).py(6).gap(10).items_start().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setState(true, reason, cx))
            .child(div().pt(2).child(this.glyph(glyph, 16, tint)))
            .child(v_flex().child(div().text_size(13).font_semibold().child(title)).child(div().text_size(12).text_color(t.muted).child(note)))))))
      .when(pull && Boolean(this.reviewMenu), (e) => e.child(v_flex().px(8).py(6).border_t(1).border_color(t.border).bg(t.raised)
        .children([["done", "Approve", "Approve this pull request", "approve", GITHUB.open, true],
          ["skipped", "Request changes", "Ask for changes: your text is the reason", "request", GITHUB.skipped, text]]
          .map(([glyph, title, note, event, tint, enabled]) => h_flex().id(`item-review-${event}`).px(8).py(6).gap(10).items_start().rounded(6)
            .when(enabled && !busy, (f) => f.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.review(event, cx)))
            .when(!enabled || busy, (f) => f.opacity(0.5))
            .child(div().pt(2).child(this.glyph(glyph, 16, tint)))
            .child(v_flex().child(div().text_size(13).font_semibold().child(title)).child(div().text_size(12).text_color(t.muted).child(note)))))));
    return v_flex().flex_none().gap(10)
      .child(div().text_size(16).font_semibold().child("Add a comment"))
      .child(this.replyBox.render(cx, { t, md: this.previewer("item-preview", t), room: this.columnRoom(), footer }));
  }

  // The markdown a preview draws: this item's repository and links, in the room
  // the thread column leaves for a picture.
  previewer(key, t) {
    return (text, cx, room) => this.markdown(key, text, t, cx, room ?? this.columnRoom());
  }

  columnRoom() {
    const w = this.width ?? 1100;
    return Math.max(240, w - (w >= 620 ? 340 : 90));
  }


  section(title, t, body, action = null) {
    return v_flex().flex_none().gap(8).py(14).border_b(1).border_color(t.border)
      .child(h_flex().items_center().text_size(12).font_semibold().text_color(t.muted)
        .child(div().flex_1().child(title)).when(Boolean(action), (e) => e.child(action)))
      .child(body);
  }

  sidebar(i, t, cx) {
    const pull = this.kind === "pull", mine = i.assignees.some((a) => a.login === this.me), all = this.labels[this.repo];
    const assignable = this.api.assignable(this.kind);
    const none = (text) => div().text_size(12).text_color(t.muted).child(text);
    const action = (id, label, onClick) => div().id(id).text_size(12).font_normal().text_color(GITHUB.link).cursor_pointer().hover((s) => s.underline()).on_click(onClick).child(label);
    // Everyone who wrote or did something here, in order of appearance, people only.
    const people = new Map();
    for (const [name, url] of [[login(i.author), i.author?.avatarUrl], ...i.comments.map((c) => [login(c.author)]), ...(this.timelines[this.id()] ?? []).map((e) => [e.login, e.avatar])])
      if (!bot(name)) people.set(name, people.get(name) ?? url ?? null);
    const linked = this.kind === "issue" ? i.closedByPullRequestsReferences ?? [] : i.closingIssuesReferences ?? [];
    return v_flex().id("item-sidebar").w(264).flex_none().min_h(0).overflow_y_scrollbar().pl(8).pr(24).pt(6)
      .when(assignable, (e) => e.child(this.section(pull ? "Reviewers" : "Assignees", t, i.assignees.length
        ? v_flex().gap(8).children(i.assignees.map((a) => h_flex().gap(8).items_center().text_size(13).font_semibold().child(this.pic(a.login, null, 20, t, cx)).child(a.login)))
        : h_flex().gap(4).child(none("No one ·")).when(!pull && Boolean(this.me), (e2) => e2.child(action("item-assign", "Assign yourself", (_e, cx) => this.change("Assigning", () => this.api.assign({ kind: this.kind, repo: this.repo, number: this.number, assign: true, on: this.on }), cx)))),
        !pull && mine ? action("item-unassign", "Unassign me", (_e, cx) => this.change("Unassigning", () => this.api.assign({ kind: this.kind, repo: this.repo, number: this.number, assign: false, on: this.on }), cx)) : null)))
      .child(this.section("Labels", t, this.editing
        ? (!all ? none("Loading labels…") : v_flex().gap(1).children(all.map((l) => {
          const on = i.labels.some((x) => x.name === l.name);
          return h_flex().id(`label-${l.name}`).px(6).py(5).gap(8).items_start().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.toggleLabel(l, cx))
            .child(div().w(14).flex_none().text_size(12).text_color(GITHUB.link).child(on ? "✓" : ""))
            .child(div().mt(3).size(12).flex_none().rounded(6).bg(`#${l.color}`))
            .child(v_flex().flex_1().min_w(0).child(div().text_size(13).font_semibold().child(l.name))
              .when(Boolean(l.description), (e) => e.child(div().text_size(12).text_color(t.muted).truncate().child(l.description))));
        })))
        : i.labels.length ? h_flex().gap(4).flex_wrap().children(i.labels.map((l) => labelChip(l, t))) : none("No labels"),
        action("item-labels-edit", this.editing ? "Done" : "Edit", (_e, cx) => this.editLabels(cx))))
      .child(this.section("Milestone", t, i.milestone?.title
        ? h_flex().gap(6).items_center().text_size(13).font_semibold().child(this.glyph("milestone", 14, t.muted)).child(i.milestone.title)
        : none("No milestone")))
      .when(linked.length > 0 || !pull, (e) => e.child(this.section(pull ? "Closes" : "Development", t, linked.length
        ? v_flex().gap(8).children(linked.map((p) => h_flex().id(`item-link-${p.number}`).gap(8).items_start().cursor_pointer().text_size(13)
          .on_click((_e, cx) => this.link(p.url, cx))
          .child(div().pt(1).child(this.glyph(pull ? "issue" : "pull", 14, GITHUB.done)))
          .child(v_flex().child(div().font_semibold().hover((s) => s.text_color(GITHUB.link)).child(`#${p.number}`))
            .child(div().text_size(12).text_color(t.muted).child(p.repository?.name ?? "")))))
        : none(this.api.name === "gitee" ? "Gitee doesn't list these" : "No branches or pull requests"))))
      .child(this.section("Participants", t, h_flex().gap(4).flex_wrap().children([...people].slice(0, 18).map(([name, url]) => this.pic(name, url, 24, t, cx)))));
  }

  // Narrow (the side panel): the meta that the sidebar would hold, under the title.
  meta(i, t) {
    return h_flex().gap(6).items_center().flex_wrap().text_size(12)
      .children(i.labels.map((l) => labelChip(l, t)))
      .when(Boolean(i.milestone?.title), (e) => e.child(div().text_color(t.muted).child(i.milestone.title)))
      .when(i.assignees.length > 0, (e) => e.child(div().text_color(t.muted).child(i.assignees.map((a) => a.login).join(", "))));
  }

  render(cx) {
    const t = theme(), i = this.issue;
    const narrow = (this.width ?? 600) < 620;
    const pad = narrow ? 14 : 32;
    const bar = h_flex().h(32).gap(8).items_center()
      .child(this.button("item-back", this.history.length > 0 ? "Back" : "List", t, (_e, cx) => this.back(cx), { glyph: "back" }))
      .when(Boolean(i) && !this.loading, (e) => e.child(this.button("item-work", (this.width ?? 600) >= 430 ? "Start work" : "", t,
        (_e, cx) => this.startWork(), { glyph: "work", primary: true })))
      .when((this.width ?? 600) >= 430, (e) => e.child(div().text_size(13).text_color(t.muted).truncate().child(this.kind === "pull" ? `${this.repo} · pull request` : this.repo)))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).truncate().child(i && this.error ? this.error : ""))
      .when(this.loading || Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)).child(this.busy ?? "Loading")))
      .when(Boolean(i) && !this.loading && !this.busy, (e) => e.child(this.button("item-refresh", "", t, (_e, cx) => { this.load(cx); cx.notify(); }, { glyph: "refresh" })))
      .when(Boolean(i), (e) => e.child(this.button("item-copy", "", t, () => copyMenu({ repo: this.repo, provider: this.api.name, kind: this.kind, number: i.number, ref: i.ref, title: i.title, url: i.url }), { glyph: "copy" })))
      .when(Boolean(i), (e) => e.child(this.button("item-open-web", "", t, () => openUrl(i.url), { glyph: "external" })));
    if (!i) return v_flex().id("item").size_full().bg(t.background).text_color(t.foreground).text_size(14).px(pad).pt(16).gap(20)
      .child(bar)
      .child(this.loading ? div().text_color(t.muted).child(`Loading #${this.number}…`) : div().text_color(t.ansi1).child(this.error ?? ""));

    const pull = this.kind === "pull";
    const ref = i.ref ?? `#${i.number}`;
    const [state, color, glyph] = i.state === "OPEN" ? [i.stateText ?? "Open", i.stateColor ?? GITHUB.open, "issue"] : i.state === "MERGED" ? ["Merged", i.stateColor ?? GITHUB.done, "pull"]
      : i.stateReason === "NOT_PLANNED" ? [i.stateText ?? "Closed", i.stateColor ?? GITHUB.skipped, "skipped"] : [i.stateText ?? "Closed", i.stateColor ?? GITHUB.done, "done"];
    return v_flex().id("item").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 1 || Math.abs((this.height ?? 0) - size.height) > 1) { this.width = size.width; this.height = size.height; cx.notify(); } })
      .child(v_flex().flex_none().px(pad).pt(12).pb(14).gap(10).border_b(1).border_color(t.border)
        .child(bar)
        // Word by word, so the title wraps like text with the reference after its last
        // word. Chinese has no spaces to wrap at, so its title is one wrapping block
        // with the reference under it.
        .child(this.editingBody
          ? h_flex().id("item-title-edit").gap(10).items_center()
            .child(div().flex_1().min_w(0).h(narrow ? 32 : 40).px(9).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.titleDraft).h_full().text_size(narrow ? 16 : 20).text_color(t.foreground)))
            .child(div().text_size(13).text_color(t.muted).child(ref))
          : CJK.test(i.title)
            ? v_flex().gap(2)
              .child(div().text_size(narrow ? 20 : 26).child(i.title))
              .child(div().text_color(t.muted).child(ref))
            : h_flex().flex_wrap().gap_x(8).text_size(narrow ? 20 : 28).children(i.title.split(/\s+/).filter(Boolean).map((w) => div().child(w)))
              .child(div().text_color(t.muted).child(ref)))
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(h_flex().h(narrow ? 26 : 32).px(narrow ? 9 : 12).gap(6).items_center().rounded(narrow ? 13 : 16).bg(color).text_color("#ffffff").text_size(narrow ? 12 : 14).font_semibold()
            .child(this.glyph(glyph, narrow ? 13 : 16, "#ffffff")).child(state))
          .when(pull, (e) => e.child(div().text_size(12).text_color(t.muted).child("Pull request"))))
        .when(narrow && (i.labels.length > 0 || i.milestone?.title || i.assignees.length > 0), (e) => e.child(this.meta(i, t))))
      .when(pull, (e) => e.child(this.tabs(t, cx)))
      .child(this.tab === "files" && pull ? this.changesPane(t, cx) : this.conversation(i, t, cx));
  }

  // The conversation: the timeline and the comment box on the left, the sidebar
  // on the right where the panel is wide enough to hold one.
  conversation(i, t, cx) {
    const narrow = (this.width ?? 600) < 620, pad = narrow ? 14 : 32;
    const merge = this.mergeBox(i, t, cx);
    return h_flex().flex_1().min_h(0).items_start()
      .child(v_flex().id(`item-thread-${this.id()}`).flex_1().min_w(0).h_full().overflow_y_scrollbar().pl(pad).pr(narrow ? pad : 24).py(16)
        .children(this.thread(i, t, cx))
        .child(div().flex_none().h(24)).child(this.composer(i, t, cx))
        .when(Boolean(merge), (e) => e.child(div().flex_none().h(24)).child(merge))
        .child(div().flex_none().h(24)))
      .when(!narrow, (e) => e.child(this.sidebar(i, t, cx)));
  }

  // The merge at the foot of a pull request's conversation, where github.com
  // puts it: what stands in the way — conflicts, a review, a branch whose
  // mergeability GitHub is still working out — and the buttons to merge it or
  // to hand the conflicts to an agent. A merged or closed one just says so.
  mergeBox(i, t, cx) {
    if (this.kind !== "pull") return null;
    const busy = Boolean(this.busy), narrow = (this.width ?? 600) < 430;
    const open = i.state === "OPEN", merged = i.state === "MERGED";
    const conflicts = i.mergeable === "CONFLICTING" || i.mergeable === false || i.mergeState === "DIRTY";
    const checking = open && !conflicts && i.mergeable === "UNKNOWN";
    const changes = i.reviewDecision === "CHANGES_REQUESTED", required = i.reviewDecision === "REVIEW_REQUIRED";
    const blocked = changes || required || i.mergeState === "BLOCKED";
    const [glyph, tint, line] = merged ? ["done", GITHUB.done, "This pull request is merged"]
      : !open ? ["skipped", t.muted, "Closed without merging"]
      : conflicts ? ["skipped", t.ansi1, "This branch has conflicts that must be resolved"]
      : checking ? ["pull", t.muted, "Checking whether it can be merged…"]
      : changes ? ["skipped", GITHUB.skipped, "Merging is blocked: changes were requested"]
      : required ? ["skipped", GITHUB.skipped, "Merging is blocked: a review is required"]
      : blocked ? ["skipped", GITHUB.skipped, "Merging is blocked: a check or a review is missing"]
      : ["done", GITHUB.open, "This branch can be merged"];
    const said = (i.reviews ?? []).map((r) => `${r.login} ${r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "asked for changes" : "reviewed"}`).join(" · ");
    const ready = open && !conflicts && !checking && !blocked;
    return v_flex().flex_none().gap(10).p(14).rounded(6).border_1().border_color(t.border).bg(t.raised)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child("Merge"))
      .child(h_flex().gap(6).items_center().flex_wrap().text_size(13)
        .child(this.glyph(glyph, 14, tint))
        .child(div().text_color(merged ? GITHUB.done : conflicts || blocked ? t.ansi1 : t.foreground).child(line)))
      .when(Boolean(said) && (merged || changes || required), (e) => e.child(div().text_size(11.5).text_color(t.muted).child(said)))
      // Conflicts are the agent's: a worktree on the head branch, the base
      // merged into it, and a brief that says to resolve them there.
      .when(conflicts && !merged, (e) => e.child(v_flex().gap(6)
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(this.button("item-resolve", narrow ? "Resolve" : "Resolve conflicts", t, (_e, cx) => this.startWork("conflict"), { enabled: !busy, glyph: "work" })))
        .when(i.crossRepo, (f) => f.child(div().text_size(11).text_color(t.dim)
          .child("The head branch belongs to a fork: the resolution stays on your machine until you push it there.")))))
      .when(ready, (e) => e.child(h_flex().gap(0).items_center().flex_wrap()
        .child(this.button("item-merge", narrow ? "Merge" : "Merge pull request", t, (_e, cx) => this.merge("merge", cx), { primary: true, enabled: !busy, glyph: "pull" }))
        .child(this.button("item-merge-more", "▾", t, (_e, cx) => { this.mergeMenu = !this.mergeMenu; cx.notify(); }, { enabled: !busy }))))
      .when(open && !ready && !conflicts && !checking, (e) => e.child(this.button("item-merge-blocked", narrow ? "Merge" : "Merge pull request", t, () => {}, { primary: true, enabled: false })))
      .when(open && Boolean(this.mergeMenu) && ready, (e) => e.child(v_flex().gap(1)
        .children([["merge", "Create a merge commit", "All commits, plus a merge commit"],
          ["squash", "Squash and merge", "One commit with one message"],
          ["rebase", "Rebase and merge", "One commit per change, no merge commit"]]
          .map(([id, title, note]) => h_flex().id(`item-merge-${id}`).px(8).py(6).gap(10).items_start().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.merge(id, cx))
            .child(div().pt(2).child(this.glyph("pull", 14, t.muted)))
            .child(v_flex().child(div().text_size(12.5).font_semibold().child(title)).child(div().text_size(11.5).text_color(t.muted).child(note)))))));
  }
}
