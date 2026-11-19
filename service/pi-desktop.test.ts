import { expect, test } from "bun:test";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { ChatReader } from "../core/chat-reader.js";
import { piSend, piTarget, piHistoryOf, samePiHistory, PI_BLOCKED, PI_UNCONFIRMED, PI_UNAVAILABLE } from "../core/pi-chat.js";
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
  answer = json({ ok: false, error: "not_available" }, 1);
  await pull.call(self, { notify: () => changed.push(1) });
  expect(self.phase).toBe("pi-unavailable");
  expect(changed).toHaveLength(2);
});

test("desktop paging keeps its anchor and drops a tool response from the previous Pi branch", async () => {
  const root = { ...snapshot, generation: "original", reset: true, before: 2, live: [] };
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
  let answer = json({ ok: true, status: "waiting" });
  const self: any = {
    addr, kind: "pi", machine: "desktop-remote", phase: "ready", piReader: { pid: 77, pi: snapshot },
    queue: [], pending: [], asks: [{ stale: true }], status: () => "idle", saveSoon() {}, taskTags: () => "", sendIo: () => ({}),
    piExec: async (_: string, args: string[], on: string, input: string) => { sent.push({ args, on, ...JSON.parse(input) }); return answer; },
    deliver: method("deliver", { messageBody, refusal, sendTyped, piSend, samePiHistory, PI_UNAVAILABLE,
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
  expect(jobs).toHaveLength(0);
  expect(self.pending[1]).toMatchObject({ failed: expect.stringContaining("terminal changed"), noRetry: true });
});

test("desktop restores outgoing messages from another Pi branch as a draft without the quote", () => {
  const old = { ...snapshot, generation: "original" }, current = { ...snapshot, generation: "fork" };
  const message = (text: string, target = old) => ({ text, piAddr: addr, pi: piTarget(77, target), files: [] });
  let draft = "existing draft";
  const self = { addr, piHistory: piHistoryOf(old), pending: [{ msg: message("previous send") }],
    queue: [message("previous hold"), message("this branch only", current)], quote: { id: "old quote" }, files: [],
    box: { value: () => draft, set_value: (text: string) => { draft = text; } }, saveSoon() {} };
  method("recoverPiOutgoing", { piHistoryOf, samePiHistory }).call(self, current, {});
  expect(self.pending).toEqual([]);
  expect(self.queue.map((m) => m.text)).toEqual(["this branch only"]);
  expect(self.quote).toBeNull();
  expect(draft).toBe("existing draft\n\nprevious send\n\nprevious hold");
});

test("blocked desktop keeps a draft and Pi-only controls cannot trigger another CLI", () => {
  const self = { kind: "pi", phase: "ready", status: () => "blocked", box: { value: () => { throw new Error("must leave the draft alone"); } } };
  method("send").call(self, {}, false);
  method("sendQueued").call(self, {}, {});
  for (const name of ["rewind", "fork", "modelCommand", "applyPick", "current"]) {
    method(name).call(self, {}, {});
  }
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
