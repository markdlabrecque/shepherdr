import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "./actions.ts";
import { Chats } from "./chats.ts";
import { activity, Compat } from "./compat.ts";
import { Live } from "./live.ts";
import { piConversation } from "../core/chat-log.js";
import { tabCanChat } from "../web/plugins/terminal/shown.ts";
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
      const result: any = await send(request);
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
  const { h, compat, calls, requests, notes } = remote(() => ({ ...snap, state: "working" }), () => ({ ok: true, status: "queued" }));
  const fake = join(root, "hc");
  const getLog = join(root, "get-args");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${getLog}'\necho '{"foreground":{"pid":4242,"name":"node","argv":["/bin/pi"]}}'\n`, { mode: 0o755 });
  process.env.SHEPHERDR_HC = fake;
  h.terminals.set(addr, { ...live, foreground: null, status: null } as any);
  const chats = new Chats(h);
  const page = () => {};
  try {
    chats.watch(addr, page);
    await until(() => chats.reader(addr)?.pi);
    const reader = chats.reader(addr)!;
    expect(reader.conv!.items.map(({ id, text, at }: any) => ({ id, text, at }))).toEqual(snap.items.map(({ role, ...item }) => item));
    const chat = new Compat().chat(`t:${addr}`, reader, live);
    expect(chat).toMatchObject({ cli: "pi", working: true, agent: { kind: "pi", words: "Pi" } });
    expect(chat.messages.map((m) => m.at)).toEqual(snap.items.map((m) => m.at));
    expect(await Bun.file(getLog).text()).toBe(`get\n${addr}\n--json\n`);
    const message = { type: "send", chat: `t:${addr}`, text: "/literal\n你好", cid: "pi-remote-1", human: true, piHistory: piHistoryOf(snap) };
    expect(await act(h, message, compat)).toHaveProperty("ok", true);
    expect(requests).toEqual([{ instance: "inst", session: "session", leaf: "r1", id: "pi-remote-1", body: "/literal\n你好", mode: "now" }]);
    expect(notes[0]).toMatchObject([addr, { cid: "pi-remote-1", text: message.text }]);
    // A queued steering receipt is not a user message in Pi's conversation.
    expect(new Compat().chat(`t:${addr}`, reader, live).messages.map((m) => m.text)).toEqual(["hi", "hello"]);
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

function tabSnapshot(compat: Compat, terminal: { address: string }) {
  (compat as any).terminalsOf = () => terminal;
  return compat.snapshot({ host: "local", user: "Test", machines: [], sections: [], rows: [], spaces: [{
    id: "pi-remote/sp1", name: "Test space", machine: "pi-remote", folder: "/repo",
    tabs: [{ id: "tb1", terminals: [terminal.address] }],
  } as any] });
}

test("selecting an ordinary remote terminal discovers Pi before its chat is watched", async () => {
  const selected = "pi-remote/t42", term = `t:${selected}`;
  const terminal = { address: selected, state: "live", created_ms: 42, argv: ["bash"], foreground: null, status: null };
  const listeners: ((event: any) => void)[] = [];
  const h = { terminals: new Map([[selected, terminal]]), on: (f: (event: any) => void) => listeners.push(f) } as unknown as Hub;
  const compat = new Compat();
  const wire = new Live(h, { on() {}, load: async () => ({}) } as any, () => null, "test");
  wire.compat = compat;
  wire.chats = new Chats(h);
  const updates: any[] = [];
  const ws = { data: {}, readyState: 1, getBufferedAmount: () => 0, send: (text: string) => updates.push(JSON.parse(text)) } as any;
  wire.join(ws);
  const tab = (t = terminal) => tabSnapshot(compat, t).places[0].tabs![0];
  expect(tabCanChat(tab().cli)).toBeFalse();
  const fake = join(root, "hc-discover"), getLog = join(root, "detect-args");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${getLog}'\necho '{"foreground":{"pid":42,"name":"node","argv":["/bin/pi"]}}'\n`, { mode: 0o755 });
  process.env.SHEPHERDR_HC = fake;
  try {
    let discovered: ReturnType<typeof tab> | undefined;
    wire.onPiTab = () => {
      const snapshot = tabSnapshot(compat, terminal);
      discovered = snapshot.places[0].tabs![0];
      wire.setSnapshot(snapshot);
    };
    // Terminal view sends only this selection, not a subscription to its chat.
    wire.message(ws, JSON.stringify({ type: "watch", chats: [], term }));
    await until(() => discovered);
    expect(discovered).toMatchObject({ cli: "pi", term });
    expect(tabCanChat(discovered?.cli)).toBeTrue();
    expect(updates.find((m) => m.type === "snapshot").snapshot.places[0].tabs[0]).toMatchObject({ cli: "pi", term });
    expect(await Bun.file(getLog).text()).toBe(`get\n${selected}\n--json\n`);
    expect(tabCanChat(tab({ ...terminal, created_ms: 43 }).cli)).toBeFalse();
    // An ordinary shell replacing Pi must not retain the previous switch on the same terminal.
    const shellLog = join(root, "detected-shell");
    writeFileSync(fake, `#!/bin/sh\necho '{"foreground":{"pid":43,"name":"bash"}}'\ntouch '${shellLog}'\n`);
    discovered = undefined;
    for (const on of listeners) on({ type: "foreground", terminal: selected });
    await until(() => existsSync(shellLog));
    expect(tabCanChat(tab().cli)).toBeFalse();
    expect(discovered).toBeUndefined();
  } finally {
    wire.leave(ws);
    if (previous.hc === undefined) delete process.env.SHEPHERDR_HC; else process.env.SHEPHERDR_HC = previous.hc;
  }
});

test("web keeps a repeated Pi send pending until a new exact body appears", async () => {
  const at = Date.now(), active = { ...snap, state: "working", generation: "g1", reset: true, before: 0, live: [] };
  const old = { id: "old", role: "user", text: "continue", at: at - 10 };
  const items = [old, { id: "reply", role: "assistant", text: "still working", at }];
  let records = items;
  const { h } = remote(() => ({ ...active, items: records }), () => ({ ok: true, status: "queued" }));
  const compat = new Compat();
  const key = tabSnapshot(compat, live).places[0].tabs![0].term;
  const send = (cid: string) => act(h, { type: "send", chat: key, text: old.text, cid, pi: true, piHistory: piHistoryOf(active) }, compat);
  const chat = () => compat.chat(key, { addr, kind: "pi", state: "ready", pi: active, conv: piConversation(records, active) }, live);
  expect(await send("repeat-1")).toHaveProperty("ok", true);
  expect(await send("repeat-2")).toHaveProperty("ok", true);
  expect(chat().messages.map((m) => m.cid)).toEqual([undefined, undefined]);
  records = [...records, { ...old, id: "different", text: '<hc reply-to="Different words"/>\ncontinue', at }, { ...old, id: "new-1", at }];
  expect(chat().messages.map((m) => m.cid)).toEqual([undefined, undefined, undefined, "repeat-1"]);
  // Even if the first confirmed row scrolls out of the loaded page, its CID can't move to the second row.
  records = [{ ...old, id: "new-2", at }];
  expect(chat().messages.map((m) => m.cid)).toEqual(["repeat-2"]);
});

test("web republishes Pi's normalized user row if the send receipt arrives after history", async () => {
  let bridge = { ...snap, state: "working" };
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => { release = resolve; });
  const { h, requests } = remote(() => bridge, async () => { await receipt; return { ok: true, status: "queued" }; });
  const compat = new Compat(), chats = new Chats(h);
  compat.reader = (a) => chats.reader(a);
  compat.onPiSend = (a) => chats.refresh(a);
  const key = tabSnapshot(compat, live).places[0].tabs![0].term;
  const published: ReturnType<Compat["chat"]>[] = [];
  const page = (r: any, t: any) => published.push(compat.chat(key, r, t));
  const message = { type: "send", chat: key, cid: "pi-late-receipt", text: "line one\r\n\x1b]0;terminal title\x07line two\u2066", piHistory: piHistoryOf(snap) };
  let pending: ReturnType<typeof act> | undefined;
  chats.watch(addr, page);
  try {
    await until(() => published.length);
    pending = act(h, message, compat);
    await until(() => requests.length);
    expect(requests[0]).toMatchObject({ body: message.text, id: message.cid });
    bridge = { ...bridge, items: [...snap.items, { id: "user", role: "user", text: "line one\nline two", at: Date.now() }] };
    const last = () => published.at(-1)?.messages.at(-1);
    await until(() => last()?.id === "user");
    expect(last()?.cid).toBeUndefined();
    release();
    expect(await pending).toHaveProperty("ok", true);
    expect(last()).toMatchObject({ id: "user", cid: message.cid, text: "line one\nline two" });
  } finally { release(); await pending?.catch(() => {}); chats.unwatch(addr, page); }
});

