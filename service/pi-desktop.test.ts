import { expect, test } from "bun:test";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { ChatReader, kindOf } from "../core/chat-reader.js";
import { excerpt } from "../core/chat-log.js";
import { ownWords } from "../core/chat-view.js";
import { piSend, piTarget, piHistoryOf, piQuoteFor, piVisibleBody, samePiHistory, PI_BLOCKED, PI_UNCONFIRMED, PI_UNAVAILABLE } from "../core/pi-chat.js";
import { messageBody, refusal, sendTyped } from "../core/send.js";

// Run the actual window methods without starting herdr-app or loading its settings.
const source = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8");
function method(name: string, deps: Record<string, unknown> = {}) {
  const body = source.match(new RegExp(`^  (?:async )?${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^  \\}`, "m"))?.[0];
  if (!body) throw new Error(`Missing window method ${name}`);
  return new Function(...Object.keys(deps), `return ({${body}}).${name}`)(...Object.values(deps));
}
const addr = "desktop-remote/t9";
const snapshot = { ok: true, instance: "pi-instance", session: "pi-session", leaf: "old-leaf", state: "idle", items: [] };
const json = (r: any, code = 0) => ({ stdout: JSON.stringify(r), code });

test("the window pulls a qualified Pi snapshot and uses its status, not the terminal's Claude status", async () => {
  let answer = json({ ...snapshot, state: "blocked", items: [{ id: "msg", role: "assistant", text: "Hello", at: 1234 }] });
  const calls: unknown[][] = [];
  const reader = new ChatReader({ sh: async (...args: unknown[]) => { calls.push(args); return answer; } }, addr);
  await reader.locate({ state: "live", foreground: { name: "pi", pid: 77 } });
  const changed: number[] = [];
  const self = { addr, kind: "pi", piReader: reader, conv: null as any, phase: "finding", results: new Map(), opened: new Set(), settlePending() {}, recoverPiOutgoing() {} };
  const pull = method("pull", { PI_UNAVAILABLE });
  await pull.call(self, { notify: () => changed.push(1) });
  expect(calls[0].slice(1)).toEqual([["pi-chat", "snapshot", "77"], "desktop-remote"]);
  expect(self.phase).toBe("ready");
  expect(self.conv.items[0]).toMatchObject({ id: "msg", text: "Hello", at: 1234 });
  expect(method("status").call(self)).toBe("blocked");
  expect(method("asking", { PI_BLOCKED }).call(self)).toBe(PI_BLOCKED);
  answer = json({ ok: false, error: "unsafe_registry" }, 1);
  await pull.call(self, { notify: () => changed.push(1) });
  expect(self.phase).toBe("pi-unavailable");
  expect(changed).toHaveLength(2);
});

