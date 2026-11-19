// Pi runs on the terminal's machine. The client talks only to that machine's private socket.
export const PI_CLIENT = 'exec "$HOME/.local/bin/herdr-pi-chat" "$@"';
export const PI_UNAVAILABLE = "Pi chat integration unavailable. Install the Shepherdr integration, then run /reload in Pi.";
export const PI_BLOCKED = "Answer in terminal";
export const PI_UNCONFIRMED = "Pi did not confirm the send. Check the terminal before sending again.";
const refusals = {
  blocked: "Pi is waiting for an answer. Answer in the terminal before sending again.",
  stale_instance: "Pi restarted before this message could be sent. Check the terminal before writing a new message.",
  stale_session: "Pi switched sessions before this message could be sent. Check the terminal before writing a new message.",
  stale_leaf: "Pi changed branches before this message could be sent. Check the terminal before writing a new message.",
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

export async function piSnapshot(sh, addr, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const r = await sh(PI_CLIENT, ["pi-chat", "snapshot", String(pid)], piMachine(addr));
    const s = JSON.parse(r.stdout);
    if (r.code === 0 && s?.ok && typeof s.instance === "string" && typeof s.session === "string" &&
        ["idle", "working", "blocked", "error"].includes(s.state) && Array.isArray(s.items)) return s;
  } catch {}
  return null;
}

// Capture this at composition time. Never deliver a queued or retried message to a replacement process/session.
export function piTarget(pid, snapshot) {
  return snapshot ? { pid, instance: snapshot.instance, session: snapshot.session, leaf: snapshot.leaf } : null;
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
