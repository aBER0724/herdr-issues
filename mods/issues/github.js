import { exec } from "herdr";

// What the panel and the dialog need of an issue, in gh's own JSON naming.
export const FIELDS = "number,title,body,author,state,stateReason,labels,assignees,createdAt,updatedAt,comments,url";
export const DETAIL = `${FIELDS},milestone,closedByPullRequestsReferences,reactionGroups`;

async function gh(args, on) {
  const r = await exec("gh", args, { on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

const json = async (args, on) => JSON.parse(await gh(args, on));

// "Newest" sorts on this, as it does on Gitee.
const issue = (i) => ({ ...i, order: i.number, commentCount: i.comments.length });

export const github = {
  name: "github",
  label: "GitHub",
  web: "https://github.com",

  // `since` asks for what changed after it, in either state.
  async issues({ repo, on, state, limit, since }) {
    const args = ["issue", "list", "-R", repo, "--state", state, "--limit", String(limit), "--json", FIELDS];
    if (since) args.push("--search", `updated:>=${new Date(since).toISOString().slice(0, 19)}Z`);
    return (await json(args, on)).map(issue);
  },

  async view({ repo, number, on }) {
    return issue(await json(["issue", "view", String(number), "-R", repo, "--json", DETAIL], on));
  },

  // GitHub's REST timeline, as its own event objects.
  async timeline({ repo, number, on }) {
    const pages = await json(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/timeline?per_page=100`], on).catch(() => null);
    return pages ? pages.flat() : null;
  },

  async me({ on }) {
    return gh(["api", "user", "-q", ".login"], on).catch(() => null);
  },

  async comment({ repo, number, body, on }) {
    await gh(["issue", "comment", String(number), "-R", repo, "--body", body], on);
  },

  // Closing or reopening takes the comment box along, as gh does with --comment.
  async setState({ repo, number, close, reason, body, on }) {
    const args = close ? ["close", String(number), "-R", repo, "--reason", reason === "not planned" ? "not planned" : "completed"] : ["reopen", String(number), "-R", repo];
    if (body) args.push("--comment", body);
    await gh(["issue", ...args], on);
  },

  async assign({ repo, number, assign, on }) {
    await gh(["issue", "edit", String(number), "-R", repo, assign ? "--add-assignee" : "--remove-assignee", "@me"], on);
  },

  async labels({ repo, on }) {
    const rows = await json(["label", "list", "-R", repo, "--limit", "200", "--json", "name,color,description"], on).catch(() => []);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },

  async toggleLabel({ repo, number, name, add, on }) {
    await gh(["issue", "edit", String(number), "-R", repo, add ? "--add-label" : "--remove-label", name], on);
  },
};
