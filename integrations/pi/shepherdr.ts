import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

function cleanText(value: string) {
  return stripVTControlCharacters(value.slice(0, 3600))
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function transcript(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  const items: { id: string; role: "user" | "assistant"; text: string; at: number }[] = [];
  let failed: boolean | undefined;
  for (let i = branch.length - 1; i >= 0 && i >= branch.length - 512 && items.length < 20; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || !token(entry.id)) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    failed ??= entry.message.role === "assistant" && entry.message.stopReason === "error";
    let text = "";
    if (typeof content === "string") {
      text = cleanText(content);
    } else {
      for (const part of content.slice(0, 128)) {
        if (part.type !== "text") continue;
        text += (text ? "\n" : "") + cleanText(part.text);
        if (text.length >= 1800) break;
      }
    }
    text = text.slice(0, 1800).replace(/[\ud800-\udfff]/gu, "\ufffd").trim();
    if (text) items.push({ id: entry.id, role, text, at: Date.parse(entry.timestamp) || entry.message.timestamp || 0 });
  }
  return { items: items.reverse(), failed };
}

export default function (pi: ExtensionAPI) {
  let stop: (() => Promise<void>) | undefined;
  let blocked = false;
  pi.on("ui_prompt_start", () => { blocked = true; });
  pi.on("ui_prompt_end", () => { blocked = false; });
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

    function dispatch(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return error("invalid_request");
      const request = value as Record<string, unknown>;
      if (request.pid !== pid || request.instance !== instance) return error("stale_instance");
      const session = ctx.sessionManager.getSessionId();
      const leaf = ctx.sessionManager.getLeafId() ?? null;
      if (request.op === "snapshot") {
        const { items, failed } = transcript(ctx);
        const state = blocked ? "blocked" : !ctx.isIdle() ? "working" : !ctx.model || failed ? "error" : "idle";
        return { ok: true, instance, session, leaf, state, items };
      }
      const { id, body, mode } = request;
      if (request.op !== "send" || !token(request.session) || (request.leaf !== null && !token(request.leaf)) ||
          !token(id) || typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY || !body.trim() ||
          /[\x00\ud800-\udfff]/u.test(body) || (mode !== "now" && mode !== "hold")) return error("invalid_request");
      if (request.session !== session) return error("stale_session");
      const digest = createHash("sha256").update(body).digest("hex");
      const receipt = receipts.get(id);
      if (receipt) return receipt.digest === digest ? { ok: true, status: receipt.status } : error("id_conflict");
      // A normal turn advances the leaf. A held message can follow that branch, not another one.
      if (request.leaf !== null && request.leaf !== leaf && !ctx.sessionManager.getBranch().some((entry) => entry.id === request.leaf)) {
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
