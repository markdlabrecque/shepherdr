import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as S from "./settings.js";
import { menuFor, modelSections } from "./agents.js";

const ROOT = join(import.meta.dir, "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
// Every file that shows Settings: the window's mod, the service that builds the web's rows, and the web's pages
// (Autopilot's page has its own words, core/autopilot.js).
const MOD = readdirSync(join(ROOT, "mods/shepherdr-settings")).filter((f) => f.endsWith(".js") && f !== "autopilot-section.js").map((f) => `mods/shepherdr-settings/${f}`);
const SHOWN = [...MOD, "service/settings.ts", "service/window.ts", "service/compat.ts", "web/src/Settings.tsx", "web/src/screens/Role.tsx"];

// The words each side used to write out for itself: now only core/settings.js has them.
const WORDS = [
  ...Object.values(S.ABOUT), S.BACKUP.about, S.NOTIFY_ABOUT, S.BASE.about, S.SECRETS.about, S.SECRETS.hint, S.SECRETS.none,
  S.SECRETS.badName, S.MACHINES.heading, S.MACHINES.low.about, S.MACHINES.cap.about, ...S.MACHINES.limits.map((l) => l.about),
  ...S.SWITCHES.map((s) => s.about), ...S.ROLES.map((r) => r.about), ...S.ROLES.map((r) => r.told), ...S.NOTES.map((n) => n.example),
  ...Object.values(S.INSTRUCTIONS.notes), "Only for ", "use their own", "On, private to your tailnet.", "Its home space's Assistant watches",
];

test("the window's mod, the service and the web read Settings' words from core/settings.js, never their own copy", () => {
  for (const f of SHOWN) {
    // the code, not what its comments say
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const w of WORDS) expect({ file: f, has: src.includes(w) ? w : null }).toEqual({ file: f, has: null });
  }
  // and each of them reads core/settings.js
  for (const f of ["mods/shepherdr-settings/main.js", "mods/shepherdr-settings/layout.js", "mods/shepherdr-settings/machines-section.js",
    "mods/shepherdr-settings/secrets-section.js", "mods/shepherdr-settings/web-section.js", "mods/shepherdr-settings/base-branch.js", "lib/settings.js"])
    expect(read(f)).toContain('from "./core/settings.js"');
  for (const f of ["service/settings.ts", "service/window.ts", "service/compat.ts"]) expect(read(f)).toContain('from "../core/settings.js"');
  for (const f of ["web/src/Settings.tsx", "web/src/screens/Role.tsx"]) expect(read(f)).toContain("from '@core/settings.js'");
});

test("the model menu's headings are the window's (mods/chat-models)", () => {
  const src = read("mods/chat-models/main.js");
  for (const w of Object.values(S.MODEL_MENU)) expect(src).toContain(`"${w}"`);
});

test("the model button says what the window's does", () => {
  const choices = S.choicesFrom({ pi: { model: "openai/gpt-6.2-sol", effort: "high", models: [{ id: "openai/gpt-6.2-sol", efforts: ["low", "high"] }] } });
  expect(Object.keys(choices.menus)).toEqual(["pi"]);
  expect(choices.menus.pi.perms).toEqual([]);
  expect(S.modelLabel(choices.menus, choices.defaults)).toBe("Sol 6.2 · High");
  for (const role of ["coordinator", "worker", "reviewer"]) {
    expect(S.roleSel(role, null, choices, "pi")).toEqual({ unset: true, sel: choices.defaults });
    expect(S.roleSel(role, { agent: "pi", model: "openai/gpt-6.2-sol", effort: "high" }, choices, "pi").sel.effort).toBe("high");
  }
});

