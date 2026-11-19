import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters, TextDecoder } from "node:util";

// Keep these wire limits and endpoint names in sync with bin/herdr-pi-chat.
const MAX_FRAME = 128 * 1024;
const MAX_BODY = 32 * 1024;
const pid = process.pid;
const error = (code: string) => ({ ok: false as const, error: code });
const token = (value: unknown): value is string =>
  typeof value === "string" && /^[!-~]{1,256}$/.test(value);

function runtimeDir() {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("Pi bridge requires Unix");
  const path = process.env.SHEPHERDR_PI_RUNTIME_DIR || `/tmp/shepherdr-pi-${uid}`;
  if (!isAbsolute(path) || ["", ".", ".."].includes(basename(path))) throw new Error("Invalid Pi runtime path");
  const parent = realpathSync(dirname(path));
  for (let dir = parent; ; dir = dirname(dir)) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) {
      throw new Error("Unsafe Pi runtime parent");
    }
    if (dir === dirname(dir)) break;
  }
  const dir = join(parent, basename(path));
  if (Buffer.byteLength(join(dir, `${pid}.sock`)) > 103) throw new Error("Pi socket path too long");
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) {
    throw new Error("Pi runtime directory must be owner-only");
  }
  return dir;
}

function unlink(path: string) {
  try { unlinkSync(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

const PAGE_ROWS = 20;
const PAGE_BYTES = 80 * 1024;
const LIVE_BYTES = 32 * 1024;
const RESULT_LIMIT = 10;
const TEXT_CHUNK = 8000;

function cleanText(value: string, limit = value.length) {
  const text = stripVTControlCharacters(value.slice(0, limit))
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\ud800-\udfff]/gu, "\ufffd");
  return value.length > limit ? `${text}\n… (truncated)` : text;
}

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type ChatMessage = Extract<Entry, { type: "message" }>["message"];
type Assistant = Extract<ChatMessage, { role: "assistant" }>;
type Row = { id: string; role: "user" | "assistant" | "custom" | "compaction" | "branch" | "tool" | "result";
  text: string; at: number; part?: number; from?: string };

// Index the raw branch, not Pi's model projection: compaction and context edits must not erase chat.
// Tool output stays in Pi's records. The snapshot carries a call's label, not its arguments or result.
function indexBranch(branch: Entry[]) {
  const rows: Row[] = [];
  const positions = new Map(branch.map((e) => [e.id, 0]));
  const calls = new Map<string, string>();
  const results = new Map<string, Extract<ChatMessage, { role: "toolResult" }>>();
  let failed = false;
  for (const e of branch) {
    const at = Date.parse(e.timestamp) || 0;
    const row = (id: number, role: Row["role"], text: unknown) => {
      if (typeof text !== "string") return;
      const visible = cleanText(text);
      if (!visible.trim()) return;
      const head = { id: `${e.id}:${id}`, role, at };
      if (visible.length <= TEXT_CHUNK) { rows.push({ ...head, text: visible }); return; }
      // One huge message can span pages. The readers join its adjacent pieces back into the same block.
      for (let start = 0, part = 0; start < visible.length; part++) {
        let end = Math.min(visible.length, start + TEXT_CHUNK);
        if (/[\ud800-\udbff]/.test(visible[end - 1])) end--;
        rows.push({ ...head, text: visible.slice(start, end), part });
        start = end;
      }
    };
    const content = (role: Row["role"], parts: unknown) => {
      if (typeof parts === "string") row(0, role, parts);
      else if (Array.isArray(parts)) parts.forEach((p, i) => {
        if (p?.type === "text") row(i, role, p.text);
        else if (role === "assistant" && p?.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
          calls.set(p.id, `${e.id}:${i}`);
          row(i, "tool", p.name.slice(0, 120) || "tool");
        }
      });
    };
    if (e.type === "message") {
      const m = e.message;
      if (m.role === "user" || m.role === "assistant") {
        failed = m.role === "assistant" && m.stopReason === "error";
        content(m.role, m.content);
      } else if (m.role === "toolResult") {
        const id = calls.get(m.toolCallId);
        if (id) { results.set(id, m); row(0, "result", id); }
      }
    } else if (e.type === "custom_message" && e.display === true) content("custom", e.content);
    else if (e.type === "compaction") row(0, "compaction", e.summary);
    else if (e.type === "branch_summary") row(0, "branch", e.summary);
    positions.set(e.id, rows.length);
  }
  return { rows, positions, results, failed };
}

function page(rows: Row[], before: number, floor = 0, max = PAGE_BYTES, aliases?: Map<string, string>) {
  const items: Row[] = [];
  let bytes = 0;
  while (before > floor && items.length < PAGE_ROWS) {
    const row = rows[before - 1];
    const sep = row.id.lastIndexOf(":");
    const alias = row.role === "assistant" && aliases?.get(row.id.slice(0, sep));
    const item = alias ? { ...row, from: `live:${alias}:${row.id.slice(sep + 1)}` } : row;
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > max) break;
    before--;
    bytes += size;
    items.push(item);
  }
  return { before, items: items.reverse() };
}

