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

// An issue has four states; the panel's two are open (open, progressing) and
// closed (closed, rejected), the way GitHub reads. A pull request has three, and
// its merged one is a state of its own.
const ISSUE_FETCH = { open: ["open", "progressing"], closed: ["closed", "rejected"], all: ["all"] };
const ISSUE_STATE = {
  open: { state: "OPEN", stateReason: null },
  progressing: { state: "OPEN", stateReason: null },
  closed: { state: "CLOSED", stateReason: "COMPLETED" },
  rejected: { state: "CLOSED", stateReason: "NOT_PLANNED" },
};
const PULL_FETCH = { open: ["open"], closed: ["closed", "merged"], all: ["all"] };
const PULL_STATE = { open: "OPEN", closed: "CLOSED", merged: "MERGED" };

const person = (u) => (u ? { login: u.login, avatarUrl: u.avatar_url, url: u.html_url } : null);
const label = (l) => ({ name: l.name, color: hex(l.color, false), description: l.description ?? "" });

// Gitee writes the state's color with a # and a label's without; both go out as
// the #rrggbb the dialog draws with.
function hex(color, lead = true) {
  return color ? `${lead ? "#" : ""}${String(color).replace(/^#/, "")}` : null;
}

// Gitee updates an issue through its owner, not the repo: the path carries the
// owner and the body names the repo. `state` takes open, progressing or closed;
// rejected exists on issues but the API refuses to set it.
const update = (repo, number, fields) => request(`/repos/${repo.split("/")[0]}/issues/${number}`, {
  method: "PATCH",
  body: { repo: repo.split("/")[1], ...fields },
});

// A pull request is updated where it is read, repo segment and all.
const updatePull = (repo, number, fields) => request(`/repos/${repo}/pulls/${number}`, { method: "PATCH", body: fields });

// As gh would hand it over, so the panel and the dialog read both the same.
function issue(i, repo) {
  const { state, stateReason } = ISSUE_STATE[i.state] ?? ISSUE_STATE.open;
  return {
    number: i.number, order: i.id, ref: `#${i.number}`,
    title: i.title, body: i.body ?? "",
    author: person(i.user),
    state, stateReason,
    stateText: i.issue_state_detail?.title ?? null,
    stateColor: hex(i.issue_state_detail?.color),
    labels: (i.labels ?? []).map(label),
    assignees: i.assignee ? [person(i.assignee)] : [],
    createdAt: i.created_at, updatedAt: i.updated_at,
    comments: [], commentCount: i.comments ?? 0,
    milestone: i.milestone ? { title: i.milestone.title } : null,
    closedByPullRequestsReferences: [],
    url: i.html_url ?? `https://gitee.com/${repo}/issues/${i.number}`,
  };
}

// A pull request is identified by a number on Gitee, not an ident: `!14`. Its
// people are reviewers, and it says nothing about how many comments it has.
function pull(p, repo) {
  return {
    number: p.number, order: p.id ?? p.number, ref: `!${p.number}`,
    title: p.title, body: p.body ?? "",
    author: person(p.user),
    state: PULL_STATE[p.state] ?? "CLOSED",
    stateReason: p.state === "closed" ? "NOT_PLANNED" : null,
    stateText: null, stateColor: null,
    labels: (p.labels ?? []).map(label),
    assignees: (p.assignees ?? []).map(person),
    createdAt: p.created_at, updatedAt: p.updated_at,
    comments: [], commentCount: null,
    milestone: p.milestone ? { title: p.milestone.title } : null,
    closedByPullRequestsReferences: [],
    // The branches Start work's brief sends the agent to.
    head: p.head?.ref ?? null, base: p.base?.ref ?? null,
    url: p.html_url ?? `https://gitee.com/${repo}/pulls/${p.number}`,
  };
}

const path = (repo, kind) => `/repos/${repo}/${kind === "pull" ? "pulls" : "issues"}`;

export const gitee = {
  name: "gitee",
  label: "Gitee",
  web: "https://gitee.com",
  tokenPath,

  // A pull request's people are its reviewers; Gitee has no assignee for one.
  assignable: (kind) => kind !== "pull",

  // Everything open (resp. closed) the first time; after that, what Gitee says
  // changed since the last sync, in either state.
  async items({ kind, repo, state, limit, since }) {
    const rows = [];
    if (since) {
      rows.push(...await pages(path(repo, kind), { state: "all", sort: "updated", direction: "desc", since: new Date(since - 120000).toISOString().slice(0, 19) + "Z" }, Math.ceil(limit / PAGE)));
    } else {
      for (const s of (kind === "pull" ? PULL_FETCH : ISSUE_FETCH)[state] ?? ["all"])
        rows.push(...await pages(path(repo, kind), { state: s, sort: "created", direction: "desc" }, Math.ceil(limit / PAGE)));
      rows.sort((a, b) => (b.id ?? b.number) - (a.id ?? a.number));
    }
    const map = kind === "pull" ? pull : issue;
    return rows.slice(0, limit).map((i) => map(i, repo));
  },

  async view({ kind, repo, number }) {
    const row = await request(`${path(repo, kind)}/${number}`);
    return kind === "pull" ? pull(row, repo) : issue(row, repo);
  },

  // A new issue: Gitee wants the repository's name in the body as well as in the
  // path, and answers with the row itself.
  async create({ repo, title, body }) {
    const [owner, name] = repo.split("/");
    return issue(await request(`/repos/${owner}/issues`, { method: "POST", body: { repo: name, title, body } }), repo);
  },

  // Gitee has no timeline endpoint: its comments are it. A pull request's list
  // also holds the code review comments, which have a file path and no place
  // in a conversation.
  async timeline({ kind, repo, number }) {
    const rows = await pages(`${path(repo, kind)}/${number}/comments`, {}, 5);
    return rows.filter((c) => kind !== "pull" || !c.path)
      .map((c) => ({ event: "commented", user: c.user, created_at: c.created_at, body: c.body }));
  },

  async me() {
    if (!await token()) return null;
    const user = await request("/user").catch(() => null);
    return user?.login ?? null;
  },

  async comment({ kind, repo, number, body }) {
    await request(`${path(repo, kind)}/${number}/comments`, { method: "POST", body: { body } });
  },

  async setState({ kind, repo, number, close, body }) {
    if (body) await gitee.comment({ kind, repo, number, body });
    if (kind === "pull") await updatePull(repo, number, { state: close ? "closed" : "open" });
    else await update(repo, number, { state: close ? "closed" : "open" });
  },

  // Gitee has one assignee, and "" clears it.
  async assign({ kind, repo, number, assign }) {
    if (!gitee.assignable(kind)) throw new Error("Gitee gives a pull request reviewers, not an assignee");
    const login = await gitee.me();
    if (!login) throw new Error(`Assigning needs a Gitee token in ${tokenPath()}`);
    await update(repo, number, { assignee: assign ? login : "" });
  },

  // Labels are the repository's, for a pull request as for an issue.
  async labels({ repo }) {
    const rows = await pages(`/repos/${repo}/labels`, {}, 3), seen = new Set();
    return rows.filter((l) => !seen.has(l.name) && seen.add(l.name)).map(label).sort((a, b) => a.name.localeCompare(b.name));
  },

  // The whole list, as Gitee takes labels as one comma-separated field.
  async toggleLabel({ kind, repo, number, labels }) {
    const fields = { labels: labels.join(",") };
    if (kind === "pull") await updatePull(repo, number, fields);
    else await update(repo, number, fields);
  },
};