test("desktop Pi steering receipts stay pending until a new user record consumes each send", async () => {
  const active = { ...snapshot, generation: "g1", reset: true, before: 0, state: "working" };
  const at = Date.now();
  const reply = { id: "reply", role: "assistant", text: "First Pi reply", at };
  const words = "please\r\n\x1b[31mcontinue\x1b[0m\u202e";
  const tags = '<hc reply-to="First Pi reply"/>\n<hc task="7">brief</hc>\n';
  const user = { id: "old", role: "user", text: tags + "please\ncontinue", at };
  let items = [user, reply];
  const reader = new ChatReader({ sh: async () => json({ ...active, items }) }, addr);
  await reader.locate({ state: "live", foreground: { name: "pi", pid: 77 } });
  const sent: any[] = [], jobs: Promise<unknown>[] = [];
  let draft = "", id = 0;
  const norm = (s: string) => s?.replace(/\s+/g, " ").trim();
  const self: any = { addr, kind: "pi", piReader: reader, phase: "finding", files: [], pending: [], queue: [],
    results: new Map(), opened: new Set(), box: { value: () => draft, set_value: (s: string) => { draft = s; } },
    status: method("status"), saveSoon() {}, taskTags: () => '<hc task="7">brief</hc>\n',
    sendIo: () => ({ hc: () => { throw new Error("Pi never types in the terminal"); } }),
    settlePending: method("settlePending", { norm, same: (a: string, b: string) => norm(a) === norm(b), ownWords }),
    recoverPiOutgoing: method("recoverPiOutgoing", { piHistoryOf, piQuoteFor, samePiHistory }),
    piExec: async (_: string, args: string[], on: string, input: string) => {
      sent.push({ args, on, ...JSON.parse(input) });
      return json({ ok: true, status: "queued" });
    },
    deliver: method("deliver", { excerpt, norm, messageBody, refusal, sendTyped, piSend, piQuoteFor, piVisibleBody, samePiHistory,
      attach: { deliver: async () => [] }, SETTLE: null }),
  };
  const cx = { notify() {}, timer: { after() {} }, sleep: async () => {}, spawn: (fn: Function) => jobs.push(fn(cx)) };
  const pull = method("pull");
  await pull.call(self, cx);
  expect(self.conv.items[1].text).toBe(reply.text);
  expect(self.status()).toBe("working");
  const send = method("send", { piTarget, piQuoteFor, piRequestId: () => `steer-${++id}`, note() {},
    mentions: { expand: (v: string) => v, expandTasks: (v: string) => v } });
  for (let i = 0; i < 2; i++) {
    draft = words;
    self.quote = { text: reply.text, piHistory: piHistoryOf(active) };
    send.call(self, cx);
  }
  await Promise.all(jobs);
  expect(self.pending.map((p: any) => p.delivered)).toEqual([true, true]);
  expect(sent).toEqual([1, 2].map((i) => ({ args: ["pi-chat", "send", "77"], on: "desktop-remote",
    id: `steer-${i}`, body: tags + words, mode: "now", instance: active.instance, session: active.session, leaf: active.leaf, generation: active.generation })));
  self.settlePending();
  expect(self.pending.map((p: any) => p.msg.id)).toEqual(["steer-1", "steer-2"]);
  items = [...items, { ...user, id: "different", text: "Do not say: please\ncontinue" }];
  await pull.call(self, cx);
  expect(self.pending.map((p: any) => p.msg.id)).toEqual(["steer-1", "steer-2"]);
  items = [...items, { ...user, id: "consumed-1" }];
  await pull.call(self, cx);
  self.settlePending();
  expect(self.pending.map((p: any) => p.msg.id)).toEqual(["steer-2"]);
  items = [...items, { ...user, id: "consumed-2" }];
  await pull.call(self, cx);
  expect(self.pending).toEqual([]);
});

test("desktop paging keeps its anchor and drops a tool response from the previous Pi branch", async () => {
  const root = { ...snapshot, generation: "original", reset: true, before: 1, live: [] };
  const tool = { id: "call:0", role: "tool", text: "read", at: 1234 };
  const result = { id: "result:0", role: "result", text: "call:0", at: 1235 };
  let answer = { ...root, items: [tool, result] };
  let deliverResult: ((r: ReturnType<typeof json>) => void) | undefined;
  const reader = new ChatReader({ sh: async (_: string, args: string[]) => {
    if (args[1] === "results") return new Promise((resolve) => { deliverResult = resolve; });
    if (args[1] === "page") return json({ ...root, before: 0, items: [{ id: "old:0", role: "user", text: "older", at: 1000 }] });
    return json(answer);
  } }, addr);
  await reader.locate({ state: "live", foreground: { name: "pi", pid: 77 } });
  const jobs: Promise<unknown>[] = [];
  const cx = { notify() {}, spawn: (fn: Function) => jobs.push(fn(cx)) };
  const self: any = { addr, kind: "pi", piReader: reader, results: new Map(), opened: new Set(), recoverPiOutgoing() {},
    rows: () => [{ id: "top" }, ...reader.conv!.items],
    settlePending() {}, loadResults: method("loadResults", { KEEP: 2000 }) };
  const pull = method("pull");
  await pull.call(self, cx);
  const row = self.conv.items[0];
  method("loadEarlier").call(self, cx);
  await jobs.pop();
  expect(self.anchor.id).toBe(row.id);
  expect(self.start).toBe(0);
  expect(self.conv.items[0].text).toBe("older");
  self.opened.add(row.id);
  self.loadResults(row, cx);
  const oldTool = jobs.pop();
  expect(deliverResult).toBeDefined();
  const view = self.piView;
  answer = { ...root, leaf: "compact", items: [tool, result,
    { id: "compact:0", role: "compaction", text: "Summary", at: 1238 }] };
  await pull.call(self, cx);
  expect(self.piView).toBe(view);
  expect(self.start).toBe(0);
  expect(self.anchor.id).toBe(row.id);
  expect(self.conv.items.at(-1)).toMatchObject({ kind: "brief", label: "Compaction summary" });
  answer = { ...root, generation: "fork", leaf: "other", before: 0,
    items: [{ id: "other:0", role: "assistant", text: "new branch", at: 1240 }] };
  await pull.call(self, cx);
  deliverResult?.(json({ ...root, outputs: [{ id: "call:0", text: "previous branch's output" }] }));
  await oldTool;
  expect(self.conv.items.map((i: any) => i.text)).toEqual(["new branch"]);
  expect(self.results.size).toBe(0);
  expect(self.opened.size).toBe(0);
  expect(self.anchor).toBeNull();
});