test("web leaves Pi prompts in the terminal and reports a missing integration as unavailable", async () => {
  let bridge: unknown = { ...snap, state: "blocked" };
  const { h, compat, calls, requests, notes } = remote(() => bridge, () => ({ ok: false, error: "blocked" }));
  const key = `t:${addr}`;
  const chats = new Chats(h), pageCompat = new Compat();
  const published: ReturnType<Compat["chat"]>[] = [];
  const page = (r: any, t: any) => published.push(pageCompat.chat(key, r, t));
  const latest = () => published.at(-1)!;
  const send = { type: "send", chat: key, text: "yes", pi: true, piHistory: piHistoryOf(snap) };
  chats.watch(addr, page);
  try {
    await until(() => published.length);
    expect(latest()).toMatchObject({ cli: "pi", blocked: PI_BLOCKED, working: false });
    expect(latest().messages.some((m) => m.question)).toBeFalse();
    await expect(act(h, { ...send, cid: "pi-terminal-prompt" }, compat)).rejects.toThrow("Answer in the terminal");
    expect(requests).toHaveLength(1);
    bridge = { ok: false, error: "unsafe_registry" };
    await until(() => latest().notice === "pi-unavailable");
    expect(latest()).toMatchObject({ cli: "pi", notice: "pi-unavailable", messages: [], working: false });
    expect(latest().blocked).toBeUndefined();
    await expect(act(h, { ...send, cid: "pi-missing-bridge" }, compat)).rejects.toThrow(PI_UNAVAILABLE);
    expect(requests).toHaveLength(1);
    expect(notes).toEqual([]);
    expect(calls.every((p) => p.method === "machine.exec" && ["snapshot", "send"].includes(p.argv[4]))).toBeTrue();
  } finally { chats.unwatch(addr, page); }
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
      items: [row("fork:0", "fork only"), row("notice:0", "retained history", "compaction"),
        row("edit:0", "changed model context", "context-edit")] });
    await until(() => latest().piView !== view);
    finishResult?.({ ...shape, outputs: [{ id: "call:0", text: "out from old branch" }] });
    expect(await details).toHaveProperty("error");
    expect(latest().messages.map((m) => m.text)).toEqual(["fork only", "retained history", "changed model context"]);
    expect(latest().messages.slice(1).map((m) => m.brief?.label)).toEqual(["Compaction summary", "Context edit"]);
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

