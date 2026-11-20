"""The executable and Pi extension talk over real sockets in a private scratch registry.

With Pi 1.5.2 and its Node runtime on PATH, also exercise real interactive Pi:
SHEPHERDR_TEST_PI=1 python3 -m unittest discover -s test -p test_pi_bridge.py
"""
import home_guard  # noqa: F401
from concurrent.futures import ThreadPoolExecutor
import json
import os
import select
import shutil
import socket
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "bin/herdr-pi-chat"
FIXTURE = ROOT / "test/fixtures/pi-bridge.mjs"


class Scratch(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="shep-pi-", dir="/tmp")
        self.addCleanup(scratch.cleanup)
        self.runtime = Path(scratch.name) / "runtime"
        self.env = {**os.environ, "SHEPHERDR_PI_RUNTIME_DIR": str(self.runtime)}
        self.pid = os.getpid()

    def cli(self, op, fields=None, pid=None):
        args = [CLIENT, op, str(self.pid if pid is None else pid)]
        if isinstance(fields, dict):
            fields = json.dumps(fields)
            if op == "send":
                fields = fields.encode()
            else:
                args.append(fields)
                fields = None
        result = subprocess.run(args, input=fields or b"",
                                env=self.env, capture_output=True, timeout=5)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        self.assertLessEqual(len(result.stdout), 128 * 1024)
        data = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if data["ok"] else 1)
        return data


class Client(Scratch):
    def test_typed_errors(self):
        self.assertEqual(self.cli("snapshot", pid="-1"), {"ok": False, "error": "usage"})
        self.assertEqual(self.cli("snapshot"), {"ok": False, "error": "not_available"})
        self.assertEqual(self.cli("send", b"not json"), {"ok": False, "error": "invalid_request"})
        self.assertEqual(self.cli("send", b"x" * (128 * 1024 + 1)), {"ok": False, "error": "request_too_large"})

    def test_refuses_unsafe_registry_and_socket(self):
        self.runtime.mkdir(mode=0o755)
        self.runtime.chmod(0o755)
        self.assertEqual(self.cli("snapshot")["error"], "unsafe_runtime")
        self.runtime.chmod(0o700)
        registry = self.runtime / f"{self.pid}.json"
        record = self.runtime / "other"
        record.touch(mode=0o600)
        registry.symlink_to(record)
        self.assertEqual(self.cli("snapshot")["error"], "unsafe_registry")
        registry.unlink()
        registry.write_text(json.dumps({"version": 1, "pid": self.pid + 1, "instance": "test"}))
        registry.chmod(0o600)
        self.assertEqual(self.cli("snapshot")["error"], "invalid_registry")
        registry.write_text(json.dumps({"version": 1, "pid": self.pid, "instance": "test"}))
        (self.runtime / f"{self.pid}.sock").symlink_to(record)
        self.assertEqual(self.cli("snapshot")["error"], "unsafe_socket")

    def test_send_without_acknowledgement_is_ambiguous(self):
        self.runtime.mkdir(mode=0o700)
        record = self.runtime / f"{self.pid}.json"
        record.write_text(json.dumps({"version": 1, "pid": self.pid, "instance": "test"}))
        record.chmod(0o600)
        fields = dict(instance="test", session="s", leaf=None, id="m", body="message", mode="now")
        address = self.runtime / f"{self.pid}.sock"
        for response in (b"", b"invalid\n", b'{"ok":true,"status":"unknown"}\n', b'{"ok":false,"error":"pi_error"}\n'):
            with self.subTest(response=response), socket.socket(socket.AF_UNIX) as server:
                server.bind(str(address))
                address.chmod(0o600)
                server.listen()
                server.settimeout(5)
                try:
                    with ThreadPoolExecutor() as pool:
                        result = pool.submit(self.cli, "send", fields)
                        conn, _ = server.accept()
                        with conn, conn.makefile("rb") as stream:
                            self.assertEqual(json.loads(stream.readline())["body"], "message")
                            if response:
                                conn.sendall(response)
                        self.assertEqual(result.result(), {"ok": False, "error": "unconfirmed", "ambiguous": True})
                finally:
                    address.unlink()
        self.assertEqual(self.cli("send", fields), {"ok": False, "error": "not_available"})

    def test_socket_path_limit(self):
        self.env["SHEPHERDR_PI_RUNTIME_DIR"] = str(self.runtime.with_name("x" * 103))
        self.assertEqual(self.cli("snapshot")["error"], "socket_path_too_long")


