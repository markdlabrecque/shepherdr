// Pi runs on the terminal's machine. The client talks only to that machine's private socket.
export const PI_CLIENT = 'exec "$HOME/.local/bin/herdr-pi-chat" "$@"';
export const PI_UNAVAILABLE = "Pi chat integration unavailable. Install the Shepherdr integration, then run /reload in Pi.";
export const PI_BLOCKED = "Answer in terminal";
export const PI_UNCONFIRMED = "Pi did not confirm the send. Check the terminal before sending again.";
export const PI_CHAT_CHANGED = "Pi changed conversations. Check the terminal before sending these words again.";
const refusals = {
  blocked: "Pi is waiting for an answer. Answer in the terminal before sending again.",
  stale_instance: "Pi restarted before this message could be sent. Check the terminal before writing a new message.",
  stale_session: "Pi switched sessions before this message could be sent. Check the terminal before writing a new message.",
  stale_leaf: "Pi changed branches before this message could be sent. Check the terminal before writing a new message.",
  stale_view: "Pi could not confirm the open conversation. Your message was not sent.",
  not_available: PI_UNAVAILABLE,
  unsafe_runtime: PI_UNAVAILABLE,
  unsafe_registry: PI_UNAVAILABLE,
  invalid_registry: PI_UNAVAILABLE,
  unsafe_socket: PI_UNAVAILABLE,
  socket_path_too_long: PI_UNAVAILABLE,
  no_model: "Choose a model in the Pi terminal before sending again.",
  invalid_request: "Pi could not read this message.",
  request_too_large: "This message is too long for Pi chat.",
  id_conflict: "Pi already used this message's ID for different words. Write a new message.",
};
export const piMachine = (addr) => addr.includes("/") ? addr.split("/")[0] : null;
export const piRequestId = () => `shep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Match the bridge's cleanText projection when comparing a submission to a stored user row.
// The desktop JS runtime lacks node:util, so use the same VT forms as stripVTControlCharacters.
const VT = /\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)|[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
export const piVisibleBody = (s) => s.replace(VT, "").replace(/\r\n?/g, "\n")
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
  .replace(/[\ud800-\udfff]/gu, "\ufffd");

async function piRead(sh, addr, pid, op, query) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const args = ["pi-chat", op, String(pid)];
    if (query) args.push(JSON.stringify(query));
    const r = await sh(PI_CLIENT, args, piMachine(addr));
    if (r.code === 127) return null; // The helper itself is missing.
    const s = JSON.parse(r.stdout);
    if (s?.error === "stale_revision") return s;
    if (op === "snapshot" && ["timeout", "ipc_error", "not_available"].includes(s?.error)) return { error: "transport" };
    if (r.code === 0 && s?.ok && typeof s.instance === "string" && typeof s.session === "string") return s;
  } catch { if (op === "snapshot") return { error: "transport" }; }
  return null;
}

export async function piSnapshot(sh, addr, pid, cursor, reportFailure = false) {
  const s = await piRead(sh, addr, pid, "snapshot", cursor?.generation ? { generation: cursor.generation, leaf: cursor.leaf } : null);
  if (s?.error) return reportFailure ? s : null;
  return s && ["idle", "working", "blocked", "error"].includes(s.state) && Array.isArray(s.items)
    && (s.leaf === null || typeof s.leaf === "string")
    && (!s.generation || (Number.isSafeInteger(s.before) && s.before >= 0)) ? s : null;
}
export const piPage = (sh, addr, pid, generation, before) => piRead(sh, addr, pid, "page", { generation, before });
export const piResults = (sh, addr, pid, generation, ids) => piRead(sh, addr, pid, "results", { generation, ids });
export const samePiHistory = (a, b) => a && b && a.instance === b.instance && a.session === b.session && a.generation === b.generation;

// A reset can mean the append cursor expired, not that the branch changed. Reuse a loaded
// prefix only if the replacement is contiguous and agrees on any overlapping entry blocks.
export function piCanKeepWindow(current, start, end, rows, next) {
  if (!current?.generation || !samePiHistory(current, next) || next.before > end
      || next.before + next.items.length < end) return false;
  for (let i = Math.max(start, next.before); i < end; i++) {
    const prior = rows[i - start], item = next.items[i - next.before];
    if (prior?.id !== item?.id || prior?.part !== item?.part) return false;
  }
  return true;
}
export const piPageEndsAt = (page, end) => Array.isArray(page?.items) && Number.isSafeInteger(page.before)
  && page.before >= 0 && page.before < end && page.before + page.items.length === end;

// A client can submit this identity, but only the bridge can confirm that it is still active.
export const piHistoryOf = (snapshot) => snapshot ? JSON.stringify([snapshot.instance, snapshot.session, snapshot.generation ?? null,
  snapshot.generation ? null : snapshot.leaf]) : null;
export const piQuoteFor = (quote, snapshot) => quote?.piHistory && quote.piHistory === piHistoryOf(snapshot) ? quote : null;

// Capture this at composition time. Never deliver a queued or retried message to a replacement process/session.
export function piTarget(pid, snapshot) {
  return snapshot ? { pid, instance: snapshot.instance, session: snapshot.session, leaf: snapshot.leaf,
    ...(snapshot.generation ? { generation: snapshot.generation } : {}) } : null;
}

export async function piSend(run, addr, target, id, body, mode = "now") {
  if (!target || !run) return { code: 1, stderr: PI_UNAVAILABLE, noRetry: true };
  const { pid, ...identity } = target;
  try {
    const r = await run(PI_CLIENT, ["pi-chat", "send", String(pid)], piMachine(addr), JSON.stringify({ ...identity, id, body, mode }));
    // sh's exec returns 127 if the installed helper is missing. Do not trust other
    // non-JSON transport failures: the request may have reached the socket.
    if (r.code === 127 && !r.stdout?.trim()) return { code: 1, stderr: PI_UNAVAILABLE, noRetry: true };
    const answer = JSON.parse(r.stdout);
    if (r.code === 0 && answer?.ok === true && ["accepted", "queued", "waiting"].includes(answer.status))
      return { code: 0, stdout: r.stdout, waiting: answer.status === "waiting" };
    if (answer?.ok === false && !answer.ambiguous && Object.hasOwn(refusals, answer.error)) {
      const stderr = refusals[answer.error];
      return { code: 1, stderr, noRetry: answer.error.startsWith("stale_") || stderr === PI_UNAVAILABLE || answer.error === "id_conflict" };
    }
  } catch {}
  return { code: 1, stderr: PI_UNCONFIRMED, ambiguous: true, noRetry: true };
}
