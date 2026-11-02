import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, hc, run, layout, theme, openOverlay, closeOverlay, notify, props, appHome, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { Viewer, copyMenu } from "./viewer.js";
import { icons, icon } from "./icons.js";
import { providerOf, remoteRepo, ORDER } from "./api.js";

// Where the focused pane is, as the Changes panel finds it. A focused mod pane
// (this one, as a split) has no folder of its own: it keeps the last one.
function location(last) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane && !pane.terminal && last) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const FULL = 300;                 // open issues (or pull requests) fetched when a repo has no cache yet
const CLOSED = 100;               // and the most recently closed ones
const SYNC = 30000;               // how often the changes since the last sync are fetched
const RESYNC = 6 * 3600 * 1000;   // a full fetch now and then catches what search misses (deleted, transferred)
const MENTIONS = 8;
const VERSION = 3;                // a cache from another version starts with a full fetch
const KIND = { issue: "Issues", pull: "PRs" };
const folder = () => `${appHome()}/data/issues`;
const file = (provider, repo, kind) => `${folder()}/${provider}-${repo.replace("/", "__")}-${kind}.json`;
const skey = (provider, repo, kind) => `${provider}:${repo}:${kind}`;

// GitHub's own sort orders; `order` is the number on GitHub and the id on Gitee.
const SORTS = {
  newest: { label: "Newest", by: (a, b) => b.order - a.order },
  oldest: { label: "Oldest", by: (a, b) => a.order - b.order },
  updated: { label: "Recently updated", by: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) },
  stale: { label: "Least recently updated", by: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) },
  comments: { label: "Most commented", by: (a, b) => (b.commentCount ?? b.comments.length) - (a.commentCount ?? a.comments.length) || b.order - a.order },
};
const sort = () => SORTS[shared("issues.sort")] ? shared("issues.sort") : "newest";

// #123 (GitHub) or #IKS135 (Gitee), and links to this repo's issues and pull
// requests: the lowest line on screen (the newest) first, each line read
// left to right.
function mentions(text, repo, provider) {
  const id = provider === "gitee" ? "[A-Za-z][A-Za-z0-9]{3,9}" : "\\d{1,5}";
  const pattern = new RegExp(`(?:^|[^\\w&/#])#(${id})(?![\\w-])|${provider}\\.com/${repo.replace(/\./g, "\\.")}/(?:issues|pull|pulls)/(${id})`, "g");
  const found = [];
  for (const line of text.split("\n").reverse()) {
    for (const m of line.matchAll(pattern)) {
      const n = m[1] ?? m[2];
      if (!found.includes(n)) found.push(n);
    }
  }
  return found;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// As one of the side panels beside Files and Changes, only the one shown works.
function hidden() {
  const root = layout(), body = find(root, "panel-body");
  if (!body?.children?.some((c) => c.content?.mod === "issues")) return false;
  return find(root, "panel")?.hidden || find(body, body.active)?.content?.mod !== "issues";
}

function remembered(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; }
}

function upsert(store, items) {
  const changed = new Set(items.map((i) => i.number));
  store.issues = [...store.issues.filter((i) => !changed.has(i.number)), ...items];
  for (const i of items) store.known[i.number] = { number: i.number, ref: i.ref, title: i.title, state: i.state };
}

async function save(provider, repo, kind, store) {
  await fs.mkdir(folder(), { recursive: true });
  await fs.writeFile(file(provider, repo, kind), JSON.stringify(store));
}