def js_host():
    node = shutil.which("node")
    if node:
        version = subprocess.check_output([node, "--version"], text=True).strip().lstrip("v").split(".")
        if tuple(map(int, version[:2])) >= (22, 6):
            return [node, "--disable-warning=ExperimentalWarning", "--experimental-strip-types"]
    bun = shutil.which("bun")
    return [bun] if bun else None


class Bridge(Scratch):
    def setUp(self):
        super().setUp()
        host = js_host()
        if not host:
            self.skipTest("Node 22.6+ or Bun is needed for the synthetic Pi host")
        self.host = subprocess.Popen([*host, str(FIXTURE)], env=self.env, text=True,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.addCleanup(self.stop_host)
        self.pid = int(self.host_line())
        self.address = self.runtime / f"{self.pid}.sock"
        self.registry = self.runtime / f"{self.pid}.json"

    def stop_host(self):
        self.host.stdin.close()
        try:
            self.host.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.host.kill()
            self.host.wait(timeout=3)
        finally:
            self.host.stdout.close()

    def host_line(self):
        self.assertTrue(select.select([self.host.stdout], [], [], 3)[0], "synthetic Pi did not respond")
        return self.host.stdout.readline()

    def control(self, action, value=None):
        self.host.stdin.write(json.dumps({"action": action, "value": value}) + "\n")
        self.host.stdin.flush()
        return json.loads(self.host_line())

    def fields(self, **changes):
        snap = self.cli("snapshot")
        return {**{key: snap[key] for key in ("instance", "session", "leaf", "generation") if key in snap},
                "mode": "now", "id": "first", "body": "hello", **changes}

    def raw(self, frame):
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(3)
            conn.connect(str(self.address))
            conn.sendall(frame)
            with conn.makefile("rb") as stream:
                return json.loads(stream.readline(128 * 1024))

    def test_private_snapshot_and_limits(self):
        for path, mode in ((self.runtime, 0o700), (self.registry, 0o600), (self.address, 0o600)):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)
        snap = self.cli("snapshot")
        self.assertEqual(snap["items"], [{"id": "user-1:0", "role": "user", "text": "hello\nworld", "at": 1748779200123},
                                         {"id": "assistant-1:2", "role": "assistant", "text": "reply!", "at": 1748779200123}])
        self.assertEqual((snap["state"], snap["leaf"]), ("idle", "tool-1"))
        self.control("leaf", None)
        self.assertIsNone(self.cli("snapshot")["leaf"])
        self.control("wide")
        snap = self.cli("snapshot")
        items = snap["items"]
        self.assertGreater(snap["before"], 0)
        self.assertEqual(items[-1]["id"], "wide-44:0")
        self.assertEqual({len(item["text"]) for item in items}, {3000})
        self.control("error")
        self.assertEqual(self.cli("snapshot")["state"], "error")

    def test_held_and_steering_delivery(self):
        now = self.fields(body="/literal")
        held = {**now, "mode": "hold", "id": "second"}
        self.control("idle", False)
        self.assertEqual(self.cli("snapshot")["state"], "working")
        self.assertEqual(self.cli("send", held), {"ok": True, "status": "waiting"})
        self.assertEqual(self.control("idle", False), [])
        self.control("run-ended")  # low-level end does not settle a retry or continuation
        self.assertEqual(self.cli("send", now), {"ok": True, "status": "queued"})
        self.assertEqual(self.cli("send", now), {"ok": True, "status": "queued"})
        self.assertEqual(self.control("idle", True), [
            {"body": "/literal", "options": {"deliverAs": "steer", "expandPromptTemplates": False}},
        ])
        self.assertEqual(self.cli("send", held), {"ok": True, "status": "accepted"})
        self.assertEqual(self.cli("send", held), {"ok": True, "status": "accepted"})
        self.assertEqual(self.cli("snapshot")["items"][-1]["text"], "/literal")
        self.assertEqual(self.cli("send", {**held, "body": "changed"})["error"], "id_conflict")
        self.assertEqual(len(self.control("idle", False)), 2)

    def test_held_send_follows_the_active_branch_as_the_leaf_advances(self):
        held = self.fields(mode="hold", body="keep going")
        self.control("idle", False)
        self.assertEqual(self.cli("send", held)["status"], "waiting")
        self.control("advance", "next-assistant")
        self.control("idle", True)
        self.assertEqual(self.cli("snapshot")["leaf"], "next-assistant")
        self.assertEqual(self.cli("send", held)["status"], "accepted")
        self.assertEqual(self.cli("send", held)["status"], "accepted")
        self.assertEqual([s["body"] for s in self.control("idle", True)], ["keep going"])

    def test_forward_navigation_refreshes_before_the_tree_hook(self):
        self.control("leaf", "user-1")
        held = self.fields(mode="hold", body="from the ancestor")
        self.control("idle", False)
        self.assertEqual(self.cli("send", held)["status"], "waiting")
        self.control("tree-start")
        self.control("leaf", "assistant-1")
        self.control("idle", True)
        # An earlier session_tree handler can await after Pi has already switched branches.
        moved = self.cli("snapshot", self.cursor(held))
        self.assertTrue(moved["reset"])
        self.assertNotEqual(moved["generation"], held["generation"])
        self.assertEqual(self.cli("send", held)["error"], "stale_leaf")
        self.assertEqual(self.control("idle", True), [])
        at_destination = self.fields(id="destination", body="stay on the destination")
        self.control("stream", "destination live reply")
        live = self.cli("snapshot", self.cursor(moved))
        self.control("tree", "assistant-1")
        after_hook = self.cli("snapshot", self.cursor(live))
        self.assertFalse(after_hook["reset"])
        self.assertEqual(after_hook["live"], live["live"])
        self.assertEqual(self.cli("send", at_destination)["status"], "queued")

    def test_guard_blocked_stale_leaf_session_and_instance(self):
        fields = self.fields()
        self.control("blocked", True)
        self.assertEqual(self.cli("snapshot")["state"], "blocked")
        self.assertEqual(self.cli("send", fields)["error"], "blocked")
        self.assertEqual(self.cli("send", {**fields, "mode": "hold"})["status"], "waiting")
        self.control("fork", "new-leaf")
        self.control("blocked", False)
        self.assertEqual(self.cli("send", fields)["error"], "stale_leaf")
        self.assertEqual(self.cli("send", {**fields, "mode": "hold"})["error"], "stale_leaf")
        self.control("session", "new-session")
        self.assertEqual(self.cli("send", fields)["error"], "stale_session")
        self.assertEqual(self.control("reload"), [])
        self.assertEqual(self.cli("send", fields)["error"], "stale_instance")
        self.assertEqual(self.cli("send", self.fields())["status"], "accepted")

    def cursor(self, snap):
        return {key: snap[key] for key in ("generation", "leaf")}

    def test_paged_branch_and_cursor_expiry(self):
        self.control("large", 535)
        snap = self.cli("snapshot")
        self.assertEqual(len(snap["items"]), 20)
        generation, before = snap["generation"], snap["before"]
        self.control("advance", "next")
        delta = self.cli("snapshot", self.cursor(snap))
        self.assertFalse(delta["reset"])
        self.assertEqual([x["text"] for x in delta["items"]], ["reply at next"])
        all_items = snap["items"] + delta["items"]
        while before:
            page = self.cli("page", {"generation": generation, "before": before})
            self.assertLess(page["before"], before)
            before = page["before"]
            all_items = page["items"] + all_items
        self.assertEqual([item["text"] for item in all_items], [f"record {i}" for i in range(535)] + ["reply at next"])
        self.control("wide")
        self.assertTrue(self.cli("snapshot", self.cursor(delta))["reset"])
        # A leaf change without any append must replace the window, not add a second branch.
        self.control("leaf", "msg-10")
        reset = self.cli("snapshot", self.cursor(delta))
        self.assertTrue(reset["reset"])
        self.assertNotEqual(reset["generation"], generation)
        self.assertEqual([item["text"] for item in reset["items"]], [f"record {i}" for i in range(11)])
        self.assertEqual(self.cli("page", {"generation": generation, "before": 3})["error"], "stale_revision")
        self.control("root", "independent")
        self.assertEqual([i["text"] for i in self.cli("snapshot", self.cursor(reset))["items"]], ["root independent"])
        self.control("leaf", "msg-534")
        self.assertEqual(self.cli("snapshot")["items"][-1]["text"], "record 534")

    def test_a_long_text_block_can_span_multiple_bounded_pages(self):
        self.control("long")
        page = self.cli("snapshot")
        self.assertGreater(page["before"], 0)
        parts = page["items"]
        generation = page["generation"]
        while page["before"]:
            page = self.cli("page", {"generation": generation, "before": page["before"]})
            parts = page["items"] + parts
        chunks = [p for p in parts if p["id"] == "long:0"]
        self.assertEqual([p["part"] for p in chunks], list(range(len(chunks))))
        self.assertEqual("".join(p["text"] for p in chunks), "x" * 7999 + "🌱" + "界" * 50_000)

    def test_live_to_final_concurrent_tools_and_retry(self):
        snap = self.cli("snapshot")
        self.control("stream", "provisional words")
        stream = self.cli("snapshot", self.cursor(snap))
        self.assertEqual(stream["state"], "working")
        self.assertEqual([i["text"] for i in stream["live"]], ["provisional words"])
        self.control("stream", "more provisional words")
        more = self.cli("snapshot", self.cursor(stream))
        self.assertEqual(more["live"][0]["id"], stream["live"][0]["id"])
        self.control("final", "authoritative final words")
        settled = self.cli("snapshot", self.cursor(more))
        self.assertEqual(settled["live"], [])
        self.assertEqual([(i["id"], i["text"]) for i in settled["items"]], [("final:1", "authoritative final words")])
        self.assertEqual(settled["items"][0]["from"], more["live"][0]["id"])
        self.assertEqual(self.cli("snapshot")["items"][-1]["from"], more["live"][0]["id"])
        self.control("tool-calls")
        tools = self.cli("snapshot", self.cursor(settled))
        self.assertEqual([(i["id"], i["text"]) for i in tools["items"]], [("calls:0", "read"), ("calls:1", "extension_tool")])
        query = {"generation": tools["generation"], "ids": ["calls:0", "calls:1"]}
        self.assertEqual(self.cli("results", query)["outputs"], [])
        self.control("tool-result", "b")
        self.assertEqual(self.cli("results", query)["outputs"], [{"id": "calls:1", "text": "output-b"}])
        self.control("tool-result", "a")
        self.assertEqual(self.cli("results", query)["outputs"], [{"id": "calls:0", "text": "output-a"}, {"id": "calls:1", "text": "output-b"}])
        self.assertNotIn("output-", json.dumps(self.cli("snapshot")))
        self.control("error")
        self.control("custom")
        self.assertEqual(self.cli("snapshot")["state"], "working")
        self.control("advance", "retry-succeeded")
        self.control("compact")
        self.assertEqual(self.cli("snapshot")["state"], "working")
        self.control("idle", True)
        self.assertEqual(self.cli("snapshot")["state"], "idle")
        self.control("tree", "user-1")
        self.assertEqual(self.cli("results", query)["error"], "stale_revision")

    def test_custom_store_identity_partial_records_and_raw_compaction(self):
        path = self.runtime.parent / "explicit store.jsonl"
        self.control("file", str(path))
        first = self.cli("snapshot")
        self.control("partial")
        partial = self.cli("snapshot", self.cursor(first))
        self.assertFalse(partial["reset"])
        self.assertEqual(partial["items"], [])
        self.control("replace-file")
        replaced = self.cli("snapshot", self.cursor(first))
        self.assertTrue(replaced["reset"])
        self.assertNotEqual(replaced["generation"], first["generation"])
        self.control("rewrite-file")
        rewritten = self.cli("snapshot", self.cursor(replaced))
        self.assertTrue(rewritten["reset"])
        self.assertNotEqual(rewritten["generation"], replaced["generation"])
        # Pi's active manager still owns the branch; the bridge does not pretend to resume an external file.
        self.assertEqual(rewritten["items"], replaced["items"])
        self.control("truncate-file")
        self.assertNotEqual(self.cli("snapshot")["generation"], rewritten["generation"])
        self.control("custom")
        self.control("compact")
        self.control("branch-summary")
        items = self.cli("snapshot")["items"]
        self.assertEqual([(x["role"], x["text"]) for x in items], [
            ("user", "hello\nworld"), ("assistant", "reply!"), ("custom", "visible extension note"),
            ("context-edit", "Earlier content changed in Pi’s context. The chat is unchanged."),
            ("compaction", "what happened before compaction"), ("branch", "why this branch exists"),
        ])

    def test_same_inode_truncation_and_regrowth_fences_old_cursors(self):
        path = self.runtime.parent / "regrown.jsonl"
        self.control("file", str(path))
        self.control("wide")
        first = self.cli("snapshot")
        identity = path.stat()
        self.control("regrow-file")
        self.assertEqual(path.stat().st_ino, identity.st_ino)
        self.assertGreater(path.stat().st_size, identity.st_size)
        moved = self.cli("snapshot", self.cursor(first))
        self.assertTrue(moved["reset"])
        self.assertNotEqual(moved["generation"], first["generation"])
        self.assertEqual(self.cli("page", {"generation": first["generation"], "before": first["before"]})["error"], "stale_revision")

    def test_ephemeral_branch_detects_replaced_entries_even_with_same_leaf(self):
        self.control("leaf", "assistant-1")
        first = self.cli("snapshot")
        self.control("replace-leaf-entry", "replacement")
        current = self.cli("snapshot", self.cursor(first))
        self.assertTrue(current["reset"])
        self.assertEqual(current["leaf"], first["leaf"])
        self.assertNotEqual(current["generation"], first["generation"])
        self.assertEqual(current["items"][-1]["text"], "replacement")

    def test_final_is_linked_to_its_stream_even_if_turn_ends_between_polls(self):
        self.control("stream", "draft before tools")
        first = self.cli("snapshot")
        self.control("final", "final after stream")
        self.control("turn-ended")
        self.control("new-stream", "continuation draft")
        current = self.cli("snapshot", self.cursor(first))
        self.assertEqual(current["items"][0]["from"], first["live"][0]["id"])
        self.assertEqual(current["items"][0]["text"], "final after stream")
        self.assertEqual([r["text"] for r in current["live"]], ["continuation draft"])
        self.assertNotEqual(current["live"][0]["id"], first["live"][0]["id"])

    def test_late_stream_update_does_not_reappear_after_navigation_or_session_change(self):
        self.cli("snapshot")
        self.control("stream", "old draft")
        streaming = self.cli("snapshot")
        self.control("tree", "user-1")
        moved = self.cli("snapshot", self.cursor(streaming))
        self.assertTrue(moved["reset"])
        self.assertEqual(moved["live"], [])
        self.control("stream", "late update from old draft")
        self.assertEqual(self.cli("snapshot", self.cursor(moved))["live"], [])
        self.control("session", "second-session")
        self.control("new-stream", "new session draft")
        switched = self.cli("snapshot", self.cursor(moved))
        self.assertTrue(switched["reset"])
        self.assertEqual([x["text"] for x in switched["live"]], ["new session draft"])

    def test_wire_bounds_pid_and_shutdown(self):
        instance = self.cli("snapshot")["instance"]
        frame = json.dumps({"op": "snapshot", "pid": self.pid + 1, "instance": instance}).encode() + b"\n"
        self.assertEqual(self.raw(frame)["error"], "stale_instance")
        self.assertEqual(self.raw(b"\xff\n")["error"], "invalid_json")
        self.assertEqual(self.raw(b"x" * (128 * 1024))["error"], "request_too_large")
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(3)
            conn.connect(str(self.address))
            self.control("shutdown")
            self.assertEqual(conn.recv(1), b"")
        self.assertFalse(self.registry.exists())
        self.assertFalse(self.address.exists())
        self.assertEqual(self.cli("snapshot")["error"], "not_available")