test("role menus offer only the eight supported versions, with catalog providers and thinking levels", () => {
  const supported = [
    ["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"],
    ["gpt-6.2-sol", "Sol 6.2"], ["gpt-6.2-astra", "Astra 6.2"],
    ["gpt-6.1-terra", "Terra 6.1"], ["gpt-6-luna", "Luna 6"],
  ].map(([id, name]) => ({ id: `${id.startsWith("claude") ? "pi-claude-subscription" : "openai"}/${id}`, name }));
  const older = ["openai/gpt-6-sol", "openai/gpt-6.1-sol", "openai/gpt-6-astra", "openai/gpt-5.6-luna", "other/claude-opus-4-6"];
  const models = [...supported, ...older.map((id) => ({ id })), { id: "bedrock/claude-opus-5-5" }]
    .map((m) => ({ ...m, efforts: ["low", "high"] }));
  const { menus, defaults } = S.choicesFrom({ pi: { model: "openai/gpt-6.2-sol", effort: "high", models } });
  expect(menus.pi.models.map(({ id, name }) => ({ id, name }))).toEqual([...supported, { id: "bedrock/claude-opus-5-5", name: "Opus 5.5" }]);
  expect(menus.pi.models.every((m) => m.efforts.join() === "low,high" && !m.fast)).toBe(true);
  expect(defaults.model).toBe("openai/gpt-6.2-sol");
  const picks = { pinned: [`pi:${older[0]}`, `pi:${supported[0].id}`], recent: [`pi:${older[1]}`] };
  const rows = modelSections(menus, "pi", picks, "").flatMap((s) => s.rows);
  expect(rows).toHaveLength(9);
  expect(rows[0]).toMatchObject({ id: supported[0].id, pinned: true });
  for (const query of older) {
    const matches = modelSections(menus, "pi", picks, query).flatMap((s) => s.rows);
    expect(matches.every((r) => !r.typed && !older.includes(r.id))).toBe(true);
  }
  expect(modelSections(menus, "pi", picks, "provider/arbitrary-model")).toEqual([]);
  expect(modelSections(menus, "pi", picks, "sol")[0].rows.map((r) => r.id)).toEqual(["openai/gpt-6.2-sol"]);
});

test("unsupported defaults and missing catalogs cannot insert extra role models", () => {
  const pi = { model: "openai/gpt-6-sol", models: [{ id: "openai/gpt-6.2-sol" }] };
  expect(S.choicesFrom({ pi }).defaults.model).toBe("openai/gpt-6.2-sol");
  const missing = S.choicesFrom({ pi: { model: "openai/gpt-6.2-sol" } });
  expect(missing.menus.pi.models).toEqual([]);
  expect(missing.defaults.model).toBeNull();
  expect(S.choicesFrom({}).menus.pi.models).toEqual([]);
});

test("switching the worker's agent there and back keeps auto (#758)", () => {
  const menus = { claude: menuFor("claude", { model: "opus", per: {} }), codex: menuFor("codex", { models: [{ id: "gpt-5", label: "GPT-5", efforts: ["low", "high"] }] }) };
  const permDefault = { claude: "manual", codex: "auto" };
  expect(permDefault.claude).toBe("manual");
  const toCodex = S.chooseModel(menus, permDefault, { agent: "claude", model: "opus", perm: "auto" }, "codex", "gpt-5");
  expect(toCodex.perm).toBe("auto");
  expect(S.chooseModel(menus, permDefault, toCodex, "claude", "opus").perm).toBe("auto");
  // nearest mode: plan and read only swap, accept edits is Codex's auto, ask (no match) takes the default
  expect(S.chooseModel(menus, permDefault, { agent: "claude", model: "opus", perm: "plan" }, "codex", "gpt-5").perm).toBe("read-only");
  expect(S.chooseModel(menus, permDefault, { agent: "codex", model: "gpt-5", perm: "read-only" }, "claude", "opus").perm).toBe("plan");
  expect(S.chooseModel(menus, permDefault, { agent: "claude", model: "opus", perm: "acceptEdits" }, "codex", "gpt-5").perm).toBe("auto");
  expect(S.chooseModel(menus, permDefault, { agent: "claude", model: "opus", perm: "manual" }, "codex", "gpt-5").perm).toBe("auto");
  expect(S.chooseModel(menus, permDefault, { agent: "codex", model: "gpt-5", perm: "full" }, "claude", "opus").perm).toBe("bypassPermissions");
});

