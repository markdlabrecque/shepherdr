"""Exercise the real Chat / Terminal header without opening herdr-app."""
import home_guard  # noqa: F401
import json
from pathlib import Path
import re
import subprocess
import unittest

MAIN = Path(__file__).resolve().parents[1] / "mods/pane-chat/main.js"
HEADER = re.sub(r"^import .*;\n", "", MAIN.read_text(encoding="utf-8"), flags=re.M)
HEADER = HEADER.replace("export default class Pane", "class Pane")

HARNESS = r"""
const assert = require('node:assert/strict');
const { meta, switchable, roundTrip } = JSON.parse(process.argv[1]);
const terminal = 'test-machine/t42', chat = 'chat-pane', term = 'terminal-pane';
const agent = { address: terminal, state: 'live', labels: { 'herdr.chat': chat, 'herdr.role': 'coordinator' } };
const termPane = { ...meta, terminal, pane: term, focused: true };
let current = roundTrip ? { mod: 'chat', pane: chat, focused: true } : termPane;
let shown = null, now = 10000, command = 'toggle';
const Date = { now: () => now };
const props = () => ({ pane: current.pane });
const panes = () => [current];
const terminals = () => [agent];
const spaces = () => [];
const chatPane = t => t?.labels?.['herdr.chat'];
const chatLabel = id => id;
const spaceName = () => 'Test space';
const home = () => '/unused';
const addonOn = () => false;
const theme = () => ({});
const apWatch = () => {};
const TEXT = {};
const View = class {};
const ui = new Proxy({}, { get: (_, key) => key === 'when' ? (yes, draw) => {
  if (yes) draw(ui);
  return ui;
} : () => ui });
const h_flex = () => ui, div = h_flex;
const segmented = (_id, _choices, mode, click) => { shown = { mode, click }; return ui; };
const calls = [];
const run = (name, args) => calls.push([name, args]);
const hc = async ([op, addr, label]) => {
  assert.equal(op, 'label');
  assert.equal(addr, terminal);
  agent.labels['herdr.chat'] = label.split('=')[1];
  calls.push([op, addr, label]);
};
const exec = async (bin, [op, name, ...argv]) => {
  assert.equal(bin, 'herdr-app');
  assert.equal(op, 'do');
  calls.push([name, argv]);
  if (name === 'terminal.keep') current = termPane;
  return { code: 0, stdout: JSON.stringify({ pane: name === 'terminal.keep' ? term : chat }) };
};
const toast = ({ body }) => { throw new Error(body); };
const plainError = e => e.message;
const stop = new Error('one keyboard command delivered');
const nextCommand = () => {
  if (!command) throw stop;
  return Promise.resolve(command).then(c => { command = null; return c; });
};
const jobs = [];
const cx = { spawn: fn => jobs.push(fn(cx)), notify() {}, sleep: () => new Promise(() => {}), timer: { every() {} } };
"""

CHECK = r"""
(async () => {
  const pane = new Pane();
  if (roundTrip) {
    pane.draw(cx);
    assert.equal(shown?.mode, 'chat');
    shown.click('terminal', null, cx);
    await jobs.shift();
    assert.deepEqual(calls.splice(0), [
      ['pane.focus', ['--pane', chat]], ['terminal.keep', ['--terminal', terminal, '--place', 'right']],
      ['label', terminal, 'herdr.chat='], ['pane.focus', { pane: term }], ['pane.close', ['--pane', chat]],
    ]);
  }
  shown = null;
  pane.draw(cx);
  assert.equal(shown?.mode, switchable ? 'terminal' : undefined, 'Terminal header switch');
  pane.init(null, cx);
  now += 4000;
  await assert.rejects(jobs.shift(), e => e === stop);
  for (const job of jobs) await job;
  assert.deepEqual(calls, switchable ? [
    ['pane.split', ['--direction', 'right', '--pane', term, '--mod', 'chat', '--props', JSON.stringify({ terminal })]],
    ['label', terminal, `herdr.chat=${chat}`], ['pane.focus', { pane: chat }], ['terminal.park', ['--terminal', terminal]],
  ] : [], 'keyboard toggle parks the same terminal in Chat, or does nothing for a shell');
})().catch(e => { console.error(e); process.exitCode = 1; });
"""


class PaneChatSwitch(unittest.TestCase):
    def check_switch(self, meta, switchable=True, round_trip=False):
        args = json.dumps({"meta": meta, "switchable": switchable, "roundTrip": round_trip})
        result = subprocess.run(["node", "-e", HARNESS + HEADER + CHECK, args], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pi_assistant_keeps_switch_and_keyboard_returns_to_same_terminal(self):
        for meta in ({"app": "pi"}, {"program": {"key": "pi"}}):
            with self.subTest(meta=meta):
                self.check_switch(meta, round_trip=True)

    def test_claude_and_codex_remain_switchable(self):
        for app, key in [("claude-code", "claude"), ("codex", "codex")]:
            for meta in ({"app": app}, {"program": {"key": key}}):
                with self.subTest(meta=meta):
                    self.check_switch(meta)

    def test_shell_has_no_switch_and_keyboard_does_not_open_chat(self):
        self.check_switch({"program": {"key": "shell", "shell": True}}, switchable=False)
