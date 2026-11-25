# Porting dsh-guard to Claude Code: design

Status: design, implementation in progress (see Amendments and Probes). Written 2026-11-25 against dsh-guard HEAD `1f0110b` (committed state; the uncommitted `guard_propose` work is not covered), Claude Code 2.1.332, and the official documentation fetched the same day (hooks reference, hooks guide, plugins reference, permissions, permission modes).

## Amendments

Recorded 2026-11-25, after the design was written and before implementation.

- A1, `ask` handled by the guard. Users who run `bypassPermissions` want no permission popups, so an `ask` rule must not depend on Claude Code's permission prompt. In the first release an `ask` hit behaves as a block: the PreToolUse hook answers `deny`, and the reason tells Claude to obtain the user's agreement in the chat and then repeat the command with the override comment `# guard: allow <reason>`. The comment works for every `ask` rule (as if `override: true`), but, as for block rules, only on shell commands. An optional external confirmation channel (a device or app that confirms out of band) is left to a later release. Sections 3.1 and 3.3 below are read with this amendment; `askVia: prompt` is not implemented.
- A2, probe P1 dropped. With A1 the guard never emits `permissionDecision: "ask"`, so whether an ask prompts under `bypassPermissions` no longer matters.
- A3, scope (D2 decided as recommended). First release: engine, hooks, CLI and self-protection, with rule-change approval by a typed code. No external confirmation channel.
- A4, `guard_propose`. Since `1f0110b` the dsh adapter gained `guard_propose` (draft, test and replay in one call), approval texts (`approvalPrompt`, `approvalDisplay`) and example checks. The CLI's `propose` subcommand mirrors it (section 4.1, row `guard propose`, is no longer reserved).
- A5, layout (implementation). The three packages are directories of one TypeScript project (`src/core`, `src/dsh`, `src/claude-code`), not npm workspaces: `dsh plugin add` links the repository root and the dsh zip keeps its layout. `test/packages.test.ts` enforces the boundaries. The Claude Code plugin files live in `plugin/claude-code/`; `npm run pack:claude-code` assembles the release folder with the compiled `dist/core` and `dist/claude-code` and the vendored `yaml` (no bundler; P5).
- A6, configuration (implementation). Hooks and the command line read the same environment variables (`DSH_GUARD_HOME`, `DSH_GUARD_STATE`, `DSH_GUARD_LOG`, `DSH_GUARD_PACKS`, `DSH_GUARD_RULES`, `DSH_GUARD_PROTECT`, `DSH_GUARD_FAIL_MODE`), since plugin `userConfig` values reach hooks but not the Bash tool. Pending approvals live in `DSH_GUARD_STATE` (default `<DSH_GUARD_HOME>/state`), not in `CLAUDE_PLUGIN_DATA`, which the command line cannot see. The built-in id prefix stays `dsh-guard.` (D6 deferred).
- A7, deferred from this release: the ConfigChange hook (section 4.3, second line of defence), the per-rule `harness:` field and `exposeEnv` (2.4), and the configurable override markers. Installation-specific protected paths (other guard scripts or settings of the same machine, see 4.3) are not built in; they are added through `DSH_GUARD_PROTECT`.

## 0. Summary of recommendations

- One repository with three packages: an engine core with no harness dependency, the existing dsh adapter, and a new Claude Code adapter shipped as a Claude Code plugin. The engine stays in TypeScript, so one regex dialect (JavaScript) serves both harnesses and rule files are shared without translation.
- The Claude Code adapter is a set of command hooks (PreToolUse, PostToolUse, ConfigChange, UserPromptSubmit, SessionStart) plus a CLI for authoring; the dsh tools `guard_list/draft/test/replay/apply` become CLI subcommands that Claude runs through Bash, and `guidance/authoring.md` becomes a plugin skill.
- Actions map cleanly: `block` to a PreToolUse deny, `ask` to a PreToolUse ask (or to an external confirmation, configurable), `warn` to `additionalContext`, `redact` to PostToolUse `updatedToolOutput`, which the documentation states works for built-in and MCP tools alike. Only `ask` rules and rule changes ever reach the user.
- Rule changes are approved without a popup: by a confirmation on an optional external device or app, and otherwise by a short code that the user types into the chat, which a UserPromptSubmit hook (not Claude) turns into the write.
- The decisions left to the maintainer are listed in section 6, each with a recommendation. The most consequential: Node.js must be on `PATH` wherever the hook runs.

## 1. Claude Code hook capabilities (verified)

Sources are cited as `hooks#<anchor>` for https://code.claude.com/docs/en/hooks, `hooks-guide#…` for https://code.claude.com/docs/en/hooks-guide, `plugins-reference#…`, `permissions#…` and `permission-modes#…` for the pages of the same names under https://code.claude.com/docs/en/.

### 1.1 Decisions and outputs

