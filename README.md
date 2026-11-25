# dsh-guard

dsh-guard is a plugin for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`) that checks every tool call the agent makes against declarative rules. A rule names a tool, gives regular expressions over the call's input or output, and states what happens on a match: the call is blocked, the user is asked first, the model receives a warning, or matching text in the tool output is masked before the model sees it. Rules live in YAML files; the plugin ships three packs (destructive shell commands, git, credentials), and every user or project adds its own.

Tested against `@deepseek-ai/dsh` 0.2.2-rc.5 on Node.js 24.

## How it hooks into dsh

dsh runs each tool call through a fixed pipeline (`docs/tool-execution-pipeline.md` in the dsh package). dsh-guard maps its four actions onto it:

| action | pipeline seam | effect |
|---|---|---|
| `block` | `tools/pre-execute` denial plus a monotonic guard (`ctx.tools.guard`) | The tool body never runs; the model receives `Error: Blocked by dsh-guard: [rule] message`. No other plugin can turn the guard's denial back into an allow. |
| `ask` | `tools/pre-execute` returns `ask`, resolved by `ctx.approval` | The user approves once or the call is denied. Without an approval channel (for example `dsh headless`) the call is denied. |
| `warn` | `additionalContexts` on `tools/post-execute` | The call runs; a notice from `dsh-guard` is added after the tool result. |
| `redact` | `tools/post-execute` content replacement | Every match in the tool output is replaced with `[REDACTED:<rule id>]`. |

A `block` in the `post_tool` phase turns a finished call into an error whose content is the rule message, so the output never reaches the model. Exact signatures and source references are in [docs/dsh-api-notes.md](docs/dsh-api-notes.md).

## Install

The package is not published yet. Build it from a checkout:

```sh
npm install
npm run build
```

Then add a row to a profile overlay, for example `$DSH_HOME/profiles/tui/cordis.patch.yml`, or pass a file with `dsh tui --patch guard.yml`:

```yaml
- insert:
    - id: dsh-guard
      name: '/absolute/path/to/dsh-guard/dist/index.js'
      config:
        failMode: open
```

The module path must be absolute. All configuration fields are optional:

| field | default | meaning |
|---|---|---|
| `failMode` | `open` | On an internal error or an exhausted time budget, `open` lets the call pass and `closed` denies it. Both are logged. |
| `timeBudgetMs` | `250` | Evaluation budget per call and phase. Rules not reached within the budget are skipped (`open`) or the call is denied (`closed`). |
| `maxFieldChars` | `100000` | Longer fields are matched on their first and last halves of this size. Under `closed`, a pre-execute check on a truncated field denies. |
| `logPath` | `~/.dsh-guard/log.jsonl` | Decision log; an empty string disables it. |
| `userDir` | `~/.dsh-guard` | User rule directory; an empty string skips the user layer. `DSH_GUARD_HOME` changes the default. |
| `packs` | `[safety, git, secrets]` | Bundled packs to load, by name or absolute path. |
| `extraRuleFiles` | `[]` | Rule files loaded after all layers. |
| `cwd` | process directory | Project directory used when the session's working directory is unknown. |
| `reloadIntervalMs` | `2000` | Rule files are re-read when they change, checked at most this often; `0` disables reloading. |
| `disableLayers` | `[user, local]` | Layers whose files may disable an earlier rule. |
| `checkLayers` | `[bundled, user, local, extra]` | Layers whose files may name `check` hooks, which execute code. |

## Rules

A rule file is a YAML list of rules, or a mapping with a `rules` list (and an optional `version`).

```yaml
rules:
  - id: team.deploy-prod
    doc: Production deploys go through the release checklist.
    tool: shell
    match:
      command: '(?i)\bdeploy\b.*\bprod(uction)?\b'
    action: ask
    override: true
    message: Production deploy; confirm the release checklist is done.
    examples:
      block:
        - ./deploy.sh production
      pass:
        - ./deploy.sh staging
        - './deploy.sh prod # guard: allow user started the release'

  - id: team.env-files
    tool: read
    match:
      path: '(^|/)\.env$'
      not_path: '/fixtures/'
    action: block
    message: Ask the user for the value instead of reading .env.
    examples:
      block: [.env, app/.env]
      pass: [test/fixtures/.env]

  - id: team.mask-internal-tokens
    when: post_tool
    tool: any
    match:
      output: 'itk_[A-Za-z0-9]{32}'
    action: redact
    message: Internal token masked.
    examples:
      block: ['token itk_0123456789abcdef0123456789abcdef']
      pass: ['no token here']
```

| field | required | meaning |
|---|---|---|
| `id` | yes | Unique name: letters, digits, `.`, `_`, `-`. A later file with the same id overrides the rule (see Layers). |
| `doc` | no | Why the rule exists. |
| `when` | no | `pre_tool` (default) checks the call before it runs; `post_tool` checks the result. |
| `tool` | no | A canonical tool, a raw dsh tool name, a list of either, or `any` (default). |
| `match` | no | Field name to regex, or to a list of regexes of which any may match. All listed fields must match. A `not_<field>` key excludes calls whose field matches. An empty `match` fires on every call of the tool. |
| `action` | yes | `block`, `ask` or `warn` before execution; `block`, `warn` or `redact` after. |
| `message` | no | Text shown to the model (and in the approval prompt). |
| `override` | no | When `true`, a shell command containing `# guard: allow <reason>` passes this rule. Default `false`. |
| `examples` | no | `block:` calls the rule must fire on, `pass:` calls it must not fire on. Checked by `dsh-guard test`. |
| `check` | no | `<module>:<function>`, a synchronous hook that must also return true (or `{ hit: true, message }`) for the rule to fire. A relative module path is resolved from the rule file. |
| `disabled`, `reason` | no | Disable an earlier rule with the same id; a reason is required. |

