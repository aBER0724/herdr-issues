import { exec } from "herdr";

// What the panel and the dialog need of an issue, in gh's own JSON naming.
export const FIELDS = "number,title,body,author,state,stateReason,labels,assignees,createdAt,updatedAt,comments,url";
export const DETAIL = `${FIELDS},milestone,closedByPullRequestsReferences,reactionGroups`;
// A pull request has no stateReason, and has a merged state of its own, a draft
// flag and the issues it closes.
const PULL = "number,title,body,author,state,labels,assignees,createdAt,updatedAt,comments,url,milestone,reactionGroups,isDraft,mergedAt,headRefName,baseRefName";
const PULL_DETAIL = `${PULL},closingIssuesReferences`;

async function gh(args, on) {
  const r = await exec("gh", args, { on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

const json = async (args, on) => JSON.parse(await gh(args, on));

// "Newest" sorts on `order`, as it does on Gitee; `ref` is what a row shows.
const issue = (i) => ({ ...i, order: i.number, ref: `#${i.number}`, commentCount: i.comments.length });
const pull = (i) => ({
  ...i, order: i.number, ref: `#${i.number}`, commentCount: i.comments.length,
  stateText: i.isDraft && i.state === "OPEN" ? "Draft" : null,
  // The branches Start work's brief sends the agent to.
  head: i.headRefName ?? null, base: i.baseRefName ?? null,
});

export const github = {
  name: "github",
  label: "GitHub",
  web: "https://github.com",

  // Gitee hands a pull request's people to reviewers; GitHub has a real assignee.
  assignable: () => true,

  // `since` asks for what changed after it, in either state.
  async items({ kind, repo, on, state, limit, since }) {
    const pulling = kind === "pull";
    const args = pulling
      ? ["pr", "list", "-R", repo, "--state", state, "--limit", String(limit), "--json", PULL]
      : ["issue", "list", "-R", repo, "--state", state, "--limit", String(limit), "--json", FIELDS];
    if (since) args.push("--search", `updated:>=${new Date(since).toISOString().slice(0, 19)}Z`);
    return (await json(args, on)).map(pulling ? pull : issue);
  },

  async view({ kind, repo, number, on }) {
    return kind === "pull"
      ? pull(await json(["pr", "view", String(number), "-R", repo, "--json", PULL_DETAIL], on))
      : issue(await json(["issue", "view", String(number), "-R", repo, "--json", DETAIL], on));
  },

  // A new issue: gh prints its URL, so the number is the last thing on it.
  async create({ repo, title, body, on }) {
    const url = await gh(["issue", "create", "-R", repo, "--title", title, "--body", body], on);
    const number = /\/issues\/(\d+)\s*$/.exec(url.trim())?.[1];
    if (!number) return null;
    return issue(await json(["issue", "view", number, "-R", repo, "--json", DETAIL], on));
  },

  // GitHub's REST timeline, as its own event objects. A pull request has one too.
  async timeline({ repo, number, on }) {
    const pages = await json(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/timeline?per_page=100`], on).catch(() => null);
    return pages ? pages.flat() : null;
  },

  async me({ on }) {
    return gh(["api", "user", "-q", ".login"], on).catch(() => null);
  },

  async comment({ kind, repo, number, body, on }) {
    await gh([kind === "pull" ? "pr" : "issue", "comment", String(number), "-R", repo, "--body", body], on);
  },

  // Closing or reopening takes the comment box along, as gh does with --comment.
  async setState({ kind, repo, number, close, reason, body, on }) {
    const what = kind === "pull" ? "pr" : "issue";
    const args = close ? ["close", String(number), "-R", repo] : ["reopen", String(number), "-R", repo];
    if (close && what === "issue") args.push("--reason", reason === "not planned" ? "not planned" : "completed");
    if (body) args.push("--comment", body);
    await gh([what, ...args], on);
  },

  async assign({ kind, repo, number, assign, on }) {
    await gh([kind === "pull" ? "pr" : "issue", "edit", String(number), "-R", repo, assign ? "--add-assignee" : "--remove-assignee", "@me"], on);
  },

  // Labels are the repository's, for a pull request as for an issue.
  async labels({ repo, on }) {
    const rows = await json(["label", "list", "-R", repo, "--limit", "200", "--json", "name,color,description"], on).catch(() => []);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },

  async toggleLabel({ kind, repo, number, name, add, on }) {
    await gh([kind === "pull" ? "pr" : "issue", "edit", String(number), "-R", repo, add ? "--add-label" : "--remove-label", name], on);
  },
};
