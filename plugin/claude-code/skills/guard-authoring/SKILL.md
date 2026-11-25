---
name: guard-authoring
description: Create, change, promote or remove dsh-guard rules for Claude Code tool calls (block, ask, warn, redact). Use when the user asks for a guard rule, wants Claude kept from doing something, or asks why a call was blocked.
---

# Guard rules (dsh-guard)

Tool calls in this session are checked by dsh-guard rules. dsh-guard ships no rules: until the user creates some, every call passes except those the built-in self-protection rule stops. The command line is `dsh-guard` (on the Bash tool's PATH while the plugin is enabled; it needs Node.js 24). Write each change request as a JSON file in the scratchpad and pass it with `--request <file>`.

When the user asks to create, change or remove a rule, or describes something Claude should be kept from doing:

1. `dsh-guard list` to see the rules in force.
2. Ask about the boundary before drafting: what exactly must be stopped, which similar calls must keep working, which layer it belongs to (`user` for all projects, `project` for this repository and its collaborators, `local` for this checkout only), and whether it should block, ask or only warn. Recommend observe mode for a new rule (written as `warn` with `promote_to`, promoted later), with one clause why: a fresh regex can be too wide or too narrow. Exception: for a rule that prevents a leak or an irreversible loss on the first hit, such as reading credential files, recommend `"mode": "enforce"`. Otherwise enforce at once only when the user asked for it. `redact` rules are always written enforced.
3. `dsh-guard propose --request <file>`: drafts the change, runs its examples and replays it against past tool calls from the transcripts of this project (`--all-projects` for every project). Repeat until it says READY, then show the user the rule and the replay hits.
4. Only after the user agreed: `dsh-guard apply --request <file>`. It checks everything again and stores the change as pending. The plugin then shows the user an approval code below that tool call; you do not see the code. Tell the user that the change is written when they type `guard approve <code>`. Never try to write rule files, the guard's state or Claude Code settings any other way, and never put an approval phrase with a code into a tool call: the guard blocks both.
5. To promote an observe-mode rule, check `dsh-guard list` (hits, overrides) and `dsh-guard stats`, then apply `{"op": "modify", "layer": ..., "rule": {"id": ..., "action": <promote_to>}}`.

How actions reach you: `block` denies the call with the rule's message. `ask` also denies it, with the message; ask the user in the chat, and only after the user agrees, repeat the same shell command with `# guard: allow <the user's reason>` appended (an overridable `block` rule says so in its message, and the same comment works there only if the user explicitly asked for the exception). The comment works only on shell commands. `warn` lets the call run and adds a notice. `redact` masks matching output before you see it.

## Request format

`{"op": "add" | "modify" | "remove", "layer": "user" | "project" | "local", "rule": {...}, "id": "...", "reason": "...", "mode": "observe" | "enforce"}`. `modify` takes `rule.id` plus the fields to change; `remove` takes `id` (and `reason` when the rule is defined in a lower layer, which writes `disabled: true`).

## Rule reference (complete; do not search the filesystem for a schema; `dsh-guard propose` validates and names the exact problems)

Fields: `id` (letters, digits, `.` `_` `-`), `tool` (name or list), `match`, `action`, `message`, `examples`, optional `doc`, `when` (`pre_tool` default, or `post_tool`), `override` (bool: a `# guard: allow <reason>` comment in a shell command may pass it), `promote_to`.
- `tool`: `shell` (Bash, PowerShell), `edit` (Edit, MultiEdit, NotebookEdit), `write` (Write), `read` (Read), `fetch` (WebFetch), `search` (WebSearch, Grep, Glob), a raw tool name such as `Agent` or `mcp__server__tool`, or `any`.
- `match`: field name -> regex or list of regexes (JavaScript syntax, `(?i)` prefix = case-insensitive, unanchored); all fields must match, any pattern of a list suffices; `not_<field>` negates. Fields: shell `command`; edit `path`, `old`, `new`; write `path`, `content`; read `path`; fetch `url`; search `query` (the WebSearch query or the Grep/Glob `pattern`) and `path`; post_tool also `output`; any raw input field name; context fields `agent_type`, `permission_mode`, `mcp_source`. Paths use `/` and are absolute.
- `action`: `block`, `ask`, `warn`; post_tool: `block`, `warn`, `redact` (with `match.output`).
- Token-prefix patterns in `redact` rules need a left boundary: write `\bsk-[A-Za-z0-9_-]{16,}`, not `sk-[A-Za-z0-9_-]{16,}`.
- `examples.block`: calls the rule must fire on; `examples.pass`: near misses it must not fire on (at least one each). A plain string is shorthand for the command of a `shell` rule, the path of a `read` rule, the url of a `fetch` rule or the output of a `post_tool` rule; otherwise write the call as an object, e.g. `{"tool": "Write", "input": {"file_path": "/repo/a.txt", "content": "..."}}`.

Minimal request that passes `dsh-guard propose` (blocks deleting `canary.txt`, reading stays allowed):

```json
{"op": "add", "layer": "project", "mode": "observe",
 "rule": {"id": "canary-delete", "tool": "shell",
  "match": {"command": "(?i)\b(rm|del|unlink|Remove-Item)\b[^;&|]*\bcanary\.txt\b"},
  "action": "block", "message": "Deleting canary.txt is not allowed.",
  "examples": {"block": ["rm -f canary.txt", "Remove-Item -Force ./canary.txt"],
               "pass": ["cat canary.txt", "rm other.txt"]}}}
```