test("desktop held sends keep the old leaf; Send now steers and an unconfirmed send has no Retry", async () => {
  const sent: any[] = [];
  const jobs: Promise<unknown>[] = [];
  let answer = json({ ok: true, status: "waiting" }), draft = "";
  const self: any = {
    addr, kind: "pi", machine: "desktop-remote", phase: "ready", piReader: { pid: 77, pi: snapshot },
    queue: [], pending: [], files: [], asks: [{ stale: true }], status: () => "idle", saveSoon() {}, async saveDraft() {}, taskTags: () => "", sendIo: () => ({}),
    box: { value: () => draft, set_value: (text: string) => { draft = text; } }, restorePiDraft: method("restorePiDraft"),
    piExec: async (_: string, args: string[], on: string, input: string, current: () => boolean) => {
      expect(current()).toBeTrue();
      sent.push({ args, on, ...JSON.parse(input) });
      return answer;
    },
    deliver: method("deliver", { messageBody, refusal, sendTyped, piSend, piQuoteFor, piVisibleBody, samePiHistory, PI_UNAVAILABLE,
      attach: { deliver: async () => [] }, norm: (s: string) => s, SETTLE: null,
      openCard: () => { throw new Error("Pi does not use Claude or Codex's cards"); } }),
  };
  const cx = { notify() {}, sleep: async () => {}, spawn: (fn: Function) => jobs.push(fn(cx)) };
  const msg = { id: "m9", text: "/model", files: [], hold: true, piAddr: addr, pi: piTarget(77, snapshot) };
  self.deliver(msg, cx);
  await jobs.pop();
  expect(self.queue).toEqual([msg]);
  expect(self.pending).toEqual([]);
  self.piReader.pi = { ...snapshot, leaf: "new-leaf" };
  answer = json({ ok: false, error: "unconfirmed", ambiguous: true }, 1);
  method("sendQueued").call(self, msg, cx);
  await jobs.pop();
  expect(sent.map(({ mode, leaf, on, body }) => [mode, leaf, on, body])).toEqual([
    ["hold", "old-leaf", "desktop-remote", "/model"], ["now", "old-leaf", "desktop-remote", "/model"],
  ]);
  expect(self.pending[0]).toMatchObject({ failed: PI_UNCONFIRMED, noRetry: true, ambiguous: true });
  method("retry").call(self, self.pending[0], cx);
  expect(jobs).toHaveLength(0);
  expect(self.queue).toEqual([]);
  self.kind = "codex";
  self.deliver(msg, cx);
  await jobs.pop();
  expect(sent).toHaveLength(2);
  expect(draft).toBe("/model");
  expect(self.pending).toHaveLength(1);
});