Regexes use JavaScript syntax. A leading `(?i)` makes the whole pattern case-insensitive. In YAML, single-quoted strings keep backslashes literal; a single quote inside is written `''`.

### Tools and fields

dsh tool names differ by platform and composition, so rules usually name a canonical tool. Each call exposes its raw arguments under their own names plus the canonical fields below. Paths are normalized to forward slashes.

| canonical | dsh tools | canonical fields |
|---|---|---|
| `shell` | `bash`, `pwsh`, `terminal_send` | `command`, `workdir` |
| `edit` | `edit`, `apply_patch`, `str_replace_editor` (`str_replace`, `insert`) | `path`, `old`, `new`, `patch` |
| `write` | `write`, `str_replace_editor` (`create`) | `path`, `content` |
| `read` | `read`, `read_image`, `str_replace_editor` (`view`) | `path` |
| `fetch` | `web_fetch` | `url` |
| `search` | `web_search`, `grep`, `glob` | `query` |

Every call also has `cwd`, the session's working directory, and post_tool rules see `output`, the text of the tool result. Any other tool, for example an MCP tool, is matched by its raw name and raw argument names.

### Examples

A string example stands for the primary field of the rule's first tool: the command of a shell rule, the path of a read, write or edit rule, the URL of a fetch rule, or the output of a post_tool rule. A mapping is either the input of that tool (`{ file_path: a.ts, content: ... }`) or a full call (`{ tool: pwsh, input: { command: ... }, output: ..., cwd: ... }`). Examples run with override comments honoured, so an overridden command belongs under `pass`.

## Layers

Rule files are read in this order; within a directory, files load in name order:

1. bundled packs (`packs/safety.yaml`, `packs/git.yaml`, `packs/secrets.yaml`)
2. user: `~/.dsh-guard/*.yaml`
3. project: `<cwd>/.dsh-guard/*.yaml`
4. local: `<cwd>/.dsh-guard.local/*.yaml`, meant to stay out of version control
5. `extraRuleFiles` from the plugin config

`<cwd>` is the working directory of the session making the call, so one dsh process applies the right project rules to each session.

A rule whose id already exists is an override, and overrides may only tighten:

- `action` may rise along `warn < ask < block` (and `redact < block` after execution), never fall.
- `override` may change from `true` to `false`, never the reverse.
- `when`, `tool`, `match` and `check` cannot change; a different scope needs a new id.
- `message` and `doc` may change; `examples` are appended.
- `disabled: true` with a `reason` switches a rule off. Only the layers in `disableLayers` (user and local by default) may do this, because project files arrive with whatever repository you open.

A rejected override is reported as a warning and the earlier rule stays in force. A file that does not parse, or a rule that fails validation, is skipped and reported; dsh keeps running. `check` hooks run code, so by default they are refused from the project layer.

## Override comment

For rules with `override: true`, a shell command may carry the comment `# guard: allow <reason>`:

```sh
git push --force origin feature # guard: allow user asked to replace the branch
```

The rule then lets the call pass, and the log records `override` with the reason. A comment without a reason has no effect, and rules with `override: false` cannot be passed this way. The block message tells the model about the comment only for overridable rules, and only for use when the user explicitly asked for the exception.

## Log

Each decision appends one JSON line to the log: `time`, `rule`, `verdict` (`block`, `ask`, `warn`, `redact`, `override`, `ask-allowed`, `ask-denied`, `budget-exceeded-open|closed`, `internal-error-open|closed`), `tool`, `summary` (the primary field, one line, capped), `cwd`, and `callId` and `reason` where they apply.

## Command line

```sh
dsh-guard test                 # run every rule's examples; exit 1 on a mismatch or a load error
dsh-guard lint                 # schema, regexes, overrides, risky patterns; exit 1 on errors or warnings
dsh-guard explain '{"tool": "bash", "input": {"command": "git push -f"}}'
dsh-guard explain '{"tool": "read", "input": {"file_path": "x"}, "output": "sk-..."}'
```

`explain` lists each field it extracted, each rule of the phase with its result, the final verdict, and the masked output of redact rules. It also accepts a dsh `tool/call` record (`{"name": ..., "arguments": "<json string>"}`). Options: `--cwd <dir>` selects the project, `--no-user` skips `~/.dsh-guard`, `--user-dir <dir>`, `--packs a,b`, `--rules <file>` (repeatable), and `--phase pre_tool|post_tool` for `explain`.

## Development

```sh
npm run typecheck
npm test                  # unit tests: loader, layering, matcher, actions, plugin wiring
npm run test:integration  # boots dsh headless with a scripted model adapter; no API key needed
npm run guard:test        # dsh-guard test on the bundled packs
npm run guard:lint
```

Sources run directly on Node.js 24 type stripping; `npm run build` emits `dist/` for dsh.

## Limitations

- Regex rules see text, not intent: a command assembled from variables, an alias or a script file passes a command pattern. The packs are a safety net for an agent's mistakes, not a sandbox; keep dsh's own sandbox and approval policy on.
- `run_code` (PTC mode) is checked as one call, and its sub-calls are checked individually; warnings are not delivered for sub-calls because dsh omits their additional context.
- A post-execute listener that replaces a result's canonical `value` hides the rendered content from redact and post_tool rules.
- The time budget is checked between rules; one slow regex is not interrupted. `dsh-guard lint` warns about nested quantifiers.
- `check` hooks must be synchronous.