| capability | documented behaviour | source |
|---|---|---|
| PreToolUse deny with reason | `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason`, which is shown to Claude; exit code 2 with stderr is routed the same way. A deny holds in every permission mode, `bypassPermissions` and `--dangerously-skip-permissions` included. | hooks#pretooluse-decision-control; hooks-guide#hooks-and-permission-modes |
| PreToolUse ask | `"ask"` prompts the user; the reason is shown in the prompt, which carries a source label (`[plugin:<name>]` for a plugin hook). In a `-p` run without a permission host the call is denied and Claude reads the reason in the tool result. In auto mode the ask goes to the prompt, not to the classifier. | hooks#pretooluse-decision-control; hooks#pretooluse-ask-decisions-in-auto-mode |
| PreToolUse ask in `bypassPermissions` | Not stated directly. permission-modes#why-the-critical-path-removal-prompt-stays-on lists "a PreToolUse hook answers ask for a removal" as a reason a prompt persists in bypass mode, which implies that a hook's ask does prompt there. Needs probe P1. | permission-modes |
| PreToolUse allow | Skips the permission prompt, but deny and ask rules from settings are still evaluated. The guard never needs to emit allow and must not, since an allow would suppress prompts that other mechanisms want. | hooks#pretooluse-decision-control; permissions#precedence-among-rules-hooks-and-mods |
| Precedence between hooks | Matching hooks run in parallel; for PreToolUse the combined result is `deny` > `defer` > `ask` > `allow`. | hooks#hook-handler-fields; hooks#pretooluse-decision-control |
| Input rewrite | `updatedInput` replaces the whole input (with allow, ask or no decision). Not needed by this design. | hooks#pretooluse-decision-control |
| Context for Claude | `additionalContext` on PreToolUse and PostToolUse is added beside the tool result as a system reminder. | hooks#add-context-for-claude; hooks-guide#limitations |
| PostToolUse block | `decision: "block"` only adds `reason` beside the result; Claude still sees the original output. | hooks#posttooluse-decision-control |
| Output rewrite, built-in tools | `updatedToolOutput` replaces the output before Claude sees it. The value must match the tool's output shape (Bash: `stdout`, `stderr`, `interrupted`, `isImage`); a value that does not match is silently ignored and the original is used. Telemetry captures the original output. A Cowork cloud session ignores the field for some tools. | hooks#posttooluse-decision-control |
| Output rewrite, MCP tools | `updatedToolOutput` also works and is passed through without schema validation; `updatedMCPToolOutput` is the older MCP-only field. | hooks#posttooluse-decision-control |
| Failed calls | PostToolUse runs after successful calls; failures fire PostToolUseFailure, whose `tool_response` is the error text. Whether a failure's output can be rewritten was not verified (probe P4). | hooks#posttooluse; hooks#posttoolusefailure |
| Interrupts | After `Ctrl+Enter` a PostToolUse hook has 10 s; after `Esc` it is cancelled at once. A redaction hook can therefore be skipped when the user presses `Esc` during a call. | hooks#posttooluse-after-an-interrupt |
| Paths not seen by Read hooks | Files referenced with `@` in a prompt are inserted without a tool call, so no Read hook fires; `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` turns the insertion off. Skill-injected shell commands bypass PreToolUse and fire PreSkillShellCommand instead. | hooks#pretooluse; hooks#preskillshellcommand |
| Subagents | Settings and plugin hooks also fire for subagent tool calls; the input carries `agent_id` and `agent_type`. | hooks#hook-locations; hooks#common-input-fields |
| Monitor | A PreToolUse hook with a Bash matcher also runs on Monitor commands; its allow and `updatedInput` have no effect there (a deny is not excluded). | hooks#match-monitor-commands |
| Config changes | ConfigChange fires when user, project or local settings or a skill file change, and `decision: "block"` keeps the change from applying to the running session. Changes saved through `/permissions` or "don't ask again" in the same session do not run the hook. | hooks#configchange |
| User prompt | UserPromptSubmit receives the submitted `prompt` and can block it or add context. | hooks#userpromptsubmit-input |
| Mods | A mod that handles `tool.check` answers after the PreToolUse hooks. Without managed settings and without a Team or Enterprise `/login`, such a mod can approve a call a PreToolUse hook blocked. | permissions#precedence-among-rules-hooks-and-mods |

### 1.2 Hook input fields per tool