@unittest.skipUnless(os.environ.get("SHEPHERDR_TEST_PI") == "1", "set SHEPHERDR_TEST_PI=1 to exercise installed Pi")
class InteractivePi(Scratch):
    def start_pi(self, *args, **kwargs):
        from pi_pty import PiPty

        executable = shutil.which("pi")
        self.assertIsNotNone(executable, "SHEPHERDR_TEST_PI=1 requires Pi on PATH")
        pi = PiPty(executable, self.runtime.parent, self.runtime, *args, **kwargs)
        self.addCleanup(pi.close)
        self.pid = pi.proc.pid
        self.env = pi.env
        return pi

    def settled_reply(self, text):
        deadline = time.monotonic() + 5
        while True:
            snapshot = self.cli("snapshot")
            items = snapshot.get("items", [])
            if snapshot.get("state") == "idle" and items and items[-1]["text"] == text:
                return snapshot
            if time.monotonic() >= deadline:
                self.fail(f"Pi did not settle with reply {text!r}: {snapshot!r}")
            time.sleep(0.02)

    def test_reload_and_bridge_follow_up_keep_the_terminal_usable(self):
        pi = self.start_pi("terminal-first")
        pi.wait_for("Fixture echo: [terminal-first]")
        self.assertEqual(self.cli("snapshot")["error"], "not_available")

        # Reproduce the installer's link while interactive Pi already has a conversation.
        (pi.extensions / "shepherdr.ts").symlink_to(ROOT / "integrations/pi/shepherdr.ts")
        pi.send("/reload")
        pi.wait_for("Reloaded keybindings, extensions")
        first = self.cli("snapshot")
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["state"], "idle")
        self.assertEqual(self.cli("snapshot", pid=os.getpid())["error"], "not_available")
        self.assertEqual([(item["role"], item["text"]) for item in first["items"]], [
            ("user", "terminal-first"), ("assistant", "Fixture echo: [terminal-first]"),
        ])

        identity = {key: first[key] for key in ("instance", "session", "leaf", "generation")}
        fields = dict(identity, id="follow-up", body="bridge-next", mode="now")
        self.assertEqual(self.cli("send", fields), {"ok": True, "status": "accepted"})
        self.assertEqual(self.cli("send", fields), {"ok": True, "status": "accepted"})
        pi.wait_for("Fixture echo: [bridge-next]")
        self.settled_reply("Fixture echo: [bridge-next]")
        pi.send("terminal-after-bridge")
        pi.wait_for("Fixture echo: [terminal-after-bridge]")
        final = self.settled_reply("Fixture echo: [terminal-after-bridge]")
        self.assertEqual((final["instance"], final["session"]), (first["instance"], first["session"]))
        self.assertNotEqual(final["leaf"], first["leaf"])
        self.assertEqual([(item["role"], item["text"]) for item in final["items"]], [
            ("user", "terminal-first"), ("assistant", "Fixture echo: [terminal-first]"),
            ("user", "bridge-next"), ("assistant", "Fixture echo: [bridge-next]"),
            ("user", "terminal-after-bridge"), ("assistant", "Fixture echo: [terminal-after-bridge]"),
        ])
        pi.send("/quit")
        self.assertEqual(pi.proc.wait(timeout=5), 0)
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_resumed_custom_file_uses_only_the_active_parent_chain(self):
        path = self.runtime.parent / "custom session.jsonl"
        timestamp = "2025-06-01T12:00:00.123Z"

        def user(entry_id, parent_id, content):
            return {"type": "message", "id": entry_id, "parentId": parent_id, "timestamp": timestamp,
                    "message": {"role": "user", "content": content, "timestamp": 1748779200123}}

        entries = [
            {"type": "session", "version": 3, "id": "a56eaab9-827c-467c-9205-bffba198ec6c",
             "timestamp": timestamp, "cwd": str(path.parent)},
            user("old-root", None, "Not on the active branch"),
            user("new-root", None, "Original visible prompt"),
            user("side", "new-root", "Not on the active fork"),
            {"type": "context_edit", "id": "edit", "parentId": "new-root", "timestamp": timestamp,
             "targetId": "new-root", "replacement": {"content": "Private model-only replacement"}},
            {"type": "compaction", "id": "keep", "parentId": "edit", "timestamp": timestamp,
             "firstKeptEntryId": "new-root", "tokensBefore": 120, "summary": "Visible compacted summary"},
        ]
        path.write_text("".join(json.dumps(entry) + "\n" for entry in entries) + '{"type":"mess')
        self.start_pi("-e", ROOT / "integrations/pi/shepherdr.ts", "--session", path)
        snap = self.settled_reply("Visible compacted summary")
        self.assertEqual([r["id"] for r in snap["items"]], ["new-root:0", "edit:0", "keep:0"])
        self.assertEqual(snap["items"][0]["text"], "Original visible prompt")
        self.assertNotIn("Private model-only replacement", json.dumps(snap))

    def test_send_now_waits_during_manual_compaction_without_recording_a_receipt(self):
        pi = self.start_pi("-e", ROOT / "integrations/pi/shepherdr.ts", "before-compact",
                           settings={"compaction": {"enabled": False, "keepRecentTokens": 1}})
        self.settled_reply("Fixture echo: [before-compact]")
        pi.send("last-before-compact")
        self.settled_reply("Fixture echo: [last-before-compact]")
        gate = self.runtime.parent / "fixture-hold-compaction"
        gate.touch()
        pi.send("/compact")
        pi.wait_for("Fixture compaction held")

        snapshot = self.cli("snapshot")
        self.assertEqual(snapshot["state"], "working")
        identity = {key: snapshot[key] for key in ("instance", "session", "leaf", "generation")}
        fields = dict(identity, id="compact-follow-up", body="after-compact", mode="now")
        self.assertEqual(self.cli("send", fields), {"ok": True, "status": "waiting"})
        gate.unlink()
        compacted = self.settled_reply("Fixture compaction summary")
        self.assertEqual(compacted["generation"], snapshot["generation"])
        self.assertEqual([(r["role"], r["text"]) for r in compacted["items"]], [
            ("user", "before-compact"), ("assistant", "Fixture echo: [before-compact]"),
            ("user", "last-before-compact"), ("assistant", "Fixture echo: [last-before-compact]"),
            ("compaction", "Fixture compaction summary"),
        ])
        self.assertEqual(self.cli("send", fields), {"ok": True, "status": "accepted"})
        pi.wait_for("Fixture echo: [after-compact]")
        rows = self.settled_reply("Fixture echo: [after-compact]")["items"]
        self.assertEqual([(r["role"], r["text"]) for r in rows[-2:]], [
            ("user", "after-compact"), ("assistant", "Fixture echo: [after-compact]"),
        ])
