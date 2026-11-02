import { github } from "./github.js";
import { gitee } from "./gitee.js";

// The platform behind an issue: the folder's remotes decide. A folder with both
// shows GitHub's, as it did before Gitee existed.
const PROVIDERS = { github, gitee };
const HOSTS = { "github.com": "github", "gitee.com": "gitee" };
export const ORDER = ["github", "gitee"];

export const providerOf = (name) => PROVIDERS[name] ?? github;

// { provider, repo } from a remote's URL, or null for another host:
// https://gitee.com/o/r.git, git@github.com:o/r.git, ssh://git@host/o/r.
export function remoteRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([\w.-]+)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  const provider = HOSTS[m[1].toLowerCase()];
  return provider ? { provider, repo: `${m[2]}/${m[3]}` } : null;
}

// The platform a link points at: a link may leave this dialog's own provider.
export const providerAt = (host) => HOSTS[String(host).toLowerCase()] ?? null;
