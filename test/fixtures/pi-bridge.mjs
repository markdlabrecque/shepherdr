import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import bridge from "../../integrations/pi/shepherdr.ts";

const events = new EventEmitter();
const timestamp = "2025-06-01T12:00:00.123Z";
const message = (id, role, content, extra) => ({ type: "message", id, timestamp,
  message: { role, content, stopReason: "stop", timestamp: Date.parse(timestamp), ...extra } });
const tool = (id, name) => ({ type: "toolCall", id, name, arguments: { secret: "tool argument secret" } });
const text = (text) => ({ type: "text", text });
const other = (id, type, value) => ({ id, type, timestamp, ...value });
let entries = new Map();
let leaf = null;
let file;
const append = (entry, parentId = leaf) => {
  entry.parentId = parentId;
  entries.set(entry.id, entry);
  leaf = entry.id;
  if (file) appendFileSync(file, JSON.stringify(entry) + "\n");
};
const branch = () => {
  const result = [];
  for (let id = leaf; id && entries.has(id); id = entries.get(id).parentId) result.push(entries.get(id));
  return result.reverse();
};
append(message("system", "system", "system secret"));
append(message("user-1", "user", [text("hello\r\nworld\x00"), { type: "image", data: "image secret" }]));
append(message("assistant-1", "assistant", [
  { type: "thinking", thinking: "thinking secret" },
  { type: "unknown", text: "block secret" },
  text("\x1b[32mreply\x1b[0m\u202e!"),
]));
append(message("tool-1", "toolResult", [text("unpaired result secret")], { toolCallId: "unknown" }));
let idle = true;
let session = "pi-session";
let live;
const sends = [];
const ctx = {
  mode: "tui", model: {}, isIdle: () => idle,
  sessionManager: {
    getSessionId: () => session, getLeafId: () => leaf, getLeafEntry: () => entries.get(leaf), getSessionFile: () => file,
    getBranch: branch, getEntries: () => [...entries.values()],
  },
};
const sendUserMessage = (body, options) => {
  sends.push({ body, options });
  if (idle) {
    idle = false;
    append(message(`sent-${sends.length}`, "user", body));
  }
};
const emit = async (name, data = {}) => {
  for (const handler of events.listeners(name)) await handler(data, ctx);
};
bridge({ on: events.on.bind(events), sendUserMessage });
await emit("session_start");
console.log(process.pid);
for await (const line of createInterface({ input: process.stdin })) {
  const { action, value } = JSON.parse(line);
  if (action === "idle") {
    idle = value;
    await emit(idle ? "agent_settled" : "agent_start");
  }
  if (action === "run-ended") await emit("agent_end");
  if (action === "turn-ended") await emit("turn_end");
  if (action === "leaf" || action === "tree") leaf = value;
  if (action === "tree") await emit("session_tree");
  if (action === "tree-start") await emit("session_before_tree");
  if (action === "advance" || action === "fork") append(message(value, "assistant", [text(`reply at ${value}`)]), action === "fork" ? "user-1" : leaf);
  if (action === "root") append(message(value, "user", `root ${value}`), null);
  if (action === "session") session = value;
  if (action === "blocked") await emit(value ? "ui_prompt_start" : "ui_prompt_end");
  if (action === "error") append(message("error", "assistant", [], { stopReason: "error", errorMessage: "private error" }));
  if (action === "large") {
    entries = new Map(); leaf = null;
    for (let i = 0; i < value; i++) append(message(`msg-${i}`, "assistant", [text(`record ${i}`)]));
  }
  if (action === "wide") {
    for (let i = 0; i < 45; i++) append(message(`wide-${i}`, "assistant", [text("界".repeat(3000))]));
  }
  if (action === "long") append(message("long", "assistant", [text("x".repeat(7999) + "🌱" + "界".repeat(50_000))]));
  if (action === "custom") {
    append(other("hidden", "custom_message", { display: false, content: "hidden custom secret" }));
    append(other("public", "custom_message", { display: true, content: [text("visible extension note")], details: "details secret" }));
    append(other("book", "context_edit", { targetId: "assistant-1", replacement: { content: [text("projection secret")] } }));
    append(other("unknown", "future_entry", { content: "unknown secret" }));
  }
  if (action === "compact") append(other("compact", "compaction", { summary: "what happened before compaction", firstKeptEntryId: leaf }));
  if (action === "branch-summary") append(other("branch-summary", "branch_summary", { summary: "why this branch exists" }));
  if (action === "stream" || action === "new-stream") {
    if (action === "new-stream") live = undefined;
    if (idle) {
      idle = false;
      await emit("agent_start");
    }
    const event = live ? "message_update" : "message_start";
    live = message("provisional", "assistant", [{ type: "thinking", thinking: "live secret" }, text(value)]).message;
    await emit(event, { message: live });
  }
  if (action === "final") {
    const record = message("final", "assistant", [{ type: "thinking", thinking: "final secret" }, text(value)]);
    // Another extension handed the hook a replacement object, but Pi writes the original
    // object with the replacement content. No turn_end arrives yet (a tool could still run).
    await emit("message_end", { message: structuredClone(record.message) });
    append(record);
    live = undefined;
  }
  if (action === "tool-calls") append(message("calls", "assistant", [tool("a", "read"), tool("b", "extension_tool")], { stopReason: "toolUse" }));
  if (action === "tool-result") append(message(`result-${value}`, "toolResult",
    [text(`output-${value}`), { type: "image", data: "result image secret" }], { toolCallId: value, details: "result details secret" }));
  if (action === "file") {
    file = value;
    writeFileSync(file, [...entries.values()].map((e) => JSON.stringify(e) + "\n").join(""));
  }
  if (action === "partial") appendFileSync(file, '{"type":"message","message":{"role":"user","content":"partial secret');
  if (action === "replace-file") {
    writeFileSync(`${file}.tmp`, readFileSync(file));
    renameSync(`${file}.tmp`, file);
  }
  if (action === "rewrite-file") writeFileSync(file, readFileSync(file, "utf8").replace("reply", "other"));
  if (action === "truncate-file") truncateSync(file, 5);
  if (action === "replace-leaf-entry") {
    const prior = entries.get(leaf);
    entries.set(leaf, { ...prior, message: { ...prior.message, content: [text(value)] } });
  }
  if (action === "shutdown" || action === "reload") await emit("session_shutdown");
  if (action === "reload") await emit("session_start");
  console.log(JSON.stringify(sends));
}
await emit("session_shutdown");
