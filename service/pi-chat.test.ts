import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "./actions.ts";
import { Chats } from "./chats.ts";
import { activity, Compat } from "./compat.ts";
import type { Hub } from "./hub.ts";
import { failedOf, forgetAll } from "./send-once.ts";
import { piHistoryOf, PI_BLOCKED, PI_CHAT_CHANGED, PI_UNAVAILABLE, PI_UNCONFIRMED } from "../core/pi-chat.js";

const addr = "pi-remote/tpi";
const snap = { ok: true, state: "idle", instance: "inst", session: "session", leaf: "r1",
  items: [{ id: "u1", role: "user", text: "hi", at: 1748779200123 },
    { id: "r1", role: "assistant", text: "hello", at: 1748779200456 }] };
const out = (body: unknown, code = 0) => ({ code, stdout: Buffer.from(JSON.stringify(body)).toString("base64"), stderr: "" });
const live = { address: addr, state: "live", foreground: { pid: 4242, name: "pi" }, status: { app: "pi", state: "idle" } };
const root = mkdtempSync(join(tmpdir(), "pi-service-"));
const previous = { data: process.env.SHEPHERDR_DATA, hc: process.env.SHEPHERDR_HC };
beforeAll(() => { process.env.SHEPHERDR_DATA = root; forgetAll(); });
afterAll(() => {
  if (previous.data === undefined) delete process.env.SHEPHERDR_DATA; else process.env.SHEPHERDR_DATA = previous.data;
  forgetAll();
  rmSync(root, { recursive: true, force: true });
});

function remote(read: (op: string, query: any) => unknown = () => snap, send: (request: any) => unknown = () => ({ ok: true, status: "accepted" })) {
  const calls: any[] = [];
  const requests: any[] = [];
  const h = {
    terminals: new Map([[addr, live]]),
    on() {},
    async core() { throw new Error("no watch stream in this test"); },
    async call(method: string, p: any) {
      calls.push({ method, ...p });
      const op = p.argv[4];
      if (op !== "send") {
        const result: any = await read(op, p.argv[6] && JSON.parse(p.argv[6]));
        return out(result, result?.ok ? 0 : 1);
      }
      const request = JSON.parse(Buffer.from(p.input, "base64").toString("utf8"));
      requests.push(request);
      const result: any = send(request);
      return out(result, result?.ok ? 0 : 1);
    },
  } as unknown as Hub;
  const notes: any[] = [];
  const compat = { addrOf: () => addr, tasksFor: () => [], noteSend: (...args: any[]) => notes.push(args), agents: {} } as unknown as Compat;
  return { h, compat, calls, requests, notes };
}

const until = async (f: () => unknown) => {
  for (let i = 0; i < 160 && !f(); i++) await Bun.sleep(20);
  expect(f()).toBeTruthy();
};

test("read and send Pi chat on the qualified machine, with text only on stdin", async () => {
  const { h, compat, calls, requests, notes } = remote(() => ({ ...snap, state: "blocked" }));
  const fake = join(root, "hc");
  const getLog = join(root, "get-args");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${getLog}'\necho '{"foreground":{"pid":4242,"name":"pi"}}'\n`, { mode: 0o755 });
  process.env.SHEPHERDR_HC = fake;
  h.terminals.set(addr, { ...live, foreground: null } as any);
  const chats = new Chats(h);
  const page = () => {};
  try {
    chats.watch(addr, page);
    await until(() => chats.reader(addr)?.pi);
    const reader = chats.reader(addr)!;
    expect(reader.conv!.items.map(({ id, text, at }: any) => ({ id, text, at }))).toEqual(snap.items.map(({ role, ...item }) => item));
    expect(reader.pi.state).toBe("blocked");
    const chat = new Compat().chat(`t:${addr}`, reader, live);
    expect(chat).toMatchObject({ cli: "pi", blocked: PI_BLOCKED, agent: { kind: "pi", words: "Pi" } });
    expect(chat.messages.map((m) => m.at)).toEqual(snap.items.map((m) => m.at));
    expect(await Bun.file(getLog).text()).toBe(`get\n${addr}\n--json\n`);
    const message = { type: "send", chat: `t:${addr}`, text: "/literal\n你好", cid: "pi-remote-1", human: true, piHistory: piHistoryOf(snap) };
    expect(await act(h, message, compat)).toHaveProperty("ok", true);
    expect(requests).toEqual([{ instance: "inst", session: "session", leaf: "r1", id: "pi-remote-1", body: "/literal\n你好", mode: "now" }]);
    expect(notes[0]).toMatchObject([addr, { cid: "pi-remote-1", text: message.text }]);
    expect(calls.every((p) => p.on === "pi-remote" && p.method === "machine.exec")).toBeTrue();
    expect(calls.find((p) => p.argv.at(-2) === "send").argv).toEqual(["sh", "-c", 'exec "$HOME/.local/bin/herdr-pi-chat" "$@"', "pi-chat", "send", "4242"]);
    for (const type of ["restart-info", "model-menu", "restart", "fork", "rewind"]) {
      await expect(act(h, { type, chat: `t:${addr}`, message: "u1" }, compat)).rejects.toThrow(/Pi.*terminal/);
    }
  } finally {
    chats.unwatch(addr, page);
    if (previous.hc === undefined) delete process.env.SHEPHERDR_HC; else process.env.SHEPHERDR_HC = previous.hc;
  }
});

