// Agents never inherit a parent Claude Code session (SHEP-86). herdr-core's holder keeps the environment of whatever
// started it, and every terminal it runs gets that: a holder started from inside Claude Code hands each agent
// CLAUDECODE, CLAUDE_PID and CLAUDE_CODE_CHILD_SESSION, SESSION_ID, MESSAGING_*… Claude Code then turns transcript
// saving off ("inherited CLAUDE_CODE_CHILD_SESSION marker", the web Chat can't find the conversation) and skips the
// folder-trust prompt. hc can only add variables, never remove them, so each launch starts with this shell line:
// it unsets CLAUDECODE, CLAUDE_PID and CLAUDE_CODE_*, keeping the person's own Claude Code config
// (CLAUDE_CODE_USE_BEDROCK, _SKIP_*, _DISABLE_*, _OAUTH_TOKEN…, and CLAUDE_CONFIG_DIR, which never matches).
// POSIX sh (sed -E and grep -E work on GNU and macOS). The same line is in herdr-task (launch.py CLEAN_ENV) and
// mods/coordinator/restart.sh; test/test_repo.py keeps them equal.
export const CLEAN_ENV = `for v in $(env | sed -nE 's/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_[A-Za-z0-9_]+)=.*/\\1/p' | grep -vE '^CLAUDE_CODE_(USE|SKIP|DISABLE|ENABLE|MAX|OAUTH|CLIENT|API)_'); do unset "$v"; done;`;

// Where agent CLIs install, after the holder's own PATH (which keeps its order): a holder started over ssh, as on a
// linked Mac, has only /usr/bin:/bin:/usr/sbin:/sbin, and claude's native installer, hc and herdr-task live in
// ~/.local/bin, Homebrew's in /opt/homebrew/bin or /usr/local/bin (GitHub #839: "exec: claude: not found").
// Managed Pi installs its launcher in ~/.pi/agent/bin. nvm is normally loaded only by interactive shells: keep an
// inherited selection, otherwise resolve its default in a subshell (no shell-profile side effects). Append its bin
// directory so node's /usr/bin/env launchers and npm-installed tools work, without overriding the holder's PATH.
export const AGENT_PATH = `PATH="\${PATH:+$PATH:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.pi/agent/bin"; export PATH; if [ -n "\${NVM_BIN:-}" ] && [ -x "$NVM_BIN/node" ]; then PATH="$PATH:$NVM_BIN"; else shepherdr_nvm_node=$(if [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then . "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use >/dev/null 2>&1 && nvm which default 2>/dev/null; fi) || shepherdr_nvm_node=; if [ -n "$shepherdr_nvm_node" ] && [ -x "$shepherdr_nvm_node" ]; then PATH="$PATH:\${shepherdr_nvm_node%/*}"; fi; unset shepherdr_nvm_node; fi; export PATH;`;

/** A template's `command:` (run by hc under sh -c) that clears those first, finds the agent where it installs, then
 *  execs the command (so the terminal's program is the agent, never sh: on dash the shell would otherwise stay). An
 *  `exec` it had is kept once. */
export const cleanCommand = (cmd) => `${CLEAN_ENV} ${AGENT_PATH} exec ${String(cmd).trim().replace(/^exec\s+/, "")}`;