test("desktop restores outgoing messages from another Pi branch as a draft without the quote", () => {
  const old = { ...snapshot, generation: "original" }, current = { ...snapshot, generation: "fork" };
  const message = (text: string, target = old) => ({ text, piAddr: addr, pi: piTarget(77, target), files: [] });
  let draft = "existing draft";
  const self = { addr, piHistory: piHistoryOf(old), pending: [{ msg: message("previous send") }],
    queue: [message("previous hold"), message("this branch only", current)], quote: { id: "old quote" }, files: [], restorePiDraft: method("restorePiDraft"),
    box: { value: () => draft, set_value: (text: string) => { draft = text; } }, saveSoon() {} };
  method("recoverPiOutgoing", { piHistoryOf, piQuoteFor, samePiHistory }).call(self, current, {});
  expect(self.pending).toEqual([]);
  expect(self.queue.map((m) => m.text)).toEqual(["this branch only"]);
  expect(self.quote).toBeNull();
  expect(draft).toBe("existing draft\n\nprevious send\n\nprevious hold");
});

test("desktop does not attach a restored quote to a replacement Pi session", async () => {
  const old = { ...snapshot, session: "old", generation: "old" };
  const current = { ...snapshot, session: "current", generation: "current" };
  for (const saved of [undefined, piHistoryOf(old), piHistoryOf(current)]) {
    let text = "";
    let sent: any;
    const files = [{ path: "example.txt" }];
    const self: any = { addr, kind: "pi", phase: "finding", status: () => "idle", piReader: { pid: 77 },
      pending: [], queue: [], files: [], box: { value: () => text, set_value: (v: string) => { text = v; } },
      saveSoon() {}, deliver: (msg: any) => { sent = msg; } };
    const cx = { notify() {}, timer: { after() {} } };
    await method("loadDraft", { piQuoteFor, fs: { readFile: async () => JSON.stringify({
      text: "saved words", files, quote: { text: "quoted words", piHistory: saved },
    }) } }).call(self, cx);
    self.piReader.pi = current;
    self.phase = "ready";
    method("recoverPiOutgoing", { piHistoryOf, piQuoteFor, samePiHistory }).call(self, current, cx);
    method("send", { piTarget, piQuoteFor, piRequestId: () => "send", note() {},
      mentions: { expand: (v: string) => v, expandTasks: (v: string) => v } }).call(self, cx);
    expect(sent).toMatchObject({ text: "saved words", files, pi: { session: "current" },
      quote: saved === piHistoryOf(current) ? { text: "quoted words" } : null });
  }
});

test("a fresh desktop Assistant does not start with a restored Pi quote", async () => {
  const quote = { text: "the old Pi reply", piHistory: piHistoryOf(snapshot) };
  const files = [{ path: "example.txt" }];
  let text = "";
  let started: any;
  const self: any = { kind: null, phase: "fresh", box: { value: () => text, set_value: (v: string) => { text = v; } },
    saveSoon() {}, deliver: method("deliver"), startAgent: (msg: any) => { started = msg; } };
  const cx = { notify() {}, timer: { after() {} } };
  await method("loadDraft", { fs: { readFile: async () => JSON.stringify({ text: "saved draft", files, quote }) } }).call(self, cx);
  method("send", { note() {}, mentions: { expand: (v: string) => v, expandTasks: (v: string) => v } }).call(self, cx);
  expect(started).toMatchObject({ text: "saved draft", files, quote: null });
});

test("blocked desktop keeps a draft and Pi-only controls cannot trigger another CLI", () => {
  const self = { kind: "pi", phase: "ready", status: () => "blocked", box: { value: () => { throw new Error("must leave the draft alone"); } } };
  method("send").call(self, {}, false);
  method("sendQueued").call(self, {}, {});
  for (const name of ["rewind", "fork", "modelCommand", "applyPick", "current"]) {
    method(name).call(self, {}, {});
  }
});