test("web publishes Pi append, earlier, branch replacement and a revalidated reconnect", async () => {
  const key = `t:${addr}`;
  const row = (id: string, text: string, role = "assistant") => ({ id, role, text, at: 1748779200456 });
  const shape = { ...snap, generation: "g1", reset: true, before: 1, live: [] as ReturnType<typeof row>[], items: [row("call:0", "read", "tool")] };
  const queried: any[] = [];
  let getSnapshot = (_query?: any) => shape;
  let finishResult: ((value: unknown) => void) | undefined;
  const { h } = remote((op, query) => {
    queried.push([op, query]);
    if (op === "snapshot") return getSnapshot(query);
    if (op === "page") return { ...shape, before: 0, items: [row("first:0", "older text", "user")] };
    if (op === "results") return new Promise((resolve) => { finishResult = resolve; });
  });
  const chats = new Chats(h);
  const compat = new Compat();
  const published: ReturnType<Compat["chat"]>[] = [];
  const page = (r: any, t: any) => published.push(compat.chat(key, r, t));
  const latest = () => published.at(-1)!;
  chats.watch(addr, page);
  try {
    await until(() => published.length);
    const view = latest().piView!;
    expect(latest().earlier).toBeTrue();
    expect(latest().messages[0].activity?.resultReady).toBeFalse();
    expect(queried.map(([op]) => op)).toEqual(["snapshot"]);
    await chats.earlier(addr, view);
    expect(latest().top).toBeTrue();
    expect(latest().messages[0].text).toBe("older text");
    getSnapshot = (query) => ({ ...shape, before: query?.leaf === "new-result" ? 3 : 2, reset: false, leaf: "new-result", state: "working",
      live: [row("live:1:0", "Pi streaming")], items: query?.leaf === "new-result" ? [] : [row("result:0", "call:0", "result")] });
    await until(() => latest().messages.some((m) => m.provisional));
    const tool = latest().messages.find((m) => m.activity)!.activity!;
    expect(tool.resultReady).toBeTrue();
    expect(latest().piView).toBe(view);
    expect(latest().messages[0].text).toBe("older text");
    const details = activity(chats.reader(addr), tool.id, view);
    await until(() => finishResult);
    getSnapshot = () => ({ ...shape, generation: "other", leaf: "fork", before: 0,
      items: [row("fork:0", "fork only"), row("notice:0", "retained history", "compaction")] });
    await until(() => latest().piView !== view);
    finishResult?.({ ...shape, outputs: [{ id: "call:0", text: "out from old branch" }] });
    expect(await details).toHaveProperty("error");
    expect(latest().messages.map((m) => m.text)).toEqual(["fork only", "retained history"]);
    expect(latest().messages[1].brief?.label).toBe("Compaction summary");
    await chats.earlier(addr, view);
    expect(queried.filter(([op]) => op === "page")).toHaveLength(1);
    chats.unwatch(addr, page);
    const before = published.length;
    getSnapshot = () => ({ ...shape, generation: "after-reconnect", leaf: "root", before: 0, items: [row("root:0", "reconnected only")] });
    chats.watch(addr, page);
    expect(published).toHaveLength(before);
    await until(() => published.length > before);
    expect(latest().messages.map((m) => m.text)).toEqual(["reconnected only"]);
    expect(queried.at(-1)).toEqual(["snapshot", undefined]);
  } finally { chats.unwatch(addr, page); }
});

