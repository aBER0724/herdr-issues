import { exec } from "herdr";

// How each agent CLI lists its models and takes a model and a reasoning level, for the
// Start work dialog. A model is { id, label?, efforts: string[], effort? } (effort: its
// default). `efforts` is what the CLI takes when a model names no levels of its own.
// A harness with no entry here takes its model from its own settings: the dialog says so.

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// A model reaches the CLI as an argument: letters, digits and . _ : / @ + - only.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$/;

// A CLI that won't start, or exits nonzero, has no models to name: the caller shows the
// error and takes a typed model instead.
async function output(command, args, on) {
  const once = async (cmd, argv) => { try { return await exec(cmd, argv, { on }); } catch { return null; } };
  let r = await once(command, args);
  // Shell functions (pi often is one) exist only inside an interactive shell.
  if (!r || r.code !== 0) r = await once("sh", ["-c", `"\${SHELL:-sh}" -ic '${[command, ...args].join(" ")}'`]);
  if (!r || r.code !== 0) {
    const said = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean)[0];
    throw new Error(said || `${command} did not answer`);
  }
  return r.stdout;
}

// codex debug models: only the ones it means to offer, with their reasoning levels.
function codex(out) {
  return JSON.parse(out).models.filter((m) => m.visibility === "list").map((m) => ({
    id: m.slug, label: m.display_name,
    efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort), effort: m.default_reasoning_level,
  }));
}

// cursor-agent --list-models writes "id - label" a line.
function cursor(out) {
  return out.split("\n").map((l) => /^(\S+) - (.+)$/.exec(l.trim())).filter(Boolean)
    .map(([, id, label]) => ({ id, label, efforts: [] }));
}

// pi --list-models is a table: provider, model, context, max-out, thinking yes/no.
function pi(out) {
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 5)
    .map(([provider, model, , , thinking]) => ({ id: `${provider}/${model}`, efforts: thinking === "yes" ? PI_THINKING : [] }));
}

// opencode models (and others): one provider/model per line.
function plain(out) {
  return out.split("\n").map((l) => l.trim()).filter((l) => /^\S+\/\S+$/.test(l)).map((id) => ({ id, efforts: [] }));
}

const ADAPTERS = {
  claude: {
    models: async () => ["fable", "opus", "sonnet", "haiku"].map((id) => ({ id, efforts: CLAUDE_EFFORTS, effort: "high" })),
    efforts: CLAUDE_EFFORTS,
    flags: (model, effort) => [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])],
  },
  codex: {
    models: async (on) => codex(await output("codex", ["debug", "models"], on)),
    flags: (model, effort) => [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : [])],
  },
  gemini: {
    models: async () => [],
    flags: (model) => (model ? ["--model", model] : []),
  },
  opencode: {
    models: async (on) => plain(await output("opencode", ["models"], on)),
    flags: (model) => (model ? ["--model", model] : []),
  },
  cursor: {
    models: async (on) => cursor(await output("cursor-agent", ["--list-models"], on)),
    flags: (model) => (model ? ["--model", model] : []),
  },
  pi: {
    models: async (on) => pi(await output("pi", ["--list-models"], on)),
    efforts: PI_THINKING,
    flags: (model, effort) => [...(model ? ["--model", model] : []), ...(effort && effort !== "off" ? ["--thinking", effort] : [])],
  },
};

const ALIASES = { "cursor-agent": "cursor", agent: "cursor" };

// The adapter for a knownAgents() entry, by its key or the program it runs; null: the
// harness takes its model from its own settings.
export function adapterFor(agent) {
  const name = ALIASES[agent?.key] ?? agent?.key;
  const program = agent?.run?.[0]?.split("/").pop();
  return ADAPTERS[name] ?? ADAPTERS[ALIASES[program] ?? program] ?? null;
}

// The model and effort as this CLI's flags. A name that isn't shaped like one is refused
// here, not passed on to the terminal.
export function flagsFor(agent, model, effort) {
  const adapter = adapterFor(agent);
  if (!adapter) return [];
  if (model && !SAFE.test(model)) throw new Error("A model name has letters, digits and . _ : / @ + - only.");
  return adapter.flags(model || null, effort || null);
}
