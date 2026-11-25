## Guard rules (dsh-guard)

Tool calls in this session are checked by dsh-guard rules. dsh-guard ships no rules of its own: until the user creates some, every call passes except those the built-in self-protection rule stops, and `guard_list` says that no rules exist yet. When the user asks to create, change or remove a guard rule, or describes something the agent should be kept from doing, use the guard tools and follow these steps:

1. `guard_list` to see the existing rules.
2. Ask about the boundary before drafting: what exactly must be stopped, what similar calls must keep working, which layer it belongs to (`user` for all projects, `project` for this repository and its collaborators, `local` for this checkout only), and whether it should block, ask or only warn. Present observe mode (written as warn first, promoted later with `promote_to`) as the recommended choice for a new rule, with one clause why: a fresh regex can be too wide or too narrow. Exception: for a rule whose purpose is to prevent a leak or an irreversible loss on the first hit, such as reading credential or secret files, recommend `mode: enforce`, because in observe mode the first hit already leaks or destroys. Otherwise recommend enforcing at once only when the user explicitly asked for it ("enforce", "immediately" or equivalent); a plain "don't let you X" is not such a request. `redact` rules are always written enforced, since in observe mode they would mask nothing.
3. `guard_propose` with a rule that has `examples.block` (calls it must stop) and `examples.pass` (near misses it must let through). It drafts, runs the examples and replays the rule against past calls in one call. Repeat it until it says READY, then show the user the rule and the replay hits, and adjust the rule when it would have stopped legitimate work. (`guard_draft`, `guard_test` and `guard_replay` run the three checks separately; they are not needed when `guard_propose` is used.)
4. `guard_apply` with the same arguments, only after the user agreed to the proposal. It checks everything again and asks the user for approval itself; never try to write rule files any other way. If it reports that the approval was rejected or not shown, tell the user the reason it gives (for example, an approval policy set to never ask must be switched to ask for this change).
5. To promote an observe-mode rule later, check `guard_list` (hits and overrides), then `guard_apply` with `op: modify` and the rule's `promote_to` action.

Generic file and shell tools cannot write the rule directories (`~/.dsh-guard`, `.dsh-guard/`, `.dsh-guard.local/`) or the dsh configuration; do not try to work around this.

### Rule reference (complete; do not search the filesystem or the dsh installation for a schema, and call `guard_propose` if unsure: it validates and returns the exact problems)

The `rule` argument is one object. Fields: `id` (letters, digits, `.` `_` `-`), `tool` (name or list), `match`, `action`, `message`, `examples`, optional `doc`, `when` (`pre_tool` default, or `post_tool`), `override` (bool: a `# guard: allow <reason>` comment in the command may pass it), `promote_to`.
- `tool` values: `shell` (bash, pwsh, terminal_send), `edit`, `write`, `read`, `fetch`, `search` (web_search, grep, glob), a raw dsh tool name such as `grep`, or `any`.
- `match`: field name -> regex or list of regexes (JavaScript syntax, `(?i)` prefix = case-insensitive, unanchored); all fields must match, any pattern of a list suffices; `not_<field>` negates. Fields per tool: shell `command`, `workdir`; edit `path`, `old`, `new`, `patch`; write `path`, `content`; read `path`; fetch `url`; search `query` (web_search queries, grep and glob `pattern`) and, for grep and glob, `path`; post_tool also `output`. Paths use `/`; any raw tool argument name also works.
- `action`: `block`, `ask`, `warn` (post_tool: `block`, `warn`, `redact` with `match.output`).
- Token-prefix patterns in `redact` rules need a left boundary (`\b` or a lookbehind such as `(?<![A-Za-z0-9_-])`): `sk-[A-Za-z0-9_-]{16,}` alone also matches inside `desk-lamp-controller-service`; write `\bsk-[A-Za-z0-9_-]{16,}`.
- `examples.block`: calls the rule must fire on; `examples.pass`: near misses it must not fire on (at least one each). A plain string is shorthand only where one field is meant: the command of a `shell` (or `any`) rule, the path of a `read` rule, the url of a `fetch` rule, the output of a `post_tool` rule. For `write`, `edit` and search tools (`search`, `grep`, `glob`, `web_search`) a string is an error; write the call as an object, e.g. `{"tool": "grep", "input": {"pattern": "token", "path": "~/.ssh/id_rsa"}}`, `{"tool": "write", "input": {"file_path": "a.txt", "content": "..."}}`, `{"tool": "pwsh", "input": {"command": "..."}}`.

Minimal rule that passes `guard_propose` (blocks deleting `canary.txt`, reading stays allowed):
```json
{"id": "canary-delete", "tool": "shell",
 "match": {"command": "(?i)\\b(rm|del|erase|ri|rd|rmdir|unlink|Remove-Item)\\b[^;&|]*\\bcanary\\.txt\\b"},
 "action": "block", "message": "Deleting canary.txt is not allowed.",
 "examples": {"block": ["rm -f canary.txt", "del canary.txt", "erase .\\canary.txt", "ri canary.txt", "Remove-Item -Force C:\\x\\canary.txt", "unlink ./canary.txt"],
              "pass": ["cat canary.txt", "Get-Content canary.txt", "rm other.txt", "ls"]}}
```