test("desktop leaves a draft and held send alone while the Pi target is unverified", async () => {
  let draft = "keep this draft";
  const queued = { text: "keep this held", files: [] };
  const delivered: unknown[] = [];
  const self = { kind: "pi", phase: "ready", piReader: null as null | { piFresh: boolean; pi: typeof snapshot; pid: number }, addr,
    status: () => "idle", files: [], queue: [queued], saveSoon() {},
    box: { value: () => draft, set_value: (value: string) => { draft = value; } },
    deliver: (message: unknown) => delivered.push(message) };
  const cx = { notify() {}, timer: { after() {} } };
  const send = method("send", { piTarget, piQuoteFor, piRequestId: () => "fresh", note() {},
    mentions: { expand: (v: string) => v, expandTasks: (v: string) => v } });
  for (const reader of [null, { piFresh: true, pi: snapshot, pid: 77 }]) {
    self.piReader = reader;
    send.call(self, cx);
    method("sendQueued").call(self, queued, cx);
    expect(draft).toBe("keep this draft");
    expect(self.queue).toEqual([queued]);
    expect(delivered).toEqual([]);
  }
});

test("desktop invalidates the reader and saves only unsent drafts when its terminal disappears", async () => {
  const target = piTarget(77, snapshot), files = [{ path: "retained file" }];
  const message = (text: string) => ({ text, piAddr: addr, pi: target, files });
  let draft = "still typing", saved: unknown;
  const self: any = { addr, kind: "pi", phase: "ready", piReader: { pi: snapshot },
    pending: [{ msg: message("not sent"), failed: "Pick a model" }, { msg: message("maybe sent"), piDispatched: true }], queue: [], files: [],
    box: { value: () => draft, set_value: (text: string) => { draft = text; } }, saveSoon() {},
    restorePiDraft: method("restorePiDraft"), recoverPiOutgoing: method("recoverPiOutgoing", { piHistoryOf, piQuoteFor, samePiHistory }),
    async saveDraft() { expect(this.piReader).toBeNull(); saved = { text: draft, files: this.files }; },
    set(phase: string) { expect(saved).toBeDefined(); this.phase = phase; },
    checkLost: async () => false,
  };
  let report = { stdout: JSON.stringify({ state: "live", foreground: { name: "zsh", pid: 45 } }), stderr: "" };
  const locate = method("locate", { kindOf, hc: async () => report, terminals: () => [] });
  await locate.call(self, {});
  expect(self.phase).toBe("unsupported");
  report = { stdout: "", stderr: "not_found" };
  await locate.call(self, {});
  expect(self.phase).toBe("ended");
  expect(saved).toEqual({ text: "still typing\n\nnot sent", files });
  expect(self.pending.map((p: any) => p.msg.text)).toEqual(["maybe sent"]);
});

