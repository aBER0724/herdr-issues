import * as fs from "fs/promises";
import { appHome } from "herdr";

// Gitee's API v5. Reads work without a token at 60 requests an hour; writing
// needs a personal access token (issues and notes), read here from the file
// below so it never lands in a program's arguments or on screen.
const API = "https://gitee.com/api/v5";
const PAGE = 100;                  // Gitee's largest page, and 300 is refused
const tokenPath = () => `${appHome()}/data/issues/gitee-token`;

const token = async () => (await fs.readFile(tokenPath(), "utf8").catch(() => "")).trim();

const form = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

// A token goes in the query for reads and in the body for writes, as Gitee asks.
async function request(path, { method = "GET", params = {}, body = null } = {}) {
  const t = await token(), auth = t ? { access_token: t } : {}, query = form({ ...params, ...auth });
  const write = Boolean(body);
  const r = await fetch(`${API}${path}${write || !query ? "" : `?${query}`}`, write ? {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ ...body, ...auth }),
  } : { method });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) throw new Error(data?.message ?? data?.messages?.join("; ") ?? `Gitee answered ${r.status}`);
  return data;
}

// Gitee pages with `page` and `per_page` and says nothing else: read until a
// short page or the cap.
async function pages(path, params, cap = 5) {
  const out = [];
  for (let page = 1; page <= cap; page++) {
    const rows = await request(path, { params: { ...params, per_page: PAGE, page } });
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Gitee has four states; the panel's two are open (open, progressing) and
// closed (closed, rejected), the way GitHub reads.
const FETCH = { open: ["open", "progressing"], closed: ["closed", "rejected"], all: ["all"] };
const STATE = {
  open: { state: "OPEN", stateReason: null },
  progressing: { state: "OPEN", stateReason: null },
  closed: { state: "CLOSED", stateReason: "COMPLETED" },
  rejected: { state: "CLOSED", stateReason: "NOT_PLANNED" },
};

const person = (u) => (u ? { login: u.login, avatarUrl: u.avatar_url, url: u.html_url } : null);

// Gitee updates an issue through its owner, not the repo: the path carries the
// owner and the body names the repo. `state` takes open, progressing or closed;
// rejected exists on issues but the API refuses to set it.
const update = (repo, number, fields) => request(`/repos/${repo.split("/")[0]}/issues/${number}`, {
  method: "PATCH",
  body: { repo: repo.split("/")[1], ...fields },
});

// Gitee writes the state's color with a # and a label's without; both go out as
// the #rrggbb the dialog draws with.
const hex = (color, lead = true) => (color ? `${lead ? "#" : ""}${String(color).replace(/^#/, "")}` : null);

// As gh would hand it over, so the panel and the dialog read both the same.
function issue(i, repo) {
  const { state, stateReason } = STATE[i.state] ?? STATE.open;
  return {
    number: i.number, order: i.id,
    title: i.title, body: i.body ?? "",
    author: person(i.user),
    state, stateReason,
    stateText: i.issue_state_detail?.title ?? null,
    stateColor: hex(i.issue_state_detail?.color),
    labels: (i.labels ?? []).map((l) => ({ name: l.name, color: hex(l.color, false), description: l.description ?? "" })),
    assignees: i.assignee ? [person(i.assignee)] : [],
    createdAt: i.created_at, updatedAt: i.updated_at,
    comments: [], commentCount: i.comments ?? 0,
    milestone: i.milestone ? { title: i.milestone.title } : null,
    closedByPullRequestsReferences: [],
    url: i.html_url ?? `https://gitee.com/${repo}/issues/${i.number}`,
  };
}

export const gitee = {
  name: "gitee",
  label: "Gitee",
  web: "https://gitee.com",
  tokenPath,

  // Everything open (resp. closed) the first time; after that, what Gitee says
  // changed since the last sync, in either state.
  async issues({ repo, state, limit, since }) {
    const path = `/repos/${repo}/issues`;
    const rows = [];
    if (since) {
      rows.push(...await pages(path, { state: "all", sort: "updated", direction: "desc", since: new Date(since - 120000).toISOString().slice(0, 19) + "Z" }, Math.ceil(limit / PAGE)));
    } else {
      for (const s of FETCH[state] ?? FETCH.all)
        rows.push(...await pages(path, { state: s, sort: "created", direction: "desc" }, Math.ceil(limit / PAGE)));
      rows.sort((a, b) => b.id - a.id);
    }
    return rows.slice(0, limit).map((i) => issue(i, repo));
  },

  async view({ repo, number }) {
    return issue(await request(`/repos/${repo}/issues/${number}`), repo);
  },

  // Gitee has no timeline endpoint: its comments, in the shape the dialog reads.
  async timeline({ repo, number }) {
    const rows = await pages(`/repos/${repo}/issues/${number}/comments`, {}, 5);
    return rows.map((c) => ({ event: "commented", user: c.user, created_at: c.created_at, body: c.body }));
  },

  async me() {
    if (!await token()) return null;
    const user = await request("/user").catch(() => null);
    return user?.login ?? null;
  },

  async comment({ repo, number, body }) {
    await request(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } });
  },

  async setState({ repo, number, close, body }) {
    if (body) await gitee.comment({ repo, number, body });
    await update(repo, number, { state: close ? "closed" : "open" });
  },

  // Gitee has one assignee, and "" clears it.
  async assign({ repo, number, assign }) {
    const login = await gitee.me();
    if (!login) throw new Error(`Assigning needs a Gitee token in ${tokenPath()}`);
    await update(repo, number, { assignee: assign ? login : "" });
  },

  async labels({ repo }) {
    const rows = await pages(`/repos/${repo}/labels`, {}, 3);
    const seen = new Set();
    return rows.filter((l) => !seen.has(l.name) && seen.add(l.name))
      .map((l) => ({ name: l.name, color: hex(l.color, false), description: l.description ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
  },

  // The whole list, as Gitee takes labels as one comma-separated field.
  async toggleLabel({ repo, number, labels }) {
    await update(repo, number, { labels: labels.join(",") });
  },
};
