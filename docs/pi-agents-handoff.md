# Pi agent selection follow-ups

## Request and decisions

The user wants Assistant, Worker and Reviewer selection to assume Pi coding agent, while retaining model and thinking-level choices. They explicitly chose **Pi only** for these role selectors, rather than keeping Claude Code and Codex as alternatives. No permissions selector is needed for Pi.

The user subsequently clarified that support for thinking level `off` is not needed. Do not add task-level `off` support as a follow-up requirement. The current draft already exposes it in Pi menus and some tests. That is existing draft behavior, not a request to expand support throughout the application.

The user further limited the Assistant, Worker and Reviewer model choices to these versions only:

| Model | Pi model ID, before the provider prefix |
| --- | --- |
| Fable 5.2 | `claude-fable-5-2` |
| Opus 5.5 | `claude-opus-5-5` |
| Sonnet 5.5 | `claude-sonnet-5-5` |
| Haiku 5.5 | `claude-haiku-5-5` |
| Sol 6.2 | `gpt-6.2-sol` |
| Astra 6.2 | `gpt-6.2-astra` |
| Terra 6.1 | `gpt-6.1-terra` |
| Luna 6 | `gpt-6-luna` |

`pi --offline --list-models` on this machine lists all eight. Anthropic models use the `pi-claude-subscription` provider and OpenAI models use `openai`. Do not hardcode those providers into the role menus. Keep the provider IDs supplied by the catalog. This is an explicit supported-version list, not automatic future-version detection.

Keep the stored role key `coordinator` and runtime role identifiers. Assistant is the display name. Reuse the stored `effort` field for Pi's thinking level, and translate it to `--thinking` at launch. Preserve provider-qualified model IDs such as `openai/model-id`.

This document records unfinished work. The earlier completion message overstated readiness: selector and launch-command tests pass, but complete Pi conversation operation has not been verified.

## Working tree

- Project: `/Users/mark/tmp/shepherdr`
- Branch at handoff: `feature/pi-role-agents`
- The implementation is uncommitted. Check `git status` and inspect the diff before editing. Preserve this work; do not reset it or start from a clean base without bringing it along.
- No commit, PR, release or deployment has been made for this change.
- Follow `AGENTS.md` and `docs/develop.md`. Never access production servers, run a second application window or install into the real application home to test this.
- GitHub repository is `markdlabrecque/shepherdr`. The user prefers `~/.nvm/versions/node/v24.21.0/bin/gh-axi` for GitHub operations. No ticket reference has been assigned. Do not open a PR without asking for a ticket reference, per the user's instructions.

## Implemented in the draft

Inspect the diff for exact details. The main changes are:

- `core/agents.js`: Pi name, settings/catalog loading, model menus without permission or speed capabilities, provider-qualified typed IDs, current selection parsing and Pi argv generation.
- `core/settings.js`: Pi-only role choices, Pi defaults for all three role selectors and the Reviewer reset text `Use Pi defaults`.
- `lib/settings.js` and `mods/shepherdr-settings/main.js`: window role selectors use Pi choices. `mods/chat-models/main.js` includes Pi when collecting models.
- `service/agents.ts`, `service/compat.ts`, `service/main.ts`, `service/settings.ts`: settings choices use Pi, and role saves accept provider-qualified Pi models and thinking levels while clearing permission/speed settings.
- `service/spaces.ts`: a saved Pi Assistant choice is recognized when building its launch template.
- `mods/tasks/bin/herdr_task/settings.py`: Pi worker argv, `--thinking` parsing, default worker Pi and Pi reviewer command construction.
- `templates/assistant.md`, `templates/worker.md`, `templates/reviewer.md`: default command Pi. Worker reviewer-launch examples use Pi.
- `mods/tasks/bin/herdr_task/templates.py`: corresponding worker instruction defaults, previous-default recognition and Pi template headers.
- Tests in `core/agents.test.js`, `core/settings.test.js`, `service/settings.test.ts`, `service/assistant-start.test.ts`, `test/test_herdr_task.py` and new `test/test_pi_agents.py`.
- Shared copies under mods were generated with `bin/sync-shared`. Edit shared sources, not their copies.

The Pi catalog loader currently parses `pi --offline --list-models` and reads Pi's global `settings.json`. Verify its behavior with the supported installed Pi version, missing settings, unavailable Pi and multiple providers. It is not a new SDK integration.

## Follow-ups

### 1. Codex-only reviewer model validation, fixed in the working tree