Every event carries `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, and on tool events `tool_name`, `tool_input` and `tool_use_id`; PostToolUse adds `tool_response` and `duration_ms` (hooks#common-input-fields, hooks#posttooluse-input). For Write, Edit and Read, `file_path` is always absolute, with `~` and relative spellings expanded, and on Windows arrives with backslashes (hooks#pretooluse-input).

| tool | `tool_input` fields | notes |
|---|---|---|
| Bash | `command`, `description`, `timeout`, `run_in_background` | PostToolUse may carry `tool_response.bashEditDiff` (beta, best effort) |
| PowerShell | same as Bash | On Windows it is the primary shell; matchers must name `Bash|PowerShell` |
| Write | `file_path`, `content` | |
| Edit | `file_path`, `old_string`, `new_string`, `replace_all` | older sessions use `MultiEdit` (`edits[]`); keep it in the mapping |
| Read | `file_path`, `offset`, `limit` | |
| Glob | `pattern`, `path` | |
| Grep | `pattern`, `path`, `glob`, `output_mode`, `-i`, `multiline` | |
| WebFetch | `url`, `prompt`, `offset` | |
| WebSearch | `query`, `allowed_domains`, `blocked_domains`, `mode` | |
| Agent | `prompt`, `description`, `subagent_type`, `model` | older name `Task` is also matched |
| MCP tools | raw arguments; `tool_name` is `mcp__<server>__<tool>`; `mcp_server` gives `name` and `source` (v2.1.274+) | base trust on `source`, not on the name prefix |

### 1.3 Execution limits

- Default timeout is 600 s for command hooks (hooks#common-fields). A PreToolUse hook that times out or fails does not block the call unless the handler sets `onFailure: "block"` (v2.1.295+); an exit code other than 0 or 2 is a non-blocking error (hooks#timeouts, hooks#block-the-action-when-a-hook-fails). This matches dsh-guard's `failMode: open` by default and gives `failMode: closed` a native equivalent.
- Each matching handler is a new process per call; there is no persistent plugin process as in dsh. Startup cost is paid on every tool call that the matcher selects.

### 1.4 Plugin packaging versus settings.json

- A plugin declares hooks in `hooks/hooks.json` (an object with a top-level `"hooks"` key) or inline in `plugin.json`; the event map has the same shape as in settings (plugins-reference#hooks).
- Hook commands may use `${CLAUDE_PLUGIN_ROOT}` (the installed version, replaced on update; never write state there) and `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, kept across updates, deleted on uninstall unless `--keep-data`); both are also exported to the hook process, as are `userConfig` values as `CLAUDE_PLUGIN_OPTION_<KEY>` (plugins-reference#environment-variables, #user-configuration).
- Plugin hooks follow the same precedence as settings hooks (permissions#precedence-among-rules-hooks-and-mods). An identical handler defined in several settings files runs once, but a plugin's copy stays separate (hooks#hook-handler-fields), so the same guard must not be installed both ways.
- `plugin.json` `version` pins installs to that version, except for plugins loaded in place from a local-path marketplace; `engines.claude-code` declares the supported Claude Code range (v2.1.323+) (plugins-reference#version, #fields).

### 1.5 Transcripts for replay

- Every hook receives `transcript_path`; the file is written asynchronously and may lag the current turn (hooks#common-input-fields).
- The JSONL layout is not documented in the hooks reference. Observed on 2026-11-25 in `~/.claude/projects/<project key>/<session>.jsonl`: `assistant` lines whose `message.content` holds `tool_use` blocks (`id`, `name`, `input`); `user` lines with `tool_result` blocks (`tool_use_id`, `content`, `is_error`) plus a structured `toolUseResult`; each line also has `cwd`, `sessionId`, `timestamp`, `isSidechain` and `entrypoint`. Because the format is internal, the history reader must be tolerant and versioned (risk R4).

### 1.6 Probes before implementation

| id | question | why it matters |
|---|---|---|
| P1 | Does a PreToolUse `ask` prompt in an interactive `bypassPermissions` session? | If the ask is swallowed there, `ask` rules need another channel |
| P2 | Is an echoed `tool_response` with masked strings accepted as `updatedToolOutput` for Read, Grep, Glob, WebFetch, WebSearch and Agent, and does Claude see the masked text? | Redaction correctness; a shape mismatch is silently ignored |
| P3 | Does the transcript store the original or the rewritten output? | Secrets at rest, and replay of redact rules |
| P4 | Can PostToolUseFailure rewrite the error text? | Redaction of secrets echoed in error messages |
| P5 | p50/p95 latency of a Node command hook on Windows for a no-hit call | Whether matcher `*` is affordable (target under 150 ms p95) |
| P6 | When a large Bash result is saved to a file and replaced by a preview, is the rewrite applied before saving? | A later Read of that file is redacted again, but the file itself may hold the secret |
| P7 | Does UserPromptSubmit fire for text that is not typed by the user (cross-session messages, Remote Control)? | Integrity of the typed-code approval (section 4.2) |

## Probes

Run 2026-11-25 on Windows 11 with Claude Code 2.1.332, in a scratch project, with `claude -p --model haiku --setting-sources project --settings <scratch file> --strict-mcp-config --permission-mode bypassPermissions`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, and a probe hook (Node, exec form) on PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit and SessionStart. The probe masked a token `PROBE-SECRET-…` in every string leaf of `tool_response` and returned the copy as `updatedToolOutput`.

| id | result | consequence |
|---|---|---|
| P1 | dropped (amendment A2) | |
| P2 | Accepted and seen masked by the model for Read (`{type, file:{filePath, content, numLines, startLine, totalLines}}`), Bash (`{stdout, stderr, interrupted, isImage, noOutputExpected}`), Grep (`{mode, numFiles, filenames, content, numLines, totalLines}`), Glob (`{filenames, durationMs, numFiles, truncated, …}`, no content), WebSearch (`{query, results, …}`; the masked query showed in the model's text) and ToolSearch. WebFetch is not offered in this account's tool list and was not tested. Agent ran in the background by default (`{isAsync, status: "async_launched", agentId, prompt, outputFile, …}`): the rewrite of that launch record was accepted, but the subagent's answer arrived later as a `<task-notification>` prompt, not as a tool result, so the token reached the model unmasked. | The shape-preserving deep copy of section 3.1 works. Background subagent results are outside PostToolUse redaction (added to R3). |
| P3 | The transcript stores the rewritten output: 0 occurrences of the token after Read, Bash and Grep rewrites. | Redaction also keeps secrets out of the transcript, except in the cases of P4 and P6. |
| P4 | Negative. PostToolUseFailure receives the text as `error` (`Exit code 3
…`); `updatedToolOutput` there is ignored and the model and the transcript saw the token; only `additionalContext` is delivered. The documentation lists no rewrite field for this event. | A redact hit on a failed call is answered with `additionalContext` saying that the output matched rule `<id>`, could not be masked, and must not be repeated; logged `redact-failed`. |
| P5 | Node 24 process start alone: p50 37 ms, p95 38 ms; a Node process that loads the current (unbundled) engine with eight rules and evaluates one Bash call: p50 78 ms, p95 81 ms (30 runs each, Windows 11, warm cache). | Matcher `*` is affordable (target 150 ms p95); no daemon and no bundler needed. The plugin ships `dist/` plus the vendored `yaml`, as the dsh zip does. |
| P6 | For a 117 KB Bash output Claude Code passed the hook a 30,000-character `stdout` plus `persistedOutputPath` and `persistedOutputSize`, and showed the model a 2 KB preview. The masked preview was used, but the persisted file under `<config>/projects/<key>/<session>/tool-results/` kept both tokens unmasked, including one beyond the 30,000 characters the hook saw. | The PostToolUse hook also masks the persisted file in place (it is a program, not a tool call), reading the whole file rather than the truncated `stdout`. |
| P7 | Positive for automated text. A background subagent's report arrived as a UserPromptSubmit `prompt` beginning `<task-notification>` and carrying the subagent's `<result>`; the input has no field that tells typed from automated prompts. The documentation adds scheduled tasks and `/loop` iterations, whose prompt text Claude itself writes with CronCreate or ScheduleWakeup, and messages from other sessions, which arrive as plain text with sender and reply address. Not run live: cross-session messages and Remote Control (the probe session had no messaging socket). | Section 4.2's premise that Claude cannot produce a user prompt does not hold. The typed-code approval is changed (see 4.2 as amended below): the code is created by the guard's PostToolUse hook and shown to the user only, as `systemMessage`; the prompt must be exactly `guard approve <code>`; and the self-protection rule blocks every tool call whose input contains the phrase `guard approve`, which covers CronCreate, ScheduleWakeup, SendMessage, Agent prompts and shell commands. |
| P7a | A hook's `systemMessage` is not shown to the model (it reported only the `additionalContext`); it reaches the user (stream-json `system/informational` "PostToolUse:Bash says: …"), but it is recorded in the transcript as part of the hook's stdout. | The approval code is hidden from the model's context but not from a deliberate read of the transcript file; combined with the phrase block above, a code read that way still cannot be submitted by Claude. Residual risk in the D5 class. |

### 4.2 as amended by P7

`dsh-guard apply` drafts, tests and replays, then writes the pending change to the guard's state directory and prints its id; it prints no code. The guard's PostToolUse hook sees the call that ran `apply`, creates a random six-character code, stores only a salted SHA-256 of it in the pending entry, and returns the code to the user as `systemMessage` ("to apply rule … type: guard approve <code>"). The UserPromptSubmit hook accepts a prompt only if the whole trimmed prompt is `guard approve <code>` and the code hashes to a live pending entry (30 minutes); it then re-checks the target file's content hash, writes the file through `GuardAuthoring`, logs `authoring-<op>` with `approved-by: prompt`, deletes the entry, and lets the prompt through with `additionalContext` stating the outcome (the used code is worthless afterwards) and a `systemMessage` for the user. A wrong or expired code changes nothing and is answered the same way with the reason.

## End-to-end check

Run 2026-11-25 with Claude Code 2.1.332 on Windows 11: the release folder from `npm run pack:claude-code` loaded with `--plugin-dir` for each session only (no marketplace, no install), `claude -p --model haiku --setting-sources project --settings {} --strict-mcp-config --permission-mode bypassPermissions`, CLAUDE.md loading off, guard home, state and log in a scratch directory, the project-local Node 24 first on the session's `PATH`. Rules: a project-layer `block` on force pushes and `ask` on recursive deletes, a user-layer `warn` on reading `notes.txt` and `redact` on a synthetic token.

| session | prompt | result |
|---|---|---|
| 1 block | run `git push --force origin main` | Denied; the model quoted `Blocked by dsh-guard: [e2e.block-force-push] Force pushes are blocked by the e2e rule.` and did not retry. Logged `block`. |
| 2 ask, then override | delete `build-cache` with `rm -rf`; the prompt states the user's agreement | First call denied with the agreement text; the model repeated it as `rm -rf build-cache # guard: allow user explicitly asked to delete build-cache ...`, which ran (directory gone). Logged `ask`, then `override` with the reason. The rule has no `override: true`. |
| 3 warn and redact | Read `notes.txt`, then `cat secret.txt` | The Read ran with the notice `dsh-guard warning [e2e.warn-notes]: ...` beside it; the cat output reached the model as `token: [REDACTED:e2e.redact-secret]`; the session transcript holds 0 copies of the token. |
| 4 self-protection, plain request | edit `.dsh-guard/rules.yaml` from `block` to `warn` | The model made no edit attempt: following the plugin's SessionStart notice and skill, it ran `dsh-guard list` through the plugin's `bin/` launcher and proposed the propose/apply route instead. The file was unchanged. |
| 5 self-protection, explicit test | the same edit with the Edit tool, then with `sed -i` | Both denied by `dsh-guard.self-protect` with its message; file hash unchanged; two `self-protect` log records. |

The typed-code approval was not run in a headless session (the code reaches the user only, and `-p` has no user); it is covered by the unit tests in `test/claude-code.test.ts` and by a process-level run of `dsh-guard apply`, the PostToolUse hook and the UserPromptSubmit hook on scratch directories, in which the code appeared only in `systemMessage`, a wrapped and a wrong code were refused, the right code wrote the rule, and reusing it was refused. Measured with the built hook: p50 86 ms, p95 91 ms per PreToolUse call with five rules.

## 2. Architecture

### 2.1 Repository layout

Recommendation: one repository (the existing `dsh-guard` repo) converted to npm workspaces with three packages, one version, one test suite.

| package | contents | depends on |
|---|---|---|
| `core` | schema, loader and layering, engine, regex helpers, examples, authoring (`GuardAuthoring` with its approval callback), stats, log, the self-protection check with adapter-supplied targets, a `HistorySource` interface, the CLI framework | `yaml` only |
| `dsh` | the current `index.ts` and `authoring-tools.ts`, the dsh session-query history source, dsh protected paths (`$DSH_HOME` patches, `plugin_manager`), `cordis.patch.yml`, `guidance/authoring.md` | `core`, dsh peer packages |
| `claude-code` | hook entry points, Claude Code tool mapping additions, transcript history source, Claude Code protected paths, approval channels (typed code; external confirmation later), `.claude-plugin/plugin.json`, `hooks/hooks.json`, the authoring skill | `core` |

Two repositories would keep the dsh plugin untouched but would duplicate the engine or force a published core package with its own release cycle; with a single maintainer and lockstep changes, one repository is cheaper. The repository name is a separate decision (D6).

### 2.2 What in the current code is dsh-specific

| module (lines) | status | change |
|---|---|---|
| `index.ts` (229) | dsh only | moves to `dsh` unchanged |
| `authoring-tools.ts` (190) | dsh only (`defineTool`, `ctx.approval`, system-prompt guidance) | moves to `dsh`; the text helpers (`listText`, `NO_RULES_TEXT`) move to `core` because the CLI prints the same text |
| `history.ts` (114) | interface generic, implementation dsh (`SessionQueryLike`) | `HistorySource`, `History`, `HistoricCall` to `core`; `sessionHistory` to `dsh`; a new `transcriptHistory` in `claude-code` |
| `builtin.ts` (173) | mostly generic; dsh parts: `dshHome` patterns, `plugin_manager` check, `defaultDshHome` | `ProtectedPaths` gains `extraFiles`, `extraPatterns`, `extraChecks` supplied by the adapter; the reserved id prefix becomes `guard.` with `dsh-guard.` kept as an alias (D6) |
| `tools.ts` (142) | table of dsh tool names | the canonical table becomes the union of both harnesses' raw names (they do not collide: dsh uses `bash`, `edit`; Claude Code uses `Bash`, `Edit`) |
| `loader.ts` (283) | default directories `~/.dsh-guard`, `.dsh-guard/`, `.dsh-guard.local/`, `DSH_GUARD_HOME` | directory names and the home variable come from adapter options |
| `log.ts` (55) | default path under the user directory | path from options; record gains `harness`, `session`, `shadow` |
| `cli.ts` (247) | generic, except that `explain` accepts a dsh `tool/call` record | also accept a Claude Code hook input object; add the authoring subcommands |
| `core.ts`, `engine.ts`, `schema.ts`, `examples.ts`, `stats.ts`, `regex.ts`, `types.ts`, `authoring.ts` | generic | small schema additions (2.4) |

`GuardAuthoring.apply` already takes the approval as a callback (`ask: (prompt) => Promise<ApprovalAnswer>`), so the authoring logic needs no rework; only the channel differs per adapter.

### 2.3 Tool and field mapping

The dsh adapter already uses Claude-style argument names (`file_path`, `old_string`, `new_string`, `content`, `command`, `url`, `pattern`, `query`), so the canonical fields carry over unchanged.

| canonical | dsh raw tools | Claude Code raw tools | canonical fields |
|---|---|---|---|
| `shell` | `bash`, `pwsh`, `terminal_send` | `Bash`, `PowerShell` (and Monitor commands seen through a Bash matcher) | `command`, `workdir` |
| `edit` | `edit`, `apply_patch`, `str_replace_editor` (`str_replace`, `insert`) | `Edit`, `MultiEdit` (`edits[].new_string` joined into `new`), `NotebookEdit` | `path`, `old`, `new`, `patch` |
| `write` | `write`, `str_replace_editor` (`create`) | `Write` | `path`, `content` |
| `read` | `read`, `read_image`, `str_replace_editor` (`view`) | `Read` | `path` |
| `fetch` | `web_fetch` | `WebFetch` | `url` |
| `search` | `web_search`, `grep`, `glob` | `WebSearch`, `Grep`, `Glob` | `query` (from `query` or `pattern`), plus `path` for Grep and Glob |
| (raw) | `plugin_manager`, MCP tools | `Agent`, `Task`, `Skill`, `mcp__<server>__<tool>` | raw argument names |

Claude Code delivers Windows paths with backslashes; the existing `normalizePath` already converts them, and the self-protection comparison is already case-insensitive on Windows and macOS. For MCP calls the adapter adds a field `mcp_source` from `mcp_server.source`.

### 2.4 Shared rule files

- One rule format and one user rule directory serve both harnesses. Rules written against canonical tools apply in both; a rule naming a raw tool of one harness simply never matches in the other.
- Schema additions to the core, each generic rather than harness-specific: an optional `harness` field (`dsh`, `claude-code`, or a list; default both) for rules that only make sense in one workflow, such as rules for an unattended-job workflow; context fields `env.<NAME>` for an allow-listed set of environment variables (config `exposeEnv`, for example a job-marker variable), so rules can say `not_env.JOB_ID: '.'`; `agent_type` and `permission_mode` as fields; and a configurable list of override markers (`# guard: allow` and others) with an option to ignore overrides when a given variable is set, so unattended jobs cannot override.
- Where the user rules live is decision D3.

### 2.5 Runtime of the Claude Code hook

- One entry script, `${CLAUDE_PLUGIN_ROOT}/dist/hook.js <event>`, handles PreToolUse, PostToolUse, ConfigChange, UserPromptSubmit and SessionStart. It reads stdin, loads the rule set, evaluates, writes the decision, appends to the log and exits.
- Rule loading per call is cheap (a few YAML files), but the adapter keeps a compiled cache in `${CLAUDE_PLUGIN_DATA}` keyed by the layer files' paths and mtimes, mirroring dsh-guard's `reloadIntervalMs`. Regex compilation is cached in-process only, as the process lives for one call.
- Matchers: PreToolUse and PostToolUse with matcher `*` so that MCP and future tools are covered, subject to probe P5. If the latency is too high, the fallback is an `http` hook to a small local daemon that keeps the rules in memory; this adds a process to supervise and is not the first choice.
- The time budget (`timeBudgetMs`, 250 ms) and `failMode` keep their meaning; `failMode: closed` additionally sets `onFailure: "block"` on the handlers, which requires generating `hooks.json` at pack time (two variants) because the plugin file is static.
- Node.js: dsh-guard declares Node 24.9 or later, mainly for running the TypeScript sources directly; the built `dist/` may run on Node 22 LTS, but that is unverified, so plan for Node 24. A missing `node` on `PATH` makes the hook fail to start; see D1.

## 3. Actions and prompts

### 3.1 Mapping

| action | phase | Claude Code output | effect |
|---|---|---|---|
| `block` | pre_tool | `permissionDecision: "deny"`, reason `Blocked by guard: [<id>] <message>` (plus the override hint for overridable rules) | The call never runs; holds in every permission mode |
| `ask` | pre_tool | `permissionDecision: "ask"` with the reason, or, with an external confirmation channel, a hold for a confirmation that ends in no output (pass) or in a deny | One prompt or one confirmation per matching call; denied in headless runs |
| `warn` | pre_tool | `additionalContext` with `guard warning [<id>]: <message>` | The call runs; Claude sees the notice next to the result |
| observe (`warn` + `promote_to`) | either | `additionalContext` with the observe text that dsh-guard already uses | As `warn`; logged as would-have |
| `warn` | post_tool | PostToolUse `additionalContext` | As in dsh |
| `redact` | post_tool | PostToolUse `updatedToolOutput`: a deep copy of `tool_response` with every matching substring of every string leaf replaced by `[REDACTED:<id>]` | Claude sees the masked output; the tool's side effects and telemetry are unaffected |
| `block` | post_tool | `updatedToolOutput` with every string leaf replaced by the block message, plus `decision: "block"` and `reason` | Claude sees only the message; this reproduces dsh's "finished call becomes an error" |

### 3.2 Redaction when output cannot be rewritten

The documentation says `updatedToolOutput` works for built-in tools when the shape matches and for MCP tools without validation, so the shape-preserving deep copy (same keys, same types, only strings changed) is the primary method; probe P2 confirms it per tool. Where a rewrite is ignored or unavailable (a shape the copy cannot reproduce, PostToolUseFailure if P4 is negative, a Cowork session, an `Esc` interrupt), the adapter degrades in two steps rather than silently: (1) the hook verifies its own result by checking that the value it returns is structurally equal to the input apart from strings, and if not, (2) it returns `decision: "block"` with a reason stating that output matching rule `<id>` could not be masked and must not be repeated, and logs `redact-failed`. This does not hide the text from the model; for secrets that must never reach the model, the rule should be a pre_tool `block` on the read that would produce them (for example a Read of `.env` files), and the rule documentation should say so. Files inserted with `@` never pass a hook; the plugin's SessionStart hook can warn once when `CLAUDE_CODE_DISABLE_FILE_MENTIONS` is unset and redact rules exist.

### 3.3 Keeping prompts minimal

- Only `ask` rules prompt. `block`, `warn`, `redact` and observe-mode rules never do, and the guard never emits `allow`, so it neither adds nor removes Claude Code's own prompts.
- New rules are written in observe mode by default, as in dsh-guard, so a fresh rule causes notices, not prompts, until it is promoted.
- `askVia` (adapter option): `prompt` uses Claude Code's prompt; an external channel (not in the first release) would let an ask become a confirmation on a separate device or app instead of a terminal dialog. If P1 shows that an ask is swallowed in bypass mode, `prompt` is unusable there and such rules should be written as `block` with `override: true`.
- Headless runs (a configured job marker variable, `CLAUDE_CODE_SESSION_ATTENDED=0`, `CLAUDE_CODE_ENTRYPOINT=sdk-*`) never wait: an `ask` becomes a deny with the reason.
- Rule authoring approvals (section 4) are the only other source of interaction, and they use an external confirmation or a typed code, not a dialog.

## 4. Authoring without dsh tools

### 4.1 Conversation and CLI

The plugin ships a skill, `guard-authoring`, that replaces `guidance/authoring.md` and states the same procedure: ask about the boundary, recommend observe mode, draft with `examples.block` and `examples.pass`, test, replay, show the hits, and apply only after the user agreed. Claude writes the change request (the same JSON object the dsh tools take: `op`, `layer`, `rule`, `id`, `reason`, `mode`) to a file in the session scratchpad and runs the CLI:

| command | writes | does |
|---|---|---|
| `guard list [--layer L] [--observe]` | no | as `guard_list` |
| `guard draft --request F` | no | as `guard_draft` |
| `guard test --request F` | no | as `guard_test` |
| `guard replay --request F [--sessions N] [--project DIR\|--all]` | no | as `guard_replay`, over Claude Code transcripts: newest 200 sessions and 500 calls by default, project filter by the session's `cwd`, subagent (sidechain) calls included, post_tool rules only where a result was recorded |
| `guard apply --request F` | staging only | drafts, tests and replays again, writes the pending change and asks for approval (4.2) |
| `guard stats`, `guard explain`, `guard lint` | no | as today; `explain` also accepts a hook input object |
| `guard propose` | no | as `guard_propose` in the dsh adapter (draft, test and replay in one call) |

All commands print plain text designed to be quoted in the chat. The CLI refuses `apply` in a headless run.

### 4.2 Approval without a popup

`guard apply` computes the canonical YAML of the entry, a SHA-256 over target file, previous content hash and new entry, and a six-character code from it. It writes the pending change to `${CLAUDE_PLUGIN_DATA}/pending/<code>.json` and prints a summary (operation, id, layer, mode, action and `promote_to`, example results, replay counts, the code). Claude quotes the summary in the chat. Then one of two channels completes the change:

1. External confirmation (optional). Where an out-of-band device or app exists, `apply` can post the one-line summary (for example `add tools.no-npm-build user observe->block #4f2a91`) to it, wait for an allow or deny, and on allow write the file through `GuardAuthoring.apply`. The confirmation is bound to the code shown in the chat. This channel is not part of the first release.
2. Typed code (fallback everywhere). Without an external channel, or after a timeout, `apply` ends with "type `guard approve 4f2a91` to apply". The plugin's UserPromptSubmit hook recognizes a prompt that consists of exactly that line, loads the pending change, re-checks that the target file still has the recorded previous hash, writes the file, logs `authoring-add|modify|remove` with `approved-by: prompt`, deletes the pending entry, and replaces the prompt with context stating the outcome. Claude cannot produce a user prompt, so it cannot approve its own change. Pending entries expire after 30 minutes. Probe P7 must confirm that no automated path (cross-session messages, Remote Control) arrives as a UserPromptSubmit prompt; if one does, the hook must recognize and reject it.

Rejected alternative: routing the approval through Claude Code's own `ask` prompt. It would reintroduce the dialog the design avoids, and passing the approval from the hook to the CLI would need an unforgeable token that Claude cannot read, which a file on the same machine cannot provide.

### 4.3 Self-protection

The built-in rule (`guard.self-protect`, not overridable, not disableable) gets these Claude Code targets in addition to the generic ones (user, project and local rule directories, `extraRuleFiles`, the decision log, pack files):

- the installed plugin tree (`${CLAUDE_PLUGIN_ROOT}`, and the plugin cache directory under `~/.claude/plugins/`), `${CLAUDE_PLUGIN_DATA}` (pending changes and caches), and the plugin registry files under `~/.claude/plugins/`;
- `~/.claude/settings.json`, `~/.claude/settings.local.json`, and `.claude/settings.json` and `.claude/settings.local.json` of the session's project (they can disable the plugin, set `disableAllHooks`, or remove the hook entries);
- other guard or policy files of the same installation that must not be edited by the model (added per installation through `DSH_GUARD_PROTECT`);
- shell commands that disable or remove the plugin (`claude plugin disable|uninstall|remove` naming the guard), in addition to the existing write-verb test for shell commands naming protected paths.

Writes by programs that are not tool calls are not seen and need not be: a file-sync tool, `git pull`, or a script merging a worktree. Development of the guard should therefore happen in a checkout that is not the installed tree (section 5). A second line of defence is a ConfigChange hook on `user_settings`, `project_settings` and `local_settings` that blocks a change which disables the plugin or sets `disableAllHooks`, unless a pending approval for that change exists (same tap or typed-code channel). As in dsh-guard, regex protection sees text, not intent: a script that writes a rule file indirectly passes. D5 covers an optional signed manifest that closes this gap.


## 5. Distribution

- Package contents. The Claude Code plugin folder holds `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/guard-authoring/SKILL.md`, `dist/` and the vendored `yaml`, `README.md` and `LICENSE`. It ships no rules, exactly as dsh-guard does; with no rules, every call passes except those stopped by self-protection, and `list` says so.
- Clean export. `scripts/export.ts` and `pack.ts` scan the tree for leftovers (absolute home paths, email addresses, YAML outside the fixtures, ids and regexes of private rules). A private pattern file, kept outside the repository and named by the maintainer, lists further strings that must never ship.
- Personal rules. User rules live in a user-chosen directory (`DSH_GUARD_HOME`, default `~/.dsh-guard`) and stay out of this repository; sync them between machines with whatever tool you already use. The directory is protected on each machine; a sync tool writes it as a program, which the guard does not see.
- Install. A directory marketplace pointing at a checkout would load the plugin in place, unpinned, and would make the development tree the protected tree; instead `pack` writes a versioned release folder outside the checkout, or a marketplace on a Git repository with release tags is used.
- Versioning. One semantic version for the repository, used by all three packages and by `plugin.json`; the rule file format keeps its own `version: 1`, and the core refuses a higher major. `engines.claude-code` is set to the oldest version with every feature used (`onFailure` from v2.1.295, `mcp_server` from v2.1.274; `engines` itself needs v2.1.323, so the floor is `>=2.1.323`); `engines.dsh` stays as it is. A change of hook protocol behaviour (for example a new probe result) is a minor version; a schema change that old engines cannot load is a major version.

## 6. Risks and open decisions

| id | risk or decision | recommendation |
|---|---|---|
| D1 | Node.js must be on `PATH` wherever the hook runs. A missing `node` makes the hook fail to start, which without `onFailure` means every call passes. | Require Node 24; the SessionStart hook warns in the session when the guard cannot run. Do not port the engine to Python: two engines would drift and the regex dialects differ. |
| D2 | Scope of the first release: authoring and rule migration, or the engine only. | Ship engine, hooks, CLI and self-protection first, with the typed-code approval; add an external confirmation channel later. |
| D3 | Location of user rules. | One user directory shared by both harnesses, with `harness:` on workflow-specific rules. |
| D4 | `askVia` per installation. | `prompt` by default, revisited after P1. |
| D5 | Regex self-protection can be bypassed by indirect writes (a script, an interpreter one-liner). | Accept for the first release, as in dsh-guard. Optional hardening later: a separate trusted host signs the hash of each approved rule file with an Ed25519 key that never leaves it, and the hook loads only files with a valid signature, falling back to the last signed copy. |
| D6 | Names: repository, rule id prefix, user directory. | Keep the repository name `dsh-guard` for now; name the packages neutrally (`guard-core`, `guard-dsh`, `guard-claude-code`); reserve `guard.` as the built-in prefix with `dsh-guard.` as an alias. Revisit the repository name once both adapters are stable. |
| D7 | Distribution channel. | A marketplace on a Git repository with tags; a local release folder only for testing. |
| R1 | Latency: one Node process per tool call with matcher `*`. | Measure (P5); if p95 exceeds about 150 ms, narrow the matchers at pack time to the tools named by loaded rules plus self-protection's tools, before considering a daemon. |
| R2 | A mod handling `tool.check` could approve calls the guard denies when no managed settings are in force and the login is neither Team nor Enterprise. | Keep it in mind when installing mods; the SessionStart hook can list installed mods that handle `tool.check`. |
| R3 | Redaction is weaker than in dsh: `@` mentions, interrupts, failed calls (P4) and background subagent results delivered as task notifications (P2) are outside its reach; the transcript at rest holds the masked text (P3), and persisted large outputs are masked in place (P6). | Document that secrets are protected by pre_tool blocks on reads, with redact as a second layer; set `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` if redact rules guard secrets. |
| R4 | The transcript format is internal and may change. | A tolerant reader with a format probe on the newest file; replay reports "history unavailable" instead of failing. |
| R5 | The typed-code approval depends on UserPromptSubmit carrying only user-typed text. | Run P7 before enabling it; until then an external channel would be the only approval path. |