// A session may never create a file, or use Pi's explicit --session path. A file is only an
// identity check here. Pi owns parsing it, including migrations, partial records and the active leaf.
function fileMark(path: string | undefined, old?: ReturnType<typeof fileStamp>) {
  if (!path) return { stamp: undefined, replaced: Boolean(old) };
  try {
    const stamp = fileStamp(path, old);
    const replaced = !!old && (stamp.identity !== old.identity || stamp.size < old.size ||
      (stamp.size === old.size ? stamp.changed !== old.changed : !stamp.append));
    return { stamp, replaced };
  } catch { return { stamp: undefined, replaced: Boolean(old) }; }
}

function fileStamp(path: string, old?: { identity: string; size: number; changed: bigint; tail: Buffer }) {
  const info = statSync(path, { bigint: true });
  if (!info.isFile()) throw new Error("Not a session file");
  const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  const size = Number(info.size);
  const changed = info.ctimeNs;
  if (old && identity === old.identity && size === old.size && changed === old.changed) return { ...old, append: true };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (`${opened.dev}:${opened.ino}:${opened.birthtimeNs}` !== identity || !opened.isFile()) throw new Error("Session file changed");
    const tail = Buffer.alloc(Math.min(size, 128));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    let append = false;
    if (old && identity === old.identity && size > old.size) {
      const prior = Buffer.alloc(old.tail.length);
      append = readSync(fd, prior, 0, prior.length, old.size - prior.length) === prior.length && prior.equals(old.tail);
    }
    return { identity, size, changed, tail, append };
  } finally { closeSync(fd); }
}