test("a core reconnect fences the old in-flight Pi overlay before publishing again", async () => {
  const first = { ...snap, generation: "first", reset: true, before: 0, live: [] };
  const final = { ...first, session: "switched", generation: "next", items: [
    { id: "unique:0", role: "assistant", text: "New session", at: 44 },
  ] };
  const queries: unknown[] = [];
  let delayed: ((value: unknown) => void) | undefined;
  const { h } = remote((_op, query) => {
    queries.push(query);
    return queries.length === 1 ? first : queries.length === 2 ? new Promise((resolve) => { delayed = resolve; }) : final;
  });
  let emit: (event: { type: "reset" }) => void = () => {};
  h.on = (cb) => { emit = cb; return () => true; };
  const chats = new Chats(h);
  const published: string[][] = [];
  const page = (r: any) => published.push(r.conv.items.map((x: any) => x.text));
  chats.watch(addr, page);
  try {
    await until(() => delayed);
    expect(published).toEqual([["hi", "hello"]]);
    emit({ type: "reset" });
    delayed?.({ ...first, reset: false, state: "working", before: 2, items: [],
      live: [{ id: "live:obsolete:0", role: "assistant", text: "Old overlay", at: 43 }] });
    await until(() => published.some((words) => words.includes("New session")));
    expect(queries[2]).toBeUndefined();
    expect(published).toEqual([["hi", "hello"], ["New session"]]);
  } finally { chats.unwatch(addr, page); }
});

test("a transient missing foreground after core reset keeps the verified Pi view", async () => {
  const first = { ...snap, generation: "g1", reset: true, before: 1, live: [] };
  const { h } = remote((op) => op === "page" ? { ...first, before: 0, items: [
    { id: "history", role: "assistant", text: "Loaded earlier", at: 42 },
  ] } : first);
  const fake = join(root, "hc-missing-foreground");
  writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const saved = process.env.SHEPHERDR_HC;
  process.env.SHEPHERDR_HC = fake;
  let emit: (event: { type: "reset" }) => void = () => {};
  h.on = (cb) => { emit = cb; return () => true; };
  const chats = new Chats(h), compat = new Compat();
  const published: ReturnType<Compat["chat"]>[] = [];
  const page = (r: any, t: any) => published.push(compat.chat(`t:${addr}`, r, t));
  const latest = () => published.at(-1)!;
  chats.watch(addr, page);
  try {
    await until(() => published.length);
    const view = latest().piView;
    await chats.earlier(addr, view);
    const reads = published.length;
    h.terminals.set(addr, { ...live, foreground: null } as any);
    emit({ type: "reset" });
    await until(() => published.length > reads);
    expect(latest()).toMatchObject({ piView: view, top: true });
    expect(latest().messages.map((m) => m.text)).toEqual(["Loaded earlier", "hi", "hello"]);
    const interrupted = published.length;
    h.terminals.set(addr, live as any);
    emit({ type: "reset" });
    await until(() => published.length > interrupted);
    expect(latest().piView).toBe(view);
    expect(latest().messages.map((m) => m.text)).toEqual(["Loaded earlier", "hi", "hello"]);
  } finally {
    chats.unwatch(addr, page);
    if (saved === undefined) delete process.env.SHEPHERDR_HC; else process.env.SHEPHERDR_HC = saved;
  }
});

