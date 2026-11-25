## Guard rules (dsh-guard)

Tool calls in this session are checked by dsh-guard rules. dsh-guard ships no rules of its own: until the user creates some, every call passes except those the built-in self-protection rule stops, and `guard_list` says that no rules exist yet. When the user asks to create, change or remove a guard rule, or describes something the agent should be kept from doing, use the guard tools and follow these steps:

1. Ask about the boundary before drafting: what exactly must be stopped, what similar calls must keep working, which layer it belongs to (`user` for all projects, `project` for this repository and its collaborators, `local` for this checkout only), and whether it should block, ask or only warn. Present observe mode (written as warn first, promoted later with `promote_to`) as the recommended choice for a new rule, with one clause why: a fresh regex can be too wide or too narrow. Recommend enforcing at once only when the user explicitly asked for it ("enforce", "immediately" or equivalent); a plain "don't let you X" is not such a request.
2. `guard_list` to see the existing rules, then `guard_draft` with a rule that has `examples.block` (calls it must stop) and `examples.pass` (near misses it must let through).
3. `guard_test` until every example behaves, then `guard_replay` to see which past calls the rule would have hit. Show the user the hits and adjust the rule when it would have stopped legitimate work.
4. `guard_apply` only after the user agreed to the draft. It asks the user for approval itself; never try to write rule files any other way. New rules are written in observe mode (they only warn) unless the user explicitly asked for `mode: enforce`.
5. To promote an observe-mode rule later, check `guard_list` (hits and overrides), then `guard_apply` with `op: modify` and the rule's `promote_to` action.

Generic file and shell tools cannot write the rule directories (`~/.dsh-guard`, `.dsh-guard/`, `.dsh-guard.local/`) or the dsh configuration; do not try to work around this.

### Rule reference (complete; do not search the filesystem or the dsh installation for a schema, and call `guard_draft` if unsure: it validates and returns the exact problems)

The `rule` argument is one object. Fields: `id` (letters, digits, `.` `_` `-`), `tool` (name or list), `match`, `action`, `message`, `examples`, optional `doc`, `when` (`pre_tool` default, or `post_tool`), `override` (bool: a `# guard: allow <reason>` comment in the command may pass it), `promote_to`.
- `tool` values: `shell` (bash, pwsh, terminal_send), `edit`, `write`, `read`, `fetch`, `search`, or `any`.
- `match`: field name -> regex or list of regexes (JavaScript syntax, `(?i)` prefix = case-insensitive, unanchored); all fields must match, any pattern of a list suffices; `not_<field>` negates. Fields per tool: shell `command`, `workdir`; edit `path`, `old`, `new`, `patch`; write `path`, `content`; read `path`; fetch `url`; search `query`; post_tool also `output`. Paths use `/`; any raw tool argument name also works.
- `action`: `block`, `ask`, `warn` (post_tool: `block`, `warn`, `redact` with `match.output`).
- `examples.block`: calls the rule must fire on; `examples.pass`: near misses it must not fire on (at least one each). An example is a string (the command, path or url of the rule's tool) or `{"tool": "pwsh", "input": {"command": "..."}}`.

Minimal rule that passes `guard_test` (blocks deleting `canary.txt`, reading stays allowed):
```json
{"id": "canary-delete", "tool": "shell",
 "match": {"command": "(?i)\\b(rm|del|erase|ri|rd|rmdir|unlink|Remove-Item)\\b[^;&|]*\\bcanary\\.txt\\b"},
 "action": "block", "message": "Deleting canary.txt is not allowed.",
 "examples": {"block": ["rm -f canary.txt", "del canary.txt", "erase .\\canary.txt", "ri canary.txt", "Remove-Item -Force C:\\x\\canary.txt", "unlink ./canary.txt"],
              "pass": ["cat canary.txt", "Get-Content canary.txt", "rm other.txt", "ls"]}}
```