test("desktop waits for in-flight Pi refusals on exit without restoring unconfirmed sends", async () => {
  for (const answer of [json({ ok: false, error: "stale_session" }, 1), json({ ok: true, status: "waiting" }),
    json({ ok: false, error: "unconfirmed", ambiguous: true }, 1)]) {
    const files = [{ path: "example.txt", name: "example.txt" }];
    const jobs: Promise<unknown>[] = [];
    let draft = "", saved: unknown, finish!: (value: typeof answer) => void, dispatched!: () => void;
    const sending = new Promise((resolve) => { dispatched = () => resolve(undefined); });
    const self: any = { addr, kind: "pi", phase: "ready", piReader: { pid: 77, pi: snapshot }, pending: [], queue: [], files: [],
      box: { value: () => draft, set_value: (text: string) => { draft = text; } },
      taskTags: () => "", saveSoon() {}, async saveDraft() { saved = { text: draft, files: this.files }; },
      restorePiDraft: method("restorePiDraft"), recoverPiOutgoing: method("recoverPiOutgoing", { piHistoryOf, piQuoteFor, samePiHistory }),
      sendIo: () => ({}), set(phase: string) { this.phase = phase; }, checkLost: async () => false,
      piExec: (_s: string, _args: string[], _on: string, _input: string, current: () => boolean) => {
        expect(current()).toBeTrue();
        dispatched();
        return new Promise((resolve) => { finish = resolve; });
      },
    };
    const cx = { notify() {}, spawn: (fn: Function) => jobs.push(fn(cx)) };
    method("deliver", { messageBody, refusal, sendTyped, piSend, piQuoteFor, piVisibleBody, samePiHistory,
      attach: { deliver: async () => [] }, norm: (s: string) => s, SETTLE: null })
      .call(self, { text: "outgoing draft", piAddr: addr, pi: piTarget(77, snapshot), files }, cx);
    await sending;
    const exit = method("locate", { kindOf, terminals: () => [], hc: async () => ({ stderr: "",
      stdout: JSON.stringify({ state: "live", foreground: { name: "zsh", pid: 45 } }) }) }).call(self, cx);
    await Promise.resolve();
    expect(self.piReader).toBeNull();
    expect(self.phase).not.toBe("ended");
    finish(answer);
    await Promise.all([exit, ...jobs]);
    expect(self.phase).toBe("unsupported");
    if (JSON.parse(answer.stdout).ambiguous) {
      expect(saved).toBeUndefined();
      expect(self.pending[0].ambiguous).toBeTrue();
    } else {
      expect(saved).toEqual({ text: "outgoing draft", files });
      expect(self.pending).toEqual([]);
    }
  }
});

test("a desktop save delayed by filesystem I/O cannot delete a newer recovered draft", async () => {
  let draft = "", disk: string | null = "old draft", finish!: (exists: boolean) => void;
  const fs = { exists: () => new Promise((resolve) => { finish = resolve; }), unlink: async () => { disk = null; },
    mkdir: async () => {}, writeFile: async (_file: string, contents: string) => { disk = contents; } };
  const self = { box: { value: () => draft }, files: [] as { path: string }[], quote: null, queue: [], draftFile: "draft", markTyping() {} };
  const saveDraft = method("saveDraft", { fs, appHome: () => "/scratch" });
  const older = saveDraft.call(self);
  await Promise.resolve();
  draft = "restored words";
  self.files = [{ path: "attachment" }];
  const newer = saveDraft.call(self);
  finish(true);
  await Promise.all([older, newer]);
  expect(JSON.parse(disk!)).toMatchObject({ text: draft, files: self.files });
});

test("desktop Assistant exit does not move ambiguous Pi sends into a fresh composer", async () => {
  let draft = "";
  const attempt = { piPrior: new Set(), ambiguous: true, msg: { text: "possibly sent", files: [{ path: "example.txt" }] } };
  const self = { role: "coordinator", phase: "ended", pending: [attempt], async locate() {}, resumable: () => false,
    startFresh() { this.phase = "fresh"; }, endedWhy: async () => "", box: { value: () => draft, set_value: (text: string) => { draft = text; } } };
  await method("follow", { toast() {} }).call(self, { notify() {} });
  expect(self.phase).toBe("fresh");
  expect(self.pending).toEqual([attempt]);
  expect(draft).toBe("");
});

test("desktop saves an editable draft when the send is canceled before dispatch", async () => {
  const files = [{ path: "example.txt", name: "example.txt" }];
  let draft = "new words", saved: unknown;
  const jobs: Promise<unknown>[] = [];
  const self: any = { addr, kind: "pi", phase: "ready", piReader: { pid: 77, pi: snapshot, piBarrier: {} },
    box: { value: () => draft, set_value: (text: string) => { draft = text; } }, files: [], pending: [],
    taskTags: () => "", saveSoon() {}, async saveDraft() { saved = { text: draft, files: this.files }; },
    restorePiDraft: method("restorePiDraft"), sendIo: () => ({}),
    piExec: () => { throw new Error("must not call the old Pi"); },
  };
  const attach = { deliver: async () => { self.piReader.piBarrier = {}; return ["prepared path"]; } };
  const cx = { notify() {}, spawn: (fn: Function) => jobs.push(fn(cx)) };
  method("deliver", { messageBody, refusal, sendTyped, piSend, piQuoteFor, piVisibleBody, samePiHistory, attach,
    norm: (s: string) => s, SETTLE: null }).call(self, { text: "canceled words", piAddr: addr, pi: piTarget(77, snapshot), files }, cx);
  await jobs[0];
  expect(self.pending).toEqual([]);
  expect(saved).toEqual({ text: "new words\n\ncanceled words", files });
});