export default function (pi: ExtensionAPI) {
  let stop: (() => Promise<void>) | undefined;
  let blocked = false;
  let revision: (() => void) | undefined;
  let observe: (() => void) | undefined;
  type Stream = { id: string; manager: ExtensionContext["sessionManager"]; session: string; leaf: string | null };
  let live: (Stream & { message: Assistant }) | undefined;
  let ended: Stream[] = [];
  const clearLive = () => { live = undefined; ended = []; };
  const finishLive = () => {
    if (!live) return;
    const { id, manager, session, leaf } = live;
    ended = [...ended.slice(-19), { id, manager, session, leaf }];
    live = undefined;
  };
  pi.on("ui_prompt_start", () => { blocked = true; });
  pi.on("ui_prompt_end", () => { blocked = false; });
  pi.on("session_before_tree", () => { observe?.(); });
  pi.on("session_tree", () => { revision?.(); });
  pi.on("message_start", ({ message }, ctx) => {
    if (message.role !== "assistant") return;
    finishLive();
    live = { id: randomUUID(), manager: ctx.sessionManager,
      session: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId() ?? null, message };
  });
  pi.on("message_update", ({ message }, ctx) => {
    if (message.role !== "assistant") return;
    if (live?.manager === ctx.sessionManager) live.message = message;
    else live = { id: randomUUID(), manager: ctx.sessionManager, session: ctx.sessionManager.getSessionId(),
      leaf: ctx.sessionManager.getLeafId() ?? null, message };
  });
  pi.on("turn_end", finishLive);
  pi.on("agent_end", finishLive);
  pi.on("session_shutdown", async () => { await stop?.(); });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    await stop?.();
    blocked = false;
    const instance = randomUUID();
    const dir = runtimeDir();
    const address = join(dir, `${pid}.sock`);
    const registry = join(dir, `${pid}.json`);
    const temp = join(dir, `${pid}.${instance}.tmp`);
    const sockets = new Set<Socket>();
    const receipts = new Map<string, { digest: string; status: "accepted" | "queued" }>();
    const manager = ctx.sessionManager;
    let generation = randomUUID();
    let lastSession: string | undefined;
    let lastLeaf: string | null = null;
    let lastCount = 0;
    let lastPath: string | undefined;
    let stamp: ReturnType<typeof fileStamp> | undefined;
    let branch: Entry[] = [];
    let index = indexBranch(branch);
    const aliases = new Map<string, string>();
    let refresh = true;
    revision = () => { generation = randomUUID(); refresh = true; clearLive(); aliases.clear(); };
    function current(sample = false) {
      const session = manager.getSessionId();
      const leaf = manager.getLeafId() ?? null;
      const path = manager.getSessionFile?.();
      const first = lastSession === undefined;
      const file = fileMark(path, stamp);
      const changed = !first && (session !== lastSession || lastPath !== path || file.replaced);
      stamp = file.stamp;
      if (changed) revision?.();
      if (refresh || leaf !== lastLeaf) {
        const entries = manager.getEntries();
        branch = manager.getBranch();
        if (!refresh) {
          // Pi can install an existing descendant as its active leaf before session_tree handlers finish.
          // It is an append only if the active suffix consists entirely of newly appended entries.
          const parent = lastLeaf === null ? -1 : branch.findIndex((e) => e.id === lastLeaf);
          const added = entries.slice(lastCount);
          const suffix = branch.slice(parent + 1);
          if ((lastLeaf !== null && parent < 0) || !added.length || suffix.length !== added.length ||
              !added.every((e, i) => e.id === suffix[i].id && e.type !== "branch_summary")) revision?.();
        }
        index = indexBranch(branch);
        lastCount = entries.length;
        refresh = false;
      } else if (sample) lastCount = manager.getEntries().length;
      lastSession = session;
      lastPath = path;
      lastLeaf = leaf;
      // The first assistant record after the stream's base is authoritative. Pi can persist a
      // different object if another message_end handler rewrites the response, so don't compare
      // object identities or text. Keep an alias per entry for rendering its same-index blocks.
      const reconcile = (stream: Stream) => {
        if (stream.manager !== manager || stream.session !== session) return true;
        const from = stream.leaf === null ? 0 : branch.findIndex((e) => e.id === stream.leaf) + 1;
        if (stream.leaf !== null && !from) return true;
        for (let i = from; i < branch.length; i++) {
          const entry = branch[i];
          if (entry.type !== "message") continue;
          if (entry.message.role === "user") return true;
          if (entry.message.role !== "assistant") continue;
          aliases.set(entry.id, stream.id);
          if (aliases.size > 200) aliases.delete(aliases.keys().next().value!);
          return true;
        }
        return false;
      };
      ended = ended.filter((stream) => !reconcile(stream));
      if (live && reconcile(live)) live = undefined;
      return { instance, session, leaf, generation };
    }

    // Sample the old leaf and entry count before Pi installs the navigation target.
    observe = () => { current(true); };

    function dispatch(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return error("invalid_request");
      const request = value as Record<string, unknown>;
      if (request.pid !== pid || request.instance !== instance) return error("stale_instance");
      const identity = current();
      const { session, leaf } = identity;
      if (request.op === "snapshot") {
        const state = blocked ? "blocked" : !ctx.isIdle() ? "working" : !ctx.model || index.failed ? "error" : "idle";
        const floor = request.generation !== generation ? undefined : request.leaf === null ? 0 :
          typeof request.leaf === "string" ? index.positions.get(request.leaf) : undefined;
        const delta = floor === undefined ? undefined : page(index.rows, index.rows.length, floor, PAGE_BYTES, aliases);
        const reset = !delta || delta.before !== floor;
        // An append beyond the bounded delta window expires the cursor. Return a fresh page instead.
        const result = reset ? page(index.rows, index.rows.length, 0, PAGE_BYTES, aliases) : delta;
        let overlay: Row[] = [];
        if (live && live.manager === manager && live.session === session && (state === "working" || state === "blocked")) {
          const { id, message } = live;
          if (Array.isArray(message.content)) {
            const rows = message.content.flatMap((p, i): Row[] => p.type === "text" && p.text.trim() ?
              [{ id: `live:${id}:${i}`, role: "assistant", text: cleanText(p.text, 4000), at: message.timestamp }] : []);
            overlay = page(rows, rows.length, 0, LIVE_BYTES).items;
          }
        } else finishLive();
        return { ok: true, ...identity, state, reset, ...result, live: overlay };
      }
      if (request.op === "page" || request.op === "results") {
        if (request.generation !== generation) return error("stale_revision");
        if (request.op === "page") {
          const before = request.before;
          if (typeof before !== "number" || !Number.isSafeInteger(before) || before < 1 || before > index.rows.length) return error("stale_revision");
          return { ok: true, ...identity, ...page(index.rows, before, 0, PAGE_BYTES, aliases) };
        }
        if (!Array.isArray(request.ids) || request.ids.length > RESULT_LIMIT || !request.ids.every(token)) return error("invalid_request");
        const outputs = request.ids.flatMap((id: string) => {
          const result = index.results.get(id);
          if (!result || !Array.isArray(result.content)) return [];
          const parts: string[] = [];
          let remaining = 1800;
          for (const part of result.content) {
            if (part?.type !== "text" || typeof part.text !== "string") continue;
            parts.push(cleanText(part.text, remaining));
            remaining -= part.text.length + 1;
            if (remaining <= 0) break;
          }
          return [{ id, text: parts.join("\n") }];
        });
        return { ok: true, ...identity, outputs };
      }
      const { id, body, mode } = request;
      if (request.op !== "send" || !token(request.session) || (request.leaf !== null && !token(request.leaf)) ||
          !token(id) || typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY || !body.trim() ||
          /[\x00\ud800-\udfff]/u.test(body) || (mode !== "now" && mode !== "hold")) return error("invalid_request");
      if (request.session !== session) return error("stale_session");
      const digest = createHash("sha256").update(JSON.stringify([session, body])).digest("hex");
      const receipt = receipts.get(id);
      if (receipt) return receipt.digest === digest ? { ok: true, status: receipt.status } : error("id_conflict");
      if (request.generation !== generation) return error("stale_leaf");
      // A normal turn advances the leaf. A held message can follow that branch, not another one.
      if (request.leaf !== null && request.leaf !== leaf && !index.positions.has(request.leaf)) {
        return error("stale_leaf");
      }
      const busy = !ctx.isIdle();
      if ((busy || blocked) && mode === "hold") return { ok: true, status: "waiting" };
      if (blocked) return error("blocked");
      if (!ctx.model) return error("no_model");
      const status = busy ? "queued" : "accepted";
      // Pi's API returns void. This acknowledges submission, not persistence or model success.
      pi.sendUserMessage(body, { deliverAs: mode === "now" ? "steer" : undefined, expandPromptTemplates: false });
      receipts.set(id, { digest, status });
      if (receipts.size > 2048) receipts.delete(receipts.keys().next().value!);
      return { ok: true, status };
    }

    const server = createServer((socket) => {
      sockets.add(socket);
      const chunks: Buffer[] = [];
      let size = 0;
      let replied = false;
      const deadline = setTimeout(() => socket.destroy(), 2500);
      socket.on("close", () => { clearTimeout(deadline); sockets.delete(socket); });
      socket.on("error", () => socket.destroy());
      const reply = (result: object) => {
        if (replied) return;
        replied = true;
        const frame = JSON.stringify(result) + "\n";
        socket.end(Buffer.byteLength(frame) <= MAX_FRAME ? frame : '{"ok":false,"error":"response_too_large"}\n');
      };
      socket.on("data", (chunk: Buffer) => {
        if (replied) return;
        const end = chunk.indexOf(10);
        const part = end < 0 ? chunk : chunk.subarray(0, end);
        size += part.length;
        if (size >= MAX_FRAME) return reply(error("request_too_large"));
        if (part.length) chunks.push(part);
        if (end < 0) return;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
        catch { return reply(error("invalid_json")); }
        try { reply(dispatch(value)); }
        catch { reply(error("pi_error")); }
      });
      socket.on("end", () => reply(error("invalid_request")));
    });
    server.maxConnections = 16;

    // These paths belong to this PID. A crash can leave them behind; publish only after bind.
    unlink(registry);
    unlink(address);
    let listening = false;
    const cleanup = async () => {
      if (stop !== cleanup) return;
      stop = undefined;
      revision = observe = undefined;
      clearLive();
      for (const socket of sockets) socket.destroy();
      try { unlink(registry); }
      finally {
        if (listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        unlink(temp);
      }
    };
    stop = cleanup;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => { listening = true; resolve(); });
      });
      server.on("error", () => { void cleanup().catch(() => {}); });
      server.unref();
      chmodSync(address, 0o600);
      writeFileSync(temp, JSON.stringify({ version: 1, pid, instance }), { mode: 0o600, flag: "wx" });
      renameSync(temp, registry);
    } catch (err) {
      await cleanup();
      throw err;
    }
  });
}