`check_reviewer_model()` now resolves the reviewer's CLI through `reviewer_pick()`, which the brief also uses. `cmd_add` and `cmd_edit` pass the store so saved role settings are available. Add also passes its selected space. Explicit and inherited Pi reviewers bypass Codex's catalog; actual Codex reviewers retain validation, regardless of the model's name. Regression tests stub settings and the cache helper.

The following describes the original missed validation path, now addressed.

In `mods/tasks/bin/herdr_task/settings.py`, `check_reviewer_model(t)` validates a task's `reviewer_model` against Codex's local model cache. `codex_models()` reads `~/.codex/models_cache.json`, respecting `CODEX_HOME`, and `codex_lacks()` compares the requested model against cached slugs.

The check currently exempts an explicit Claude reviewer and some model names inferred to be Claude. It does not exempt an explicit Pi reviewer. Consequently, a valid Pi selection such as `openai/model-id` can fail with "Codex here doesn't offer ..." merely because that name isn't in Codex's catalog.

Required result:

- Explicit Pi reviewer selections must not be validated against Codex's cache.
- Keep validation for actual Codex reviewer selections.
- Investigate how an omitted task-level reviewer is resolved from saved settings. An inherited Pi reviewer must not accidentally be treated as Codex either. Do not guess from the model's name alone.
- Add regression tests for Pi acceptance and retained Codex rejection. Stub the cache or helper; do not read real account data.

Start with `check_reviewer_model()` and its caller in the task-field validation path in the same file. Review existing tests around `ReviewerLine` and `ReviewerFlags` in `test/test_herdr_task.py`.

### 2. Verify a real end-to-end Pi conversation

Successful command construction does not prove a usable Assistant or Worker chat.

Known code evidence:

- `core/chat-reader.js` has a `KINDS` map containing Claude Code and Codex only. `kindOf()` does not recognize Pi.
- `core/chat-log.js` finds and parses Claude/Codex sessions. Pi transcript support has not been implemented or verified in this draft.
- The running-chat menu and restart paths in `service/agents.ts` still contain Claude/Codex-only assumptions outside the role-settings loader.

Trace the actual Pi flow before claiming completion: start, first-message delivery, status detection, conversation display, subsequent sends and model/thinking changes. Decide which missing pieces are required for the requested role selection to work, and ask the user before expanding into a large conversation integration.

Use isolated tests and stubs first. Do not launch the real application with a changed `HOME` or `HERDR_APP_HOME`. Read the project rules before any live experiment. Read relevant installed Pi docs before implementing an integration; do not assume another agent's flags, session format or RPC protocol apply to Pi.

### 3. Check restarts and unavailable-Pi behavior

These are investigation findings, not verified fixes:

- `mods/coordinator/restart.sh` accepts an explicit Pi argv array. A restart without argv reads the Assistant template's command rather than resolving the saved coordinator choice. Verify that restarting preserves the selected Pi model and thinking level.
- `mods/chat/main.js` → `startAgent()` can fall back to the template command when the selected agent is unavailable on another machine.
- `service/spaces.ts` → `execTemplate()` also retains template-command fallback behavior.

With Pi-only role selection, silently starting Claude/Codex would contradict the visible selection. Prefer a clear missing-Pi error over silent substitution. Preserve intentional user-edited templates unless a migration is explicitly agreed.

### 4. Check saved choices and inheritance

- Python `settings_for()` merges role fields across layers; `lib/coordinator.js` → `shepherdrFor()` treats a role as a whole choice. A partial Pi override must not inherit an incompatible Claude/Codex model or permissions accidentally.
- `roleSel()` in the draft displays Pi defaults for an older saved non-Pi role, without migrating that saved role. Check that what the selector shows matches what will actually launch. Do not silently migrate personal settings without considering existing configurations.
- Check Reviewer reset behavior and the relationship to a task's own reviewer override. Default Pi workers should get a Pi reviewer.

### 5. Reviewer restrictions and legacy workers

Pi has no Claude Plan mode or Codex read-only sandbox. Reviewer instructions require no edits, but a plain Pi launch does not enforce that restriction. Do not describe it as sandbox-enforced read-only.

`mods/tasks/bin/herdr_task/launch.py` has a `REVIEWERS` allowlist and `helper_hc()` recognition for sandboxed Codex workers launching their helpers. It does not recognize Pi reviewer commands/labels. Determine whether legacy Codex workers must be supported with Pi reviewers. Do not simply add unrestricted Pi to a read-only escalation allowlist, since that changes its security assumptions.