test("Backup's warning, an add-on's line and Web's state, in the window's words", () => {
  const checks = { "": { codex: "ok" }, "vm-ssa": { codex: "signed-out" }, box: { codex: "missing" } };
  expect(S.backupProblem(checks, null, "codex")).toBe("Can't on vm-ssa: Codex is signed out. Can't on box: Codex is not installed.");
  expect(S.backupProblem(checks, "local", "codex")).toBe("");
  expect(S.backupProblem(checks, "vm-ssa", "codex")).toBe("Can't on vm-ssa: Codex is signed out.");
  expect(S.addonAbout("Calls.", true, ["Voice"])).toBe("Calls. Voice needs it: turn that off first.");
  expect(S.addonAbout("Calls.", false, ["Voice", "Chat"])).toBe("Calls. Needs Voice, Chat: turn them on first.");
  expect(S.webState(true, true, null)).toBe("Off. Turn it on under Window › Add-ons.");
  expect(S.onlyFor("web", "This computer")).toBe("Only for web on This computer");
  expect(S.spacesOwn(1)).toBe("1 space sets its own");
  expect(S.sameAs("everywhere", null)).toBe("Inherited from Everywhere");
  expect(S.sameAs("machine", "vm")).toBe("Inherited from vm");
});

// SHEP-48: Reactions, for every agent: on unless a level turns it off, the same default everywhere it's read.
test("Reactions are on by default, in the core, the window's chain and herdr-task", () => {
  expect(S.DEFAULTS.agents.reactions).toBe(true);
  expect(S.DEFAULTS.assistant).toBeUndefined();
  // lib/coordinator.js needs the window's runtime: its defaults and its chain, as written
  const lib = read("lib/coordinator.js");
  expect(lib).toMatch(/SHEPHERDR_DEFAULTS = \{[^;]*agents: \{ reactions: true, suggestions: true, feedback: true, feedback_repo: "" \}/);
  expect(lib).toContain('for (const k of ["tasks", "automations", "agents"])');
  // SHEP-42's key still counts in the window's chain where a layer has no agents'
  expect(lib).toContain('typeof l.obj.assistant?.reactions === "boolean" ? { reactions: l.obj.assistant.reactions, ...l.obj.agents }');
  expect(read("mods/tasks/bin/herdr_task/settings.py")).toContain('"agents": {"reactions": True, "suggestions": True, "feedback": True, "feedback_repo": "eliasstravik/shepherdr"}');
  expect(S.REACTIONS.title).toBe("Reactions");
});

// SHEP-48: SHEP-42's assistant.reactions moves to agents.reactions in every layer; agents' own wins; the rest stays.
test("upgradeReactions moves the Assistant's Reactions to every agent's", () => {
  const cfg = { version: 1, everywhere: { assistant: { reactions: false }, tasks: { merge: "auto" } },
    machines: { vm: { assistant: { reactions: true, other: 1 } } },
    spaces: { sp1: { folder: "/a", assistant: { reactions: true }, agents: { reactions: false } }, sp2: { folder: "/b" } } };
  expect(S.upgradeReactions(cfg)).toBe(cfg);
  expect(cfg).toEqual({ version: 1, everywhere: { tasks: { merge: "auto" }, agents: { reactions: false } },
    machines: { vm: { assistant: { other: 1 }, agents: { reactions: true } } },
    spaces: { sp1: { folder: "/a", agents: { reactions: false } }, sp2: { folder: "/b" } } });
  expect(S.upgradeReactions({})).toEqual({});
});

// SHEP-225 (#981): the GitHub star card is gone; an old file's star_prompt is dropped, the rest kept
test("an old star_prompt is dropped and the file still loads", () => {
  const cfg = { version: 1, everywhere: { star_prompt: { asked: 1, answer: "no" }, tasks: { merge: "checks" } } };
  expect(S.upgradeReactions(cfg)).toEqual({ version: 1, everywhere: { tasks: { merge: "checks" } } });
  expect(S.STAR).toBeUndefined();
  expect(S.starState).toBeUndefined();
});

// SHEP-78: Feedback offers on by default; the repo as owner/name, a github.com link made one, anything else refused.
test("Feedback offers and the repo they file to", () => {
  expect(S.DEFAULTS.agents.feedback).toBe(true);
  expect(S.FEEDBACK.repo).toBe("eliasstravik/shepherdr");
  expect(S.feedbackRepo(" acme/shep ")).toBe("acme/shep");
  expect(S.feedbackRepo("https://github.com/acme/shep.git")).toBe("acme/shep");
  expect(S.feedbackRepo("")).toBe("");
  expect(S.feedbackRepo("not a repo")).toBeNull();
  expect(read("mods/shepherdr-settings/main.js")).toContain("feedbackRow(this, t)");
});
