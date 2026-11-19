import { expect, test } from "bun:test";
import { ChatReader } from "./chat-reader.js";

const addr = "pi-box/t4";
const terminal = { state: "live", foreground: { name: "pi", pid: 73 } };
const row = (id, text, role = "assistant") => ({ id, role, text, at: 42 });
const snap = (x = {}) => ({ ok: true, instance: "process", session: "session", generation: "first",
  leaf: "end", state: "idle", reset: true, before: 0, items: [], live: [], ...x });
const answer = (x) => ({ stdout: JSON.stringify(x), code: x?.ok ? 0 : 1 });
const texts = (reader) => reader.conv?.items.map((x) => x.text);

function rig() {
  const request = [];
  const reader = new ChatReader({ sh: (_script, args, machine) => new Promise((resolve) => {
    const [, op, pid, query] = args;
    request.push({ op, pid, machine, query: query && JSON.parse(query), reply: (x) => resolve(answer(x)) });
  }) }, addr);
  const take = (op) => {
    const call = request.shift();
    expect(call).toMatchObject({ op, pid: "73", machine: "pi-box" });
    return call;
  };
  const pull = async (x) => { const pending = reader.pull(); take("snapshot").reply(x); return await pending; };
  return { reader, take, pull };
}

test("Pi loss and reconnect replace the conversation, even with the same PID and session", async () => {
  const { reader, take, pull } = rig();
  await reader.locate(terminal);
  await pull(snap({ items: [row("1:0", "previous branch")] }));
  expect(texts(reader)).toEqual(["previous branch"]);
  const view = reader.piView;
  await pull({ ok: false, error: "not_available" });
  expect(reader.state).toBe("unavailable");
  expect(reader.conv).toBeNull();
  const pending = reader.pull();
  const call = take("snapshot");
  expect(call.query).toBeUndefined();
  call.reply(snap({ items: [row("2:0", "after reconnect")] }));
  expect(await pending).toBeTrue();
  expect(reader.piView).not.toBe(view);
  expect(texts(reader)).toEqual(["after reconnect"]);
});

test("Pi append and streaming keep loaded earlier pages; final records replace live text exactly once", async () => {
  const { reader, take, pull } = rig();
  await reader.locate(terminal);
  await pull(snap({ before: 1, items: [row("mid:0", "same text")] }));
  const initial = reader.conv.items[0].id;
  const view = reader.piView;
  const page = reader.earlier(view);
  const prev = take("page");
  expect(prev.query).toEqual({ generation: "first", before: 1 });
  const live = [row("live:a:0", "provisional")];
  const stream = reader.pull();
  const at = take("snapshot");
  expect(at.query).toEqual({ generation: "first", leaf: "end" });
  at.reply(snap({ state: "working", reset: false, before: 2, live }));
  await stream;
  prev.reply(snap({ items: [row("old:0", "older")] }));
  expect(await page).toBeTrue();
  expect(reader.start).toBe(0);
  expect(reader.conv.items.at(-1)).toMatchObject({ text: "provisional", provisional: true });
  const liveId = reader.conv.items.at(-1).id;
  await pull(snap({ state: "working", reset: false, before: 2, live: [row("live:a:0", "more words")] }));
  expect(reader.conv.items.at(-1).id).toBe(liveId);
  const final = snap({ leaf: "done", reset: false, before: 2, items: [row("done:0", "same text")] });
  expect(await pull(final)).toBeTrue();
  expect(await pull({ ...final, before: 3, items: [] })).toBeFalse();
  expect(texts(reader)).toEqual(["older", "same text", "same text"]);
  expect(reader.conv.items[1].id).toBe(initial);
  expect(reader.conv.items.at(-1).id).not.toBe(liveId);
  expect(reader.piView).toBe(view);
});

test("Pi discards delayed pages, results and snapshots after a branch, session or cursor reset", async () => {
  const { reader, take, pull } = rig();
  await reader.locate(terminal);
  const tools = [row("call:0", "bash", "tool"), row("out:0", "call:0", "result")];
  await pull(snap({ before: 9, items: tools }));
  const initialView = reader.piView;
  const older = reader.earlier(initialView);
  const page = take("page");
  const output = reader.results(reader.conv.items[0].steps);
  const result = take("results");
  expect(result.query).toEqual({ generation: "first", ids: ["call:0"] });
  const stale = reader.pull(), staleSnapshot = take("snapshot");
  await pull(snap({ leaf: "other", generation: "fork", items: [row("fork:0", "new branch")] }));
  result.reply(snap({ outputs: [{ id: "call:0", text: "old result" }] }));
  page.reply(snap({ items: [row("old:0", "old history")] }));
  staleSnapshot.reply(snap({ items: [row("old:0", "old snapshot")] }));
  expect(await output).toEqual(new Map());
  expect(await older).toBeFalse();
  expect(await stale).toBeFalse();
  expect(await reader.earlier(initialView)).toBeFalse();
  expect(texts(reader)).toEqual(["new branch"]);
  const previous = reader.piView;
  await pull(snap({ leaf: "expired", generation: "fork", items: [row("expired:0", "fresh snapshot")] }));
  expect(reader.piView).not.toBe(previous);
  expect(texts(reader)).toEqual(["fresh snapshot"]);
  const newSession = snap({ session: "replacement", generation: "new", before: 1, items: [row("fresh:0", "new session")] });
  await pull(newSession);
  expect(texts(reader)).toEqual(["new session"]);
  const expired = reader.earlier(reader.piView);
  take("page").reply({ ok: false, error: "stale_revision" });
  expect(await expired).toBeFalse();
  const refresh = reader.pull();
  const call = take("snapshot");
  expect(call.query).toBeUndefined();
  call.reply(newSession);
  expect(await refresh).toBeTrue();
});