test("desktop saves the draft if Pi's local stdin file cannot be prepared", async () => {
  const jobs: Promise<unknown>[] = [], files = [{ path: "example.txt", name: "example.txt" }];
  let draft = "", saved: unknown;
  const self = { addr, kind: "pi", phase: "ready", piReader: { pid: 77, pi: snapshot }, pending: [], files: [],
    box: { value: () => draft, set_value: (value: string) => { draft = value; } },
    taskTags: () => "", saveSoon() {}, async saveDraft() { saved = { text: draft, files: this.files }; },
    restorePiDraft: method("restorePiDraft"), sendIo: () => ({}),
    piExec: method("piExec", { exec: async (cmd: string) => { expect(cmd).toBe("mktemp"); return { code: 1 }; } }),
  };
  method("deliver", { messageBody, refusal, sendTyped, piSend, piQuoteFor, piVisibleBody, samePiHistory,
    attach: { deliver: async () => [] }, norm: (s: string) => s, SETTLE: null }).call(self,
    { text: "unsent words", piAddr: addr, pi: piTarget(77, snapshot), files }, { notify() {}, spawn: (fn: Function) => jobs.push(fn()) });
  await Promise.all(jobs);
  expect(self.pending).toEqual([]);
  expect(saved).toEqual({ text: "unsent words", files });
});

test("desktop cancels a Pi send invalidated while its stdin is being prepared", async () => {
  let current = true, file = "", dispatched = false;
  const exec = async (prog: string, args: string[]) => {
    if (prog === "sh") { dispatched = true; return { code: 0, stdout: '{"ok":true,"status":"accepted"}' }; }
    const r = Bun.spawnSync([prog, ...args]);
    return { code: r.exitCode, stdout: r.stdout.toString() };
  };
  const go = method("piExec", { exec, writeTextFile: (path: string, input: string) => {
    file = path;
    writeFileSync(path, input);
    current = false;
  } });
  const result = await piSend((...a: [string, string[], string | null, string]) => go.call({}, ...a, () => current),
    addr, piTarget(77, snapshot), "pending", "keep these words");
  expect(result).toMatchObject({ code: 1, noRetry: true, canceled: true });
  expect(dispatched).toBeFalse();
  expect(file).not.toBe("");
  expect(existsSync(file)).toBeFalse();
});

test("desktop Pi stdin file is private, routed on the right machine and removed after a failed transport", async () => {
  const input = JSON.stringify({ body: "text not for argv" });
  let file = "";
  const exec = async (prog: string, args: string[]) => {
    if (prog === "sh") {
      file = args[3];
      expect(readFileSync(file, "utf8")).toBe(input);
      expect(statSync(new URL(".", `file://${file}`)).mode & 0o777).toBe(0o700);
      expect(args.slice(4)).toEqual(["hc", "exec", "--on", "desktop-remote", "--stdin", "--timeout", "10", "--", "sh", "-c", "script", "pi-chat", "send", "77"]);
      expect(args.join(" ")).not.toContain(input);
      throw new Error("transport ended");
    }
    const r = Bun.spawnSync([prog, ...args]);
    return { code: r.exitCode, stdout: r.stdout.toString() };
  };
  await expect(method("piExec", { exec, writeTextFile: (p: string, s: string) => writeFileSync(p, s) })
    .call({}, "script", ["pi-chat", "send", "77"], "desktop-remote", input)).rejects.toThrow("transport ended");
  expect(file).not.toBe("");
  expect(existsSync(file)).toBeFalse();
  expect(existsSync(new URL(".", `file://${file}`))).toBeFalse();
});