test("web removes an interrupted overlay without resetting the scroller or publishing to a new watcher", async () => {
  const first = { ...snap, generation: "g1", reset: true, before: 0, state: "working",
    live: [{ id: "live:old:0", role: "assistant", text: "Old overlay", at: 43 }] };
  let bridge: Record<string, unknown> = first;
  const { h } = remote(() => bridge);
  const chats = new Chats(h), compat = new Compat();
  const existing: ReturnType<Compat["chat"]>[] = [], joined: ReturnType<Compat["chat"]>[] = [];
  const a = (r: any, t: any) => existing.push(compat.chat(`t:${addr}`, r, t));
  const b = (r: any, t: any) => joined.push(compat.chat(`t:${addr}`, r, t));
  chats.watch(addr, a);
  try {
    await until(() => !!existing.at(-1)?.messages.some((m) => m.provisional));
    const view = existing.at(-1)!.piView;
    bridge = { ok: false, error: "timeout" };
    await until(() => existing.length > 1);
    expect(existing.at(-1)).toMatchObject({ piView: view, working: true });
    expect(existing.at(-1)?.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
    chats.watch(addr, b);
    expect(joined).toHaveLength(0);
    bridge = { ...first, state: "idle", live: [] };
    await until(() => joined.length);
    expect(joined[0]).toMatchObject({ piView: view, working: false });
  } finally { chats.unwatch(addr, a); chats.unwatch(addr, b); }
});

test("a quoted web send is bound to the Pi snapshot the person saw", async () => {
  const original = { ...snap, generation: "old", session: "previous", reset: true, before: 0, live: [] };
  let active = { ...original, generation: "new", session: "replacement" };
  const { h, compat, requests } = remote(() => active);
  compat.reader = (() => ({ kind: "pi", pi: original, conv: { items: [{ id: "old-quote", text: "only on the previous branch" }] } })) as any;
  compat.tasksFor = (() => [{ ref: "TASK-7", title: "Test task", state: "working", folder: "/repo", prompt: "task brief" }]) as any;
  const b = { type: "send", chat: `t:${addr}`, pi: true, reply: "old-quote", text: "response for TASK-7", piHistory: piHistoryOf(original) };
  await expect(act(h, { ...b, cid: "cached-old-reply" }, compat)).rejects.toThrow(PI_CHAT_CHANGED);
  await expect(act(h, { ...b, cid: "wrong-view-reply", piHistory: piHistoryOf(active) }, compat)).rejects.toThrow(PI_CHAT_CHANGED);
  await expect(act(h, { ...b, cid: "unbound-reply", reply: undefined, piHistory: undefined }, compat)).rejects.toThrow(PI_CHAT_CHANGED);
  expect(requests).toEqual([]);
  active = original;
  expect(await act(h, { ...b, cid: "correct-reply" }, compat)).toHaveProperty("ok", true);
  expect(requests[0]).toMatchObject({ session: original.session, generation: original.generation,
    body: '<hc reply-to="only on the previous branch"/>\n<hc task="TASK-7" title="Test task" state="working" folder="/repo">task brief</hc>\nresponse for TASK-7' });
});

test("busy web Hold waits for Pi to settle even when terminal status says idle", async () => {
  let state = "working";
  const { h, compat, requests, notes } = remote(() => ({ ...snap, state }), () => ({ ok: true, status: state === "working" ? "waiting" : "accepted" }));
  const message = { type: "send", chat: `t:${addr}`, cid: "pi-held-until-idle", text: "after the turn", hold: true, pi: true, piHistory: piHistoryOf(snap) };
  expect(await act(h, message, compat)).toEqual({ ok: true, waiting: true, waitsFor: "turn" });
  expect(requests[0]).toMatchObject({ id: message.cid, body: message.text, mode: "hold" });
  await until(() => requests.length >= 2);
  expect(notes).toEqual([]);
  state = "idle";
  await until(() => notes.length);
  expect(requests).toEqual([requests[0], requests[0], requests[0]]);
  expect(notes).toHaveLength(1);
  expect(await act(h, message, compat)).toMatchObject({ ok: true });
  expect(requests).toHaveLength(3);
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
