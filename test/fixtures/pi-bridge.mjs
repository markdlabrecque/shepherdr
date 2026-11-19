import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import bridge from "../../integrations/pi/shepherdr.ts";

const events = new EventEmitter();
const message = (id, role, content, stopReason = "stop") => ({
  type: "message", id, timestamp: "2025-06-01T12:00:00.123Z", message: { role, content, stopReason, timestamp: 1 },
});
let branch = [
  message("system", "system", "system secret"),
  message("user-1", "user", [{ type: "text", text: "hello\r\nworld\x00" }, { type: "image", data: "image secret" }]),
  message("assistant-1", "assistant", [
    { type: "thinking", thinking: "thinking secret" },
    { type: "toolCall", arguments: { secret: "tool secret" } },
    { type: "text", text: "\x1b[32mreply\x1b[0m\u202e!" },
  ]),
  message("tool-1", "toolResult", "tool result secret"),
];
let idle = true;
let leaf = "tool-1";
let session = "pi-session";
const sends = [];
const ctx = {
  mode: "tui", model: {}, isIdle: () => idle,
  sessionManager: {
    getSessionId: () => session, getLeafId: () => leaf,
    getBranch: () => branch,
  },
};
const sendUserMessage = (body, options) => {
  sends.push({ body, options });
  if (idle) {
    idle = false;
    leaf = `sent-${sends.length}`;
    branch.push(message(leaf, "user", body));
  }
};
const emit = async (name) => {
  for (const handler of events.listeners(name)) await handler({}, ctx);
};
bridge({ on: events.on.bind(events), sendUserMessage });
await emit("session_start");
console.log(process.pid);
for await (const line of createInterface({ input: process.stdin })) {
  const { action, value } = JSON.parse(line);
  if (action === "idle") idle = value;
  if (action === "leaf") leaf = value;
  if (action === "advance" || action === "fork") {
    if (action === "fork") branch = branch.slice(0, 2);
    leaf = value;
    branch.push(message(leaf, "assistant", `reply at ${leaf}`));
  }
  if (action === "session") session = value;
  if (action === "blocked") await emit(value ? "ui_prompt_start" : "ui_prompt_end");
  if (action === "error") branch.push(message("error", "assistant", [], "error"));
  if (action === "large") branch = Array.from({ length: 45 }, (_, i) => message(`msg-${i}`, "assistant", "界".repeat(3000)));
  if (action === "shutdown" || action === "reload") await emit("session_shutdown");
  if (action === "reload") await emit("session_start");
  console.log(JSON.stringify(sends));
}
await emit("session_shutdown");