test("a new Pi subscriber cannot receive a poll already in flight for another tab", async () => {
  const initial = { ...snap, generation: "initial", reset: true, before: 0, live: [] };
  const replacement = { ...initial, generation: "replacement", leaf: "new" };
  let count = 0;
  let finish: ((snapshot: unknown) => void) | undefined;
  const { h } = remote(() => ++count === 1 ? initial : count === 2 ? new Promise((resolve) => { finish = resolve; }) : replacement);
  const chats = new Chats(h);
  const old: string[] = [], joined: string[] = [];
  const a = (r: any) => old.push(r.pi.generation);
  const b = (r: any) => joined.push(r.pi.generation);
  chats.watch(addr, a);
  try {
    await until(() => old.length && finish);
    chats.watch(addr, b);
    chats.refreshAll();
    expect(joined).toEqual([]);
    finish?.({ ...initial, reset: false, before: initial.items.length, items: [], state: "working" });
    await until(() => joined.length);
    expect(joined).toEqual(["replacement"]);
  } finally { chats.unwatch(addr, a); chats.unwatch(addr, b); }
});

test("a quoted web send is bound to the Pi snapshot the person saw", async () => {
  const original = { ...snap, generation: "old", session: "previous" };
  let active = { ...snap, generation: "new", session: "replacement" };
  const { h, compat, requests } = remote(() => active);
  compat.reader = (() => ({ kind: "pi", pi: original, conv: { items: [{ id: "old-quote", text: "only on the previous branch" }] } })) as any;
  const b = { type: "send", chat: `t:${addr}`, pi: true, reply: "old-quote", text: "response", piHistory: piHistoryOf(original) };
  await expect(act(h, { ...b, cid: "cached-old-reply" }, compat)).rejects.toThrow(PI_CHAT_CHANGED);
  await expect(act(h, { ...b, cid: "wrong-view-reply", piHistory: piHistoryOf(active) }, compat)).rejects.toThrow(PI_CHAT_CHANGED);
  await expect(act(h, { ...b, cid: "unbound-reply", reply: undefined, piHistory: undefined }, compat)).rejects.toThrow(PI_CHAT_CHANGED);
  expect(requests).toEqual([]);
  active = original;
  expect(await act(h, { ...b, cid: "correct-reply" }, compat)).toHaveProperty("ok", true);
  expect(requests[0]).toMatchObject({ session: original.session, generation: original.generation, body: expect.stringContaining("only on the previous branch") });
});

test("held Pi send keeps its identity across polls and is not retried after a lost receipt", async () => {
  let sends = 0;
  const { h, compat, requests, notes } = remote(() => snap, () => ++sends === 1 ? { ok: true, status: "waiting" } : null);
  const message = { type: "send", chat: `t:${addr}`, cid: "pi-held", text: "after the turn", hold: true, pi: true, piHistory: piHistoryOf(snap) };
  expect(await act(h, message, compat)).toEqual({ ok: true, waiting: true, waitsFor: "turn" });
  await until(() => failedOf(addr).some((f) => f.cid === message.cid));
  expect(failedOf(addr)).toContainEqual({ cid: message.cid, error: PI_UNCONFIRMED, noRetry: true, ambiguous: true });
  expect(notes).toEqual([]);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  forgetAll(); // even after the service forgets its in-memory queue
  await expect(act(h, message, compat)).rejects.toThrow(PI_UNCONFIRMED);
  expect(sends).toBe(2);
});

test("Pi send refusals distinguish blocked, stale and missing", async () => {
  for (const [error, expected] of [["blocked", "Answer in the terminal"], ["stale_leaf", "changed branches"], ["not_available", PI_UNAVAILABLE]]) {
    const { h, compat, requests, notes } = remote(() => snap, () => ({ ok: false, error }));
    const message = { type: "send", chat: `t:${addr}`, cid: `pi-${error}`, text: "hi", piHistory: piHistoryOf(snap) };
    await expect(act(h, message, compat)).rejects.toThrow(expected);
    expect(requests).toHaveLength(1);
    expect(notes).toEqual([]);
  }
});
