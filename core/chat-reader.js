// Following an agent's conversation from its own session log, as the window's chat does (mods/chat: find the
// log, read the newest page, then what it gains; earlier pages when asked; keep at most KEEP records):
// the service uses it for the web app. io.sh(script, args, machine) -> Promise<{ code, stdout }> runs a shell
// script on the agent's machine (null: here).
// Shared core: the source is core/chat-reader.js.

import { FIND, LOG, Conversation, records, resultText, piConversation } from "./chat-log.js";
import { piSnapshot, piPage, piResults, samePiHistory, piCanKeepWindow, piPageEndsAt } from "./pi-chat.js";
import { BgJobs } from "./bg-jobs.js";

export const PAGE = 200;
export const KEEP = 2000;
export const KINDS = { "claude-code": "claude", claude: "claude", codex: "codex", pi: "pi" };

// A Node-launched Pi can report "node" as its foreground name before there is an app status.
export const kindOf = (t) => KINDS[t?.status?.app] ?? KINDS[t?.foreground?.name]
  ?? (String(t?.foreground?.argv?.[0] ?? "").split("/").pop() === "pi" ? "pi" : null);

export class ChatReader {
  constructor(io, addr) {
    this.io = io;
    this.addr = addr;
    this.machine = addr.includes("/") ? addr.split("/")[0] : null;
    this.reset();
  }

  reset() {
    this.pinned = false;
    this.path = null;
    this.kind = null;
    this.pid = null;
    this.pi = null;
    this.piVersion = null;
    this.piItems = [];
    this.piEnd = null;
    this.piView = null;
    this.piFresh = true;
    this.piOffline = false;
    this.piGap = null;
    this.piBarrier = {};
    this.piReadSeq = 0;
    this.start = null;   // the first byte read (0: the log's very start)
    this.end = 0;
    this.records = [];
    this.conv = null;
    this.bg = new BgJobs(); // what it left running in the background
    this.state = "finding"; // finding | pending (no log yet) | ready | none (not a chat agent) | missing
  }

  log(args) { return this.io.sh(LOG, ["log", ...args], this.machine); }

  // An ended agent's own log (a finished task's last agent, as the Tasks panel opens it): read as it is, never
  // looked for again. -> this reader.
  fixed(path, kind) {
    this.reset();
    this.path = path;
    this.kind = kind;
    this.pinned = true;
    return this;
  }

  // Finds the log of the agent this terminal runs now (t: its herdr-core record). -> true when it changed.
  async locate(t) {
    if (this.pinned) return false;
    const kind = kindOf(t);
    const pid = t?.foreground?.pid;
    if (kind === "pi" && t?.state !== "ended") {
      if (this.kind === "pi" && this.pid === pid) return false;
      this.reset();
      this.kind = kind;
      this.pid = pid;
      return true;
    }
    if (!kind || !pid || kind === "pi") { const was = this.state; if (was !== "none") { this.reset(); this.state = "none"; } return was !== "none"; }
    if (this.path && this.kind === kind && this.pid === pid) return false;
    const f = await this.io.sh(FIND, ["chat", kind, String(pid)], this.machine);
    const path = String(f.stdout ?? "").trim().split("\n").pop() ?? "";
    if (path === "pending" || !path) {
      const was = this.state;
      this.reset();
      this.kind = kind;
      this.pid = pid;
      this.state = path === "pending" ? "pending" : "none";
      if (this.state === "pending") { this.conv = new Conversation(kind); this.start = 0; }
      return was !== this.state;
    }
    if (path === this.path && kind === this.kind) { this.pid = pid; return false; }
    this.reset();
    this.path = path;
    this.kind = kind;
    this.pid = pid;
    return true;
  }

  // ---- what it left running in the background (core/bg-jobs.js) ----

  run(script, args) { return this.io.sh(script, args, this.machine); }

  // A look at the agent's processes when one is due. -> true when what shows changed.
  async lookJobs() {
    if (this.pinned || !this.pid || !this.conv || !this.bg.due(this.kind, this.conv)) return false;
    return this.bg.look((s, a) => this.run(s, a), this.kind, this.pid, this.conv);
  }

  // Its shells and watchers now (none for a log read as it is).
  jobs() { return this.pinned || !this.conv ? [] : this.bg.list(this.kind, this.conv); }

  // One of them stopped. -> false when it's gone already.
  async stopJob(id) {
    const job = this.jobs().find((j) => j.id === id);
    return job ? this.bg.stop((s, a) => this.run(s, a), this.kind, this.pid, job) : false;
  }

