import { github } from "./github.js";
import { gitee } from "./gitee.js";

// The platform behind an issue: the folder's remotes decide. A folder with both
// shows GitHub's, as it did before Gitee existed.
const PROVIDERS = { github, gitee };
const HOSTS = { "github.com": "github", "gitee.com": "gitee" };
export const ORDER = ["github", "gitee"];

export const providerOf = (name) => PROVIDERS[name] ?? github;

// The host and owner/name a remote's URL names, whoever that host is:
// https://gitee.com/o/r.git, git@github.com:o/r.git, git@github-work:o/r.git,
// ssh://git@host/o/r. Which platform the host is, `providerAt` says.
const REMOTE = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([\w.-]+)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
export function remoteNamed(url) {
  const m = REMOTE.exec(url.trim());
  return m ? { host: m[1].toLowerCase(), repo: `${m[2]}/${m[3]}` } : null;
}

// { provider, repo } from a remote's URL, or null for another host (an ssh
// alias in a name of its own is nobody's until `ssh -G` resolves it).
export function remoteRepo(url) {
  const named = remoteNamed(url);
  const provider = named && HOSTS[named.host];
  return provider ? { provider, repo: named.repo } : null;
}

// The platform a link points at: a link may leave this dialog's own provider.
export const providerAt = (host) => HOSTS[String(host).toLowerCase()] ?? null;