The existing backup-agent setting also assumes a different CLI can take over. Review its interaction with Pi-only role selection without expanding the change unnecessarily.

## Latest model-selection changes

- `core/agents.js` defines `PI_ROLE_MODELS` and identifies the supported exact versions without binding them to a provider.
- `core/settings.js` filters role menus to supported entries present in Pi's catalog and uses readable model names. An unsupported or unavailable Pi default cannot insert an extra model into these menus.
- Role menus set `allowTyped: false`. Search cannot introduce arbitrary IDs, and pinned/recent older models cannot reappear. General chat restart menus retain their previous behavior.
- `service/settings.ts` rejects unsupported model IDs when saving any of the three roles. Provider-qualified IDs are retained.
- Existing personal settings and Pi's global defaults have not been migrated. The saved-choice/default launch consistency issues listed above still need investigation. Filtering a menu does not constrain what a bare `pi` command launches.
- The Codex-only reviewer validation follow-up is fixed as described above.

## Verification so far

Latest focused checks pass: 45 Bun tests across the four files below, 31 Python tests across the listed modules/classes, TypeScript, web build, shared-copy check, JavaScript and shell syntax checks, and `git diff --check`. The build still reports CSS `::highlight` and large-chunk warnings. The model tests cover all eight versions, multiple providers, old/default model exclusion, missing catalogs, search/pins/recents and role-save rejection. The reviewer tests cover explicit/inherited Pi and retained Codex validation. Full conversation operation remains unverified.

Earlier checks on the draft:

- 43 focused Bun tests across `core/agents.test.js`, `core/settings.test.js`, `service/settings.test.ts`, `service/assistant-start.test.ts`.
- 27 Python tests from `test_pi_agents`, `test_herdr_task.ReviewAsAHelperAgent`, `test_herdr_task.ReviewerLine`, `test_herdr_task.ReviewerFlags`, `test_herdr_task.AssistantSettings`.
- TypeScript check.
- Web build.
- Shared-copy check, JavaScript syntax checks, shell syntax checks and `git diff --check`.

The full suites are not green on this machine:

- Full Bun run before the final additional settings test: 837 passed, one failure in `core/bg-jobs.test.js`, `JOBS sees the output file a job's process holds open, stops it, and reads its last lines`. The same failure reproduced from an unchanged HEAD archive.
- Full Python run initially had 13 failures and two errors. One failure was the worker-template assertion expecting Codex/Claude examples; that assertion was updated for Pi and its class now passes.
- An unchanged HEAD archive had the remaining 12 failures and two errors. They involve artifact preview, browser arguments, cross-machine automations, macOS path differences, installer expectations, process-table behavior and `setsid`. Do not attribute them to this change without new evidence.
- No unrelated tests were retired or simplified. The template assertion was updated to match the requested behavior.

Logs from this session may remain in `/tmp/shepherdr-pi-*`, including focused, full-suite, baseline, build and typecheck logs. They are temporary and may not survive a new machine or reboot. Re-run checks rather than relying on their presence.

Useful commands from the repo root:

```bash
bin/sync-shared --check
bun test core/agents.test.js core/settings.test.js service/settings.test.ts service/assistant-start.test.ts
bun node_modules/typescript/bin/tsc --noEmit -p .
(cd web && bun ../node_modules/vite/bin/vite.js build)
(cd test && python3 -m unittest test_pi_agents test_herdr_task.ReviewAsAHelperAgent test_herdr_task.ReviewerLine test_herdr_task.ReviewerFlags test_herdr_task.AssistantSettings)
bun test service core web
python3 -m unittest discover -s test
git diff --check
```

`bunx` was not on PATH here. Some `bun x` invocations were misrouted by RTK, so direct local tool paths were used above. For a fresh checkout, follow the dependency/build preparation in `AGENTS.md`.

## Completion criteria

- Pi reviewer selections bypass Codex-specific model validation, with regression coverage.
- Model and thinking choices are preserved from role selection through the actual launch paths being supported.
- No permission selector is shown for Pi.
- Missing Pi cannot quietly launch a different CLI behind a Pi selection.
- Pi chat/status/restart support is either verified or its remaining limitations are explicitly reported to the user.
- No task-level `off` support is required.
- Report verified tests and baseline failures separately. Do not claim the complete workflow works based only on argv tests.