  // What one of them printed last (Claude Code's), or null.
  async jobOutput(id) {
    const job = this.jobs().find((j) => j.id === id);
    return job ? this.bg.output((s, a) => this.run(s, a), job) : null;
  }

  rebuild() {
    this.conv = new Conversation(this.kind);
    this.conv.feed(this.records);
  }

  refreshPi() {
    this.piFresh = true;
    this.piOffline = false;
    this.piGap = null;
    this.piBarrier = {};
  }

  rebuildPi() {
    const live = this.pi.state === "working" || this.pi.state === "blocked" ? this.pi.live ?? [] : [];
    this.conv = piConversation([...this.piItems, ...live.map((x) => ({ ...x, provisional: true }))], this.pi);
  }

  piAnchor(id) {
    const final = id && this.conv?.items.find((x) => x.renderId && (x.renderId === id || id.startsWith(`${x.renderId}:`)));
    return final ? final.id + id.slice(final.renderId.length) : id;
  }

  // A page/result can discover navigation before the next poll does. Fence all in-flight
  // requests, including snapshots taken before that reply, and revalidate from scratch.
  acceptsPiReply(reply, barrier) {
    if (barrier !== this.piBarrier || !reply) return false;
    if (samePiHistory(this.pi, reply)) return true;
    this.refreshPi();
    return false;
  }

  async pullPi() {
    const barrier = this.piBarrier, seq = ++this.piReadSeq;
    const current = () => this.piBarrier === barrier && this.piReadSeq === seq;
    const previous = this.piFresh ? null : this.pi;
    const validDelta = (s) => samePiHistory(previous, s) && s.before === this.piEnd;
    let next = await piSnapshot(this.io.sh, this.addr, this.pid, previous, true);
    if (!current()) return false;
    if (next?.error === "transport" && this.pi) {
      if (this.piOffline) return false;
      // Leave verified rows and their scroll identity in place, but discard provisional text
      // and stop side reads. Reconnect with a full snapshot before admitting any new data.
      this.refreshPi();
      this.piOffline = true;
      this.pi = { ...this.pi, live: [] };
      this.rebuildPi();
      return true;
    }
    if (previous && (next?.error === "stale_revision" || (next?.reset === false && !validDelta(next)))) {
      this.refreshPi();
      return this.pullPi();
    }
    if (next?.error || (next?.generation && next.reset === false && !previous)) next = null;
    if (!next) {
      if (this.state === "unavailable") return false;
      this.refreshPi();
      this.pi = this.piView = this.piVersion = this.piEnd = this.start = this.conv = null;
      this.piItems = [];
      this.state = "unavailable";
      return true;
    }
    const snapshot = !next.generation || next.reset !== false;
    if (snapshot && this.piItems.length && next.generation && samePiHistory(this.pi, next) && next.before > this.piEnd) {
      // Page backwards from a fixed target, even if the tail keeps growing. Bound the work
      // per poll without throwing away the anchor or repeatedly copying the backlog.
      const gap = this.piGap ?? { target: next, before: next.before, pages: [] };
      for (let remaining = 2; remaining > 0 && gap.before > this.piEnd; remaining--) {
        const page = await piPage(this.io.sh, this.addr, this.pid, next.generation, gap.before);
        if (!current() || (page && !this.acceptsPiReply(page, barrier))) return false;
        if (!piPageEndsAt(page, gap.before)) break;
        gap.pages.push(page.items);
        gap.before = page.before;
      }
      if (gap.before > this.piEnd) {
        this.piGap = gap;
        // Only the state is current while a gap separates these rows from the live tail.
        const changed = this.piFresh || this.pi.state !== next.state || !!this.pi.live?.length;
        this.pi = { ...this.pi, state: next.state, live: [] };
        this.piFresh = this.piOffline = false;
        if (changed) this.rebuildPi();
        return changed;
      }
      next = { ...gap.target, before: gap.before, items: [...gap.pages.reverse().flat(), ...gap.target.items],
        state: next.state, live: gap.target.leaf === next.leaf ? next.live : [] };
    }
    this.piGap = null;
    const version = JSON.stringify([next.instance, next.session, next.leaf, next.generation, next.state, next.live]);
    if (next.generation) {
      if (!snapshot && !next.items.length && version === this.piVersion) return false;
    } else if (JSON.stringify(next) === this.piVersion && !this.piFresh) return false;
    if (snapshot) {
      const keep = piCanKeepWindow(this.pi, this.start, this.piEnd, this.piItems, next);
      if (keep) {
        const prefix = this.piItems.slice(0, Math.max(0, next.before - this.start));
        this.piItems = [...prefix, ...next.items];
        this.start = next.before - prefix.length;
      } else {
        this.piBarrier = {};
        this.piView = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.piItems = next.items;
        this.start = next.before ?? null;
      }
    } else if (next.items.length) this.piItems.push(...next.items);
    this.piEnd = next.generation ? next.before + next.items.length : null;
    this.piFresh = this.piOffline = false;
    this.piVersion = next.generation ? version : JSON.stringify(next);
    this.pi = next;
    this.state = "ready";
    this.rebuildPi();
    return true;
  }

