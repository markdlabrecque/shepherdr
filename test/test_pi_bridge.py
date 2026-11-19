"""The executable and Pi extension talk over real sockets in a private scratch registry."""
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
        self.control("truncate-file")
        self.assertNotEqual(self.cli("snapshot")["generation"], replaced["generation"])
        self.control("custom")
        self.control("compact")
        self.control("branch-summary")
        items = self.cli("snapshot")["items"]
        self.assertEqual([(x["role"], x["text"]) for x in items], [
            ("user", "hello\nworld"), ("assistant", "reply!"), ("custom", "visible extension note"),
            ("compaction", "what happened before compaction"), ("branch", "why this branch exists"),
        ])

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