// The panel; its Issues button beside the tab bar's Files and Changes (props
// { button: true }); one issue or pull request in place of the list; or the sort
// menu and the copy menu, as overlays of the panel.
export default class Issues extends View {
  init(_props, cx) {
    const { overlay, sortMenu, copyMenu: copying, button } = props() ?? {};
    if (sortMenu) { this.menu = overlay; return; }
    if (copying) { this.copying = { ...copying, overlay }; return; }
    if (button) {
      // The tab bar restores each space's panel only if it's one of these.
      const panels = shared("workspace.panels") ?? ["files", "changes"];
      if (!panels.includes("issues")) setShared("workspace.panels", [...panels, "issues"]);
      this.button = true;
      cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
      return;
    }
    // Per repository and kind: its open and recently closed items in full, what
    // other numbers are, and when they were synced.
    this.stores = {}; this.repos = remembered("repos"); this.logins = remembered("logins");
    // A cache from before Gitee: a bare "owner/name" is a GitHub repo.
    for (const [id, found] of Object.entries(this.repos)) if (typeof found === "string") this.repos[id] = { provider: "github", repo: found };
    this.spaceRepos = remembered("spaces"); this.repo = null; this.provider = "github";
    this.kind = shared("issues.kind") ?? "issue";
    this.detailView = null;
    this.query = ""; this.state = "OPEN"; this.mine = false; this.mentioned = []; this.changedAt = shared("issues.changed")?.at;
    this.input = InputState.new({ placeholder: "Filter" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // A new issue, typed in the panel: the list gives way to its title and body
    // until Create, Cancel or Escape.
    this.composing = false; this.posting = false; this.postError = null;
    this.draftTitle = InputState.new({ placeholder: "Title" });
    this.draftBody = TextareaState.new({ placeholder: "Describe it (markdown)" });
    this.draftBody.set_auto_grow(4, 16);
    this.draftBody.on("submit", (e, cx) => { if (e.secondary) this.create(cx); });
    cx.spawn(async (cx) => { await icons(); this.icons = true; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(SYNC, (cx) => { if (!hidden()) this.refresh(cx); });
    cx.timer.every(3000, (cx) => { if (!hidden() && this.kind === "issue") this.scan(cx); });
  }

  toolbar(t) {
    const root = layout(), panel = find(root, "panel"), on = panel && !panel.hidden && find(root, "panel-body")?.active === "issues";
    return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("panel-issues").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: "issues" }); run("layout.show", { id: "panel" }); }
        })
        .child(div().size(14).when(this.icons, (e) => e.child(svg(icon("issue")).size(14)))).child("Issues"));
  }

  where() { return (this.last = location(this.last)); }

  context() { return JSON.stringify([this.where(), focused()?.space]); }

  // The folder's remotes decide the platform: a GitHub one wins over a Gitee one.
  // The answer is kept per folder, and read once more each time the mod starts,
  // so a remote added or removed since doesn't leave the panel on the old one.
  async repoFor(cwd, on) {
    const id = JSON.stringify([cwd, on]);
    this.checked ??= {};
    if (this.checked[id]) return this.repos[id] ?? null;
    this.checked[id] = true;
    const r = await exec("git", ["remote", "-v"], { cwd, on });
    const remotes = r.code === 0 ? r.stdout.split("\n").map((line) => remoteRepo(line.split(/\s+/)[1] ?? "")).filter(Boolean) : [];
    const found = ORDER.map((provider) => remotes.find((m) => m.provider === provider)).find(Boolean);
    if (found) this.repos[id] = found;
    else if (r.code === 0) delete this.repos[id];
    if (found || r.code === 0) localStorage.setItem("repos", JSON.stringify(this.repos));
    return this.repos[id] ?? null;
  }

  async login(provider, on) {
    const id = `${provider}:${on ?? ""}`;
    if (!this.logins[id]) {
      const me = await providerOf(provider).me({ on });
      if (me) { this.logins[id] = me; localStorage.setItem("logins", JSON.stringify(this.logins)); }
    }
    return this.logins[id];
  }

  async store(repo, provider, kind) {
    const id = skey(provider, repo, kind);
    if (!this.stores[id]) {
      const saved = await fs.readFile(file(provider, repo, kind), "utf8").then(JSON.parse).catch(() => null);
      this.stores[id] ??= saved ?? { issues: [], known: {}, synced: 0, full: 0 };
    }
    return this.stores[id];
  }

  // Everything open plus the latest closed the first time (and every few hours);
  // after that only what changed since the last sync, in either state.
  async pull(repo, provider, kind, store, on) {
    const api = providerOf(provider);
    const started = Date.now(), full = store.version !== VERSION || started - store.full > RESYNC;
    let got;
    if (full) {
      got = [...await api.items({ kind, repo, on, state: "open", limit: FULL }), ...await api.items({ kind, repo, on, state: "closed", limit: CLOSED })];
      store.issues = []; store.full = started; store.version = VERSION;
    } else {
      got = await api.items({ kind, repo, on, state: "all", limit: 200, since: store.synced - 120000 });
    }
    upsert(store, got);
    store.synced = started;
    await save(provider, repo, kind, store);
    return full || got.length > 0;
  }

  // Each space shows the repo its own terminals were last in: a folder outside
  // any repository (home, say) keeps it, and a space never in one shows none.
  pick(found, space, on) {
    if (found) { this.spaceRepos[space] = { ...found, on }; localStorage.setItem("spaces", JSON.stringify(this.spaceRepos)); }
    const choice = this.spaceRepos[space] ?? this.guess(space);
    if ((choice?.repo ?? null) !== this.repo) { this.repo = choice?.repo ?? null; this.mentioned = []; this.showList(); }
    this.provider = choice?.provider ?? "github";
    this.repoOn = choice?.on ?? null;
  }

  // A space not seen yet: any of its terminals in a folder whose repo is known.
  guess(space) {
    const s = spaces().find((x) => x.id === space), tabs = new Set(s?.tabs.map((tab) => tab.id) ?? []), on = s?.machine ?? null;
    for (const p of panes()) {
      const repo = tabs.has(p.tab) && p.cwd ? this.repos[JSON.stringify([p.cwd, on])] : null;
      if (repo) return { ...repo, on };
    }
    return null;
  }

  refresh(cx) {
    const { cwd, on } = this.where(), context = this.context(), space = focused()?.space;
    if (context !== this.ctx) {
      // A folder seen before shows its repo's cached items at once.
      this.ctx = context; this.error = null;
      this.pick(cwd ? this.repos[JSON.stringify([cwd, on])] : null, space, on);
    }
    if (this.syncing) { this.again = true; return; }
    this.syncing = true;
    cx.spawn(async (cx) => {
      try {
        const found = cwd ? await this.repoFor(cwd, on) : null;
        if (this.context() !== context) return;
        this.pick(found, space, on);
        const repo = this.repo, kind = this.kind;
        if (!repo) return;
        const store = await this.store(repo, this.provider, kind);
        cx.notify();
        this.me = await this.login(this.provider, this.repoOn);
        if (await this.pull(repo, this.provider, kind, store, this.repoOn)) cx.notify();
        if (this.context() === context) this.error = null;
      } catch (e) { if (this.context() === context) this.error = String(e?.message ?? e); }
      finally {
        this.syncing = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // The view changed an item: fetch just that one, so the list shows it now.
  changed({ repo, provider, kind, number, on }, cx) {
    const store = this.stores[skey(provider, repo, kind)];
    if (!store) return;
    cx.spawn(async (cx) => {
      const item = await providerOf(provider).view({ kind, repo, number, on }).catch(() => null);
      if (!item) return;
      upsert(store, [item]);
      await save(provider, repo, kind, store).catch(() => null);
      cx.notify();
    });
  }

  // The focused terminal's screen and recent history, for the issues it mentions.
  // A focused mod pane has no terminal: the last one stays.
  scan(cx) {
    const terminal = (this.terminal = focused()?.terminal ?? this.terminal), repo = this.repo;
    const store = this.stores[skey(this.provider, repo, "issue")];
    if (this.scanning || !terminal || !store) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", terminal, "--lines", "300"]);
        if (r.code !== 0 || repo !== this.repo) return;
        const numbers = mentions(r.stdout, repo, this.provider).filter((n) => store.known[n] !== null);
        for (const n of numbers.slice(0, MENTIONS)) {
          if (n in store.known) continue;
          const found = await providerOf(this.provider).view({ kind: "issue", repo, number: n, on: this.repoOn ?? null }).catch(() => null);
          store.known[n] = found ? { number: found.number, ref: found.ref, title: found.title, state: found.state, url: found.url } : null;
        }
        if (repo !== this.repo) return;
        const mentioned = numbers.map((n) => store.known[n]).filter(Boolean).slice(0, MENTIONS);
        if (JSON.stringify(mentioned) !== JSON.stringify(this.mentioned)) { this.mentioned = mentioned; cx.notify(); }
      } catch { /* the terminal closed, or the platform is missing: try again next time */ }
      finally { this.scanning = false; }
    });
  }

  items() { return this.stores[skey(this.provider, this.repo, this.kind)]?.issues ?? []; }

  // The item in the panel, in place of the list, with Back to the list.
  open(i, cx) {
    if (!i) return;
    this.detailView = new Viewer({
      repo: this.repo, provider: this.provider, kind: this.kind, number: i.number,
      on: this.repoOn ?? null, data: i, me: this.me, folder: this.where().cwd,
    }, cx, { onBack: (cx) => { this.showList(); cx.notify(); } });
    cx.notify();
  }

  showList() { this.detailView = null; }

  setKind(kind, cx) {
    if (this.kind === kind) return;
    this.kind = kind; setShared("issues.kind", kind);
    this.showList(); this.mentioned = []; this.error = null;
    this.refresh(cx); cx.notify();
  }

  shown() {
    const q = this.query.trim().toLowerCase();
    return this.items().filter((i) => i.state === this.state
      && (!this.mine || i.assignees.some((a) => a.login === this.me))
      && (!q || `${i.ref} ${i.title}`.toLowerCase().includes(q))).sort(SORTS[sort()].by);
  }

  row(i, t, where = "item") {
    const closed = i.state && i.state !== "OPEN";
    return h_flex().id(`${where}-${i.number}`).flex_none().px(10).py(6).gap(8).items_start().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(i, cx))
      .on_mouse_down("right", () => copyMenu({ repo: this.repo, provider: this.provider, kind: this.kind, number: i.number, ref: i.ref, title: i.title, url: i.url }, "pointer"))
      .child(div().flex_none().w(i.ref && i.ref.length > 3 ? 62 : 40).text_color(closed ? t.ansi5 : t.dim).child(i.ref ?? `#${i.number}`))
      .child(div().flex_1().min_w(0).text_color(closed && where !== "item" ? t.muted : t.foreground).child(i.title));
  }

  heading(label, t) {
    return div().flex_none().px(10).pt(8).pb(4).text_size(11).font_semibold().text_color(t.dim).child(label);
  }

  segment(id, label, on, t, onClick) {
    return div().id(id).h(24).px(9).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_semibold())
      .hover((s) => s.bg(on ? t.selected : t.hover)).on_click(onClick).child(label);
  }

  sortMenu(t) {
    const current = sort();
    return v_flex().id("issues-sort").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(div().px(8).pt(4).pb(6).text_size(11).font_semibold().text_color(t.dim).child("Sort by"))
      .children(Object.entries(SORTS).map(([key, s]) => h_flex().id(`sort-${key}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((e) => e.bg(t.hover)).on_click(() => { setShared("issues.sort", key); closeOverlay(this.menu); })
        .child(div().w(14).text_color(t.accent).child(key === current ? "✓" : "")).child(s.label)));
  }

  copyMenu(t) {
    const { url, ref, number, title, overlay } = this.copying;
    const items = [["Copy link", url], ["Copy reference", ref], ["Copy number", number], ["Copy number and title", title]].filter(([, text]) => text);
    return v_flex().id("issues-copy").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(12)
      .children(items.map(([label, text], n) => v_flex().id(`copy-${n}`).px(8).py(6).rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_click((_e, cx) => { cx.write_to_clipboard(text); notify({ title: "Copied", body: text, level: "success", timeout: 2500 }); closeOverlay(overlay); })
        .child(div().font_semibold().child(label))
        .child(div().text_size(11).text_color(t.muted).truncate().child(text))));
  }

  // The list's place while a new issue is written: a title, a body, and Create
  // under them. Escape is not wired: Cancel is the way back.
  form(t, cx) {
    const ready = Boolean(this.draftTitle.value().trim()) && !this.posting;
    const green = "#238636";
    const button = (id, label, onClick, primary) => h_flex().id(id).h(28).px(10).flex_none().items_center().justify_center().rounded(7).text_size(12)
      .bg(primary && ready ? green : t.raised).border_1().border_color(primary && ready ? green : t.border).text_color(primary ? "#ffffff" : t.muted)
      .when(primary ? ready : true, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? "#29903b" : t.hover)).on_click(onClick))
      .child(label);
    return v_flex().id("issues-form").flex_1().min_h(0).p(12).gap(10)
      .child(h_flex().flex_none().h(30).px(9).items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .child(Input.new(this.draftTitle).h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().flex_1().min_h(0).p(8).rounded(7).border_1().border_color(t.border).overflow_y_scrollbar()
        .child(Textarea.new(this.draftBody).text_size(13).text_color(t.foreground)))
      .when(Boolean(this.postError), (e) => e.child(div().flex_none().text_size(12).text_color(t.ansi1).child(this.postError)))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child("⌘/Ctrl+Enter creates it"))
        .child(button("issues-cancel", "Cancel", (_e, cx) => { this.composing = false; this.postError = null; cx.notify(); }, false))
        .child(button("issues-create", this.posting ? "Creating…" : "Create issue", (_e, cx) => this.create(cx), true)));
  }

  // Create it on the platform, then show it: the list refreshes underneath and the
  // new issue opens in the panel as if it had been clicked.
  async create(cx) {
    const title = this.draftTitle.value().trim();
    if (!title || this.posting || !this.repo) return;
    this.posting = true; this.postError = null; cx.notify();
    try {
      const made = await providerOf(this.provider).create({ repo: this.repo, title, body: this.draftBody.value(), on: this.repoOn ?? null });
      this.draftTitle.set_value(""); this.draftBody.set_value("");
      this.composing = false;
      this.refresh(cx);
      if (made) this.open(made, cx);
    } catch (e) {
      this.postError = String(e?.message ?? e);
    }
    this.posting = false; cx.notify();
  }

  render(cx) {
    const t = theme();
    if (this.menu) return this.sortMenu(t);
    if (this.copying) return this.copyMenu(t);
    if (this.button) return this.toolbar(t);
    if (this.detailView) return this.detailView.render(cx);
    const away = hidden();
    if (this.away && !away) { this.refresh(cx); if (this.kind === "issue") this.scan(cx); }
    this.away = away;
    if (!away && this.context() !== this.ctx) this.refresh(cx);
    const changed = shared("issues.changed");
    if (changed?.at && changed.at !== this.changedAt) { this.changedAt = changed.at; this.changed(changed, cx); }

    const all = this.items(), list = this.shown(), cached = Boolean(this.stores[skey(this.provider, this.repo, this.kind)]?.synced);
    const open = all.filter((i) => i.state === "OPEN").length, closed = all.length - open;
    const noun = this.kind === "pull" ? "pull requests" : "issues";
    const notFound = !cached ? "Loading…"
      : this.query.trim() ? "Nothing matches"
      : this.mine ? `No ${this.state === "OPEN" ? "open" : "closed"} ${noun} assigned to you`
      : `No ${this.state === "OPEN" ? "open" : "closed"} ${noun}`;
    // Gitee's token is what writing needs, and what lifts its 60-an-hour anonymous limit.
    const empty = this.error && this.provider === "gitee" && !this.me
      ? `${this.error} · Put a Gitee token in ${providerOf("gitee").tokenPath()} to write and stop the 60-an-hour anonymous limit`
      : this.error || notFound;
    const panel = v_flex().id("issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs((this.w ?? 0) - size.width) > 1) { this.w = size.width; cx.notify(); } });
    // Nothing to show until a terminal in a repository has had focus once.
    if (!this.repo) return panel.child(v_flex().flex_1().items_center().justify_center().gap(10).px(36)
      .child(div().size(28).when(this.icons, (e) => e.child(svg(icon("issue")).size(28).text_color(t.dim))))
      .child(div().font_semibold().text_color(t.muted).child(this.syncing ? "Looking for a repository…" : "No repository yet"))
      .child(div().text_size(12).text_color(t.dim).text_center().child("Focus a terminal inside a GitHub or Gitee repository and its issues show up here.")));
    // The header stays while a new issue is written; the list gives way to it.
    const frame = panel.child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().size(14).flex_none().when(this.icons, (e) => e.child(svg(icon("issue")).size(14).text_color(t.ansi2))))
      .child(div().font_semibold().child("Issues"))
      .when(this.provider === "gitee", (e) => e.child(div().h(18).px(6).flex_none().flex().items_center().rounded(5).border_1().border_color(t.border).text_size(10).text_color(t.muted).child("Gitee")))
      .when((this.w ?? 999) > 340, (e) => e.child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).text_right().truncate().child(this.repo ?? "")))
      .when((this.w ?? 999) <= 340, (e) => e.child(div().flex_1()))
      .when(this.kind === "issue" && !this.composing, (e) => e.child(h_flex().id("issues-new").w(26).h(26).flex_none().items_center().justify_center().rounded(7).border_1().border_color(t.border).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.composing = true; this.postError = null; cx.notify(); })
        .child(div().size(12).when(this.icons, (e) => e.child(svg(icon("plus")).size(12))))))
      .child(h_flex().id("issues-refresh").h(26).px(8).gap(5).flex_none().items_center().rounded(7).border_1().border_color(t.border).text_size(12).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.refresh(cx); cx.notify(); })
        .child(this.syncing
          ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
          : div().size(12).when(this.icons, (e) => e.child(svg(icon("refresh")).size(12))))
        .when((this.w ?? 999) > 340, (e) => e.child(this.syncing ? "Syncing" : "Refresh"))));
    if (this.composing) return frame.child(this.form(t, cx));
    return frame
      .child(v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().id("issues-filter").flex_1().min_w(0).h(28).px(9).flex().items_center().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().id("issues-sort-button").h(28).px(9).gap(4).flex_none().items_center().rounded(7).border_1().border_color(t.border).text_size(12).text_color(t.muted)
            .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => openOverlay({ mod: "issues", kind: "popup", width: 210, height: 196, props: { sortMenu: true } }))
            .child(SORTS[sort()].label.replace(/ updated$/, "")).child(div().text_size(9).child("▼"))))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().flex_none().p(2).gap(2).rounded(8).border_1().border_color(t.border)
            .child(this.segment("kind-issue", KIND.issue, this.kind === "issue", t, (_e, cx) => this.setKind("issue", cx)))
            .child(this.segment("kind-pull", KIND.pull, this.kind === "pull", t, (_e, cx) => this.setKind("pull", cx))))
          .child(div().flex_1())
          .child(h_flex().flex_none().p(2).gap(2).rounded(8).border_1().border_color(t.border)
            .child(this.segment("filter-all", "All", !this.mine, t, (_e, cx) => { this.mine = false; cx.notify(); }))
            .child(this.segment("filter-mine", "Mine", this.mine, t, (_e, cx) => { this.mine = true; cx.notify(); }))))
        .child(h_flex().flex_none().p(2).gap(2).rounded(8).border_1().border_color(t.border)
          .child(this.segment("state-open", cached ? `Open ${open >= FULL ? `${FULL}+` : open}` : "Open", this.state === "OPEN", t, (_e, cx) => { this.state = "OPEN"; cx.notify(); }))
          .child(this.segment("state-closed", cached ? `Closed ${closed}` : "Closed", this.state === "CLOSED", t, (_e, cx) => { this.state = "CLOSED"; cx.notify(); }))))
      .child(v_flex().id("issues-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(Boolean(this.error) && list.length > 0, (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.ansi1).child(this.error)))
        .when(this.mentioned.length > 0 && this.kind === "issue", (e) => e.child(this.heading("In this terminal", t))
          .children(this.mentioned.map((i) => this.row(i, t, "mentioned")))
          .child(this.heading(`${this.state === "OPEN" ? "Open" : "Closed"} ${noun}${this.mine ? " assigned to you" : ""}`, t)))
        .children(list.map((i) => this.row(i, t)))
        .when(!list.length, (e) => e.child(div().px(16).py(28).text_size(12).text_center().text_color(this.error ? t.ansi1 : t.dim).child(empty))));
  }
}
