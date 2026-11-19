"""Run installed Pi on a PTY with scratch state and the in-process echo provider."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import termios
from threading import Condition, Event, Thread

PROVIDER = Path(__file__).resolve().parent / "fixtures/pi-echo-provider.ts"


class PiPty:
    def __init__(self, executable, scratch, runtime, *args, settings=None):
        home = scratch / "home"
        home.mkdir()
        self.agent_dir = scratch / "agent"
        self.extensions = self.agent_dir / "extensions"
        self.extensions.mkdir(parents=True)
        if settings is not None:
            (self.agent_dir / "settings.json").write_text(json.dumps(settings))
        self.env = {"HOME": str(home), "PATH": os.environ.get("PATH", os.defpath), "TERM": "xterm-256color",
                    "PI_CODING_AGENT_DIR": str(self.agent_dir), "PI_TELEMETRY": "0",
                    "SHEPHERDR_PI_RUNTIME_DIR": str(runtime)}
        self.output = bytearray()
        self.master, slave = pty.openpty()
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
            self.proc = subprocess.Popen([executable, "--offline", "--no-approve", "--no-mcp", "--no-skills",
                                          "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
                                          "--tui-mode", "regular", "-e", PROVIDER, "--model", "shepherdr-test/echo",
                                          *args], cwd=scratch, env=self.env, stdin=slave, stdout=slave, stderr=slave)
        except BaseException:
            os.close(self.master)
            raise
        finally:
            os.close(slave)
        self.changed = Condition()
        self.stop = Event()
        self.eof = False
        self.read_error = None
        # Pi writes synchronously to the TTY. Drain it even while the test waits on a socket request.
        self.reader = Thread(target=self.read_output, daemon=True)
        self.reader.start()

    def read_output(self):
        try:
            while not self.stop.is_set():
                if not select.select([self.master], [], [], 0.1)[0]:
                    continue
                chunk = os.read(self.master, 8192)
                if not chunk:
                    break
                with self.changed:
                    self.output.extend(chunk)
                    self.changed.notify_all()
        except OSError as exc:
            if exc.errno != errno.EIO:  # Linux PTY EOF
                self.read_error = exc
        finally:
            with self.changed:
                self.eof = True
                self.changed.notify_all()

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait(timeout=5)
        finally:
            self.stop.set()
            self.reader.join()
            os.close(self.master)

    def send(self, line):
        os.write(self.master, line.encode() + b"\r")

    def wait_for(self, text, timeout=15):
        target = text.encode()
        with self.changed:
            self.changed.wait_for(lambda: target in self.output or self.eof, timeout)
            if target not in self.output:
                raise AssertionError(f"Pi did not display {text!r}: {bytes(self.output[-6000:])!r}") from self.read_error
