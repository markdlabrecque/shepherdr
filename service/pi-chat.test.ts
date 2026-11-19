import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "./actions.ts";
import { Chats } from "./chats.ts";
import { Compat } from "./compat.ts";
import type { Hub } from "./hub.ts";
import { failedOf, forgetAll } from "./send-once.ts";
import { PI_BLOCKED, PI_UNAVAILABLE, PI_UNCONFIRMED } from "../core/pi-chat.js";

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

function remote(read: () => unknown = () => snap, send: (request: any) => unknown = () => ({ ok: true, status: "accepted" })) {
  const calls: any[] = [];
  const requests: any[] = [];
  const h = {
    terminals: new Map([[addr, live]]),
    on() {},
    async core() { throw new Error("no watch stream in this test"); },
    async call(method: string, p: any) {
      calls.push({ method, ...p });
      const op = p.argv.at(-2);
      if (op === "snapshot") return out(read());
      if (op !== "send") throw new Error(`Unexpected call: ${method} ${op}`);
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
    const message = { type: "send", chat: `t:${addr}`, text: "/literal\n你好", cid: "pi-remote-1", human: true };
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

test("held Pi send keeps its identity across polls and is not retried after a lost receipt", async () => {
  let sends = 0;
  const { h, compat, requests, notes } = remote(() => snap, () => ++sends === 1 ? { ok: true, status: "waiting" } : null);
  const message = { type: "send", chat: `t:${addr}`, cid: "pi-held", text: "after the turn", hold: true, pi: true };
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
    const message = { type: "send", chat: `t:${addr}`, cid: `pi-${error}`, text: "hi" };
    await expect(act(h, message, compat)).rejects.toThrow(expected);
    expect(requests).toHaveLength(1);
    expect(notes).toEqual([]);
  }
});
