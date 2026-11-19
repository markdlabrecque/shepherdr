// A real Pi provider with no network or account credentials. Reply to the last user turn.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export default function (pi: ExtensionAPI) {
  // The PTY test holds a manual compact at the seam before Pi asks the summarizer.
  pi.on("session_before_compact", async (event, ctx) => {
    const gate = join(ctx.cwd, "fixture-hold-compaction");
    if (event.reason !== "manual" || !existsSync(gate)) return;
    ctx.ui.notify("Fixture compaction held");
    while (existsSync(gate)) await setTimeout(20, undefined, { signal: event.signal });
    const { firstKeptEntryId, tokensBefore } = event.preparation;
    return { compaction: { summary: "Fixture compaction summary", firstKeptEntryId, tokensBefore } };
  });
  pi.registerProvider("shepherdr-test", {
    api: "shepherdr-test-echo",
    apiKey: "unused-local-placeholder",
    baseUrl: "http://127.0.0.1:1", // Required metadata; streamSimple never makes a request.
    models: [{ id: "echo", name: "Fixture Echo", reasoning: false, input: ["text"], cost,
      contextWindow: 8192, maxTokens: 1024 }],
    streamSimple(model, context) {
      const user = context.messages.findLast((message) => message.role === "user");
      const input = typeof user?.content === "string" ? user.content :
        user?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      const text = `Fixture echo: [${input}]`;
      const partial: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider,
        model: model.id, content: [], usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      const empty: AssistantMessage = { ...partial, content: [{ type: "text", text: "" }] };
      const message: AssistantMessage = { ...partial, content: [{ type: "text", text }] };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial: empty });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
}
