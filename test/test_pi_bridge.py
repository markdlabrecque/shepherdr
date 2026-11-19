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
        if isinstance(fields, dict):
            fields = json.dumps(fields).encode()
        result = subprocess.run([CLIENT, op, str(self.pid if pid is None else pid)], input=fields or b"",
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
        return {**{key: snap[key] for key in ("instance", "session", "leaf")},
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
        self.assertEqual(snap["items"], [{"id": "user-1", "role": "user", "text": "hello\nworld", "at": 1748779200123},
                                         {"id": "assistant-1", "role": "assistant", "text": "reply!", "at": 1748779200123}])
        self.assertEqual((snap["state"], snap["leaf"]), ("idle", "tool-1"))
        self.control("leaf", None)
        self.assertIsNone(self.cli("snapshot")["leaf"])
        self.control("large")
        items = self.cli("snapshot")["items"]
        self.assertEqual([item["id"] for item in items], [f"msg-{i}" for i in range(25, 45)])
        self.assertEqual({len(item["text"]) for item in items}, {1800})
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