  // The newest page first; after that, what the log gained since. -> true when there's something new.
  async pull() {
    if (this.kind === "pi" && !this.pinned) return this.pullPi();
    if (!this.path) return false;
    const path = this.path;
    if (this.start === null) {
      const r = await this.log(["page", path, "999999999999999", String(PAGE)]);
      if (path !== this.path) return false;
      if (String(r.stdout).startsWith("missing")) { this.path = null; this.state = "missing"; return true; }
      const { head, records: recs } = records(r.stdout);
      if (head[0] !== "P") return false;
      this.start = Number(head[1]);
      this.end = Number(head[2]);
      this.records = recs;
      this.rebuild();
      this.state = "ready";
      return true;
    }
    const r = await this.log(["tail", path, String(this.end)]);
    if (path !== this.path) return false;
    if (String(r.stdout).startsWith("missing")) { this.path = null; this.state = "missing"; return true; }
    const { head, records: recs } = records(r.stdout);
    if (head[0] !== "T") return false;
    // Shorter than what was read: the file was replaced. Start over from its end.
    if (Number(head[2]) < this.end) { const p = this.path, k = this.kind, pid = this.pid; this.reset(); Object.assign(this, { path: p, kind: k, pid }); return this.pull(); }
    this.end = Number(head[3]);
    if (!recs.length) return false;
    this.records.push(...recs);
    if (this.records.length > KEEP) {
      // Down to three quarters, so the rebuild is now and then, not on every message.
      this.records = this.records.slice(-Math.floor(KEEP * 0.75));
      this.start = this.records[0].off;
      this.rebuild();
    } else this.conv.feed(recs);
    return true;
  }

  // What a tools row's calls printed, read from the log only when the row opens (as the window's chat
  // loadResults()): -> Map step id -> its first lines ("" when none).
  async results(steps) {
    const out = new Map();
    const want = (steps ?? []).filter((s) => s.out !== undefined);
    if (!want.length) return out;
    if (this.kind === "pi" && this.pi?.generation) {
      if (this.piFresh) return out;
      const { generation } = this.pi, barrier = this.piBarrier;
      const ids = [...new Set(want.map((s) => s.out))].slice(0, 10);
      const r = await piResults(this.io.sh, this.addr, this.pid, generation, ids);
      if (!this.acceptsPiReply(r, barrier) || !Array.isArray(r.outputs)) return out;
      for (const x of r.outputs) for (const s of want) if (x.id === s.out) out.set(s.id, x.text);
      return out;
    }
    if (!this.path) return out;
    const offs = [...new Set(want.map((s) => s.out))].slice(0, 40);
    const r = await this.log(["results", this.path, ...offs.map(String)]);
    for (const part of String(r.stdout ?? "").split("\x1e").slice(1)) {
      const nl = part.indexOf("\n");
      const off = Number(part.slice(0, nl));
      const line = part.slice(nl + 1).replace(/\n$/, "");
      for (const s of want) if (s.out === off) out.set(s.id, resultText(line, s.id) ?? "");
    }
    return out;
  }

  // The page before what is read. -> true when there was one.
  /** @param {string} [view] */
  async earlier(view) {
    if (this.kind === "pi" && !this.pinned) {
      if (this.piFresh || !this.start || !this.pi?.generation || (view !== undefined && view !== this.piView)) return false;
      const { generation } = this.pi, before = this.start, barrier = this.piBarrier;
      const r = await piPage(this.io.sh, this.addr, this.pid, generation, before);
      if (!this.acceptsPiReply(r, barrier) || this.start !== before) return false;
      if (!piPageEndsAt(r, before)) return false;
      this.start = r.before;
      this.piItems = [...r.items, ...this.piItems];
      this.rebuildPi();
      return true;
    }
    if (!this.start || !this.path) return false;
    const path = this.path, before = this.start;
    const r = await this.log(["page", path, String(before), String(PAGE)]);
    const { head, records: recs } = records(r.stdout);
    if (path !== this.path || this.start !== before || head[0] !== "P") return false;
    this.start = Number(head[1]);
    this.records = [...recs, ...this.records];
    this.rebuild();
    return true;
  }
}
