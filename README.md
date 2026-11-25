# dsh-guard

dsh-guard is a plugin for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`) that checks every tool call the agent makes against declarative rules. A rule names a tool, gives regular expressions over the call's input or output, and states what happens on a match: the call is blocked, the user is asked first, the model receives a warning, or matching text in the tool output is masked before the model sees it. Rules live in YAML files. The plugin ships no rules: after installation every call passes, except those the built-in self-protection rule stops, until the user creates rules, usually by describing them to the agent in a conversation (see Authoring rules in conversation).

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

## Empty default

dsh-guard starts with an empty rule set. It loads no packs, and the user and project rule directories do not exist until a rule is written. In this state:

- every tool call passes, except calls stopped by the built-in rule `dsh-guard.self-protect` (see Self-protection), which keeps the agent from editing guard rules and configuration behind the user's back;
- `guard_list` states that no rules exist yet and that the user can describe in the conversation what should be guarded;
- the first rule is created like any other: the user describes the boundary, the agent drafts, tests and replays the rule and writes it with `guard_apply` after the user approves.

Rules can also be written by hand into the rule directories (see Layers), or shared as rule files and loaded through the `packs` key.

## Install

The package is not published yet. Build it from a checkout:

```sh
npm install
npm run build
```

The package is a dsh bundle (`dsh.bundle` in `package.json`, layer `cordis.patch.yml`), so it can be installed into a profile. `dsh plugin` runs pnpm, which must be on `PATH`:

```sh
dsh plugin --profile tui add /path/to/dsh-guard
```

This links the checkout, appends `dsh-guard` to the profile's bundles and mounts the row `dsh-guard` with the default configuration; override its `config` in the profile's own `cordis.patch.yml`. Alternatively, add a row to a profile overlay, for example `$DSH_HOME/profiles/tui/cordis.patch.yml`, or pass a file with `dsh tui --patch guard.yml`:

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
| `packs` | `[]` | Rule files or directories of rule files, loaded first, below the user layer; for rule sets shared between users. The plugin ships none. |
| `extraRuleFiles` | `[]` | Rule files loaded after all layers. |
| `cwd` | process directory | Project directory used when the session's working directory is unknown. |
| `reloadIntervalMs` | `2000` | Rule files are re-read when they change, checked at most this often; `0` disables reloading. |
| `disableLayers` | `[user, local]` | Layers whose files may disable an earlier rule. |
| `checkLayers` | `[packs, user, local, extra]` | Layers whose files may name `check` hooks, which execute code. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | DSH home whose configuration files the self-protection rule guards. |

## Rules

A rule file is a YAML list of rules, or a mapping with a `rules` list (and an optional `version`). The two rules below illustrate the format; they are documentation only and are not shipped.

```yaml
rules:
  - id: example.force-push
    doc: Force push without lease rewrites remote history.
    tool: shell
    match:
      command: '\bgit\b[^;&|]*\bpush\b[^;&|]*(--force(?!-with-lease)\b|\s-[A-Za-z]*f[A-Za-z]*\b)'
    action: ask
    override: true
    message: Force push rewrites remote history; prefer --force-with-lease.
    examples:
      block:
        - git push --force origin main
        - git push -f
      pass:
        - git push --force-with-lease origin feature
        - git push origin main
        - 'git push -f origin feature # guard: allow user asked to replace the branch'

  - id: example.mask-internal-tokens
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
| `promote_to` | no | Marks a `warn` rule as an observe-mode rule: the action (`block`, `ask` or `redact`) it is meant to take once promoted. Ignored when `action` is not `warn`. |

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

1. packs: the files and directories listed in the `packs` config key, none by default
2. user: `~/.dsh-guard/*.yaml`
3. project: `<cwd>/.dsh-guard/*.yaml`
4. local: `<cwd>/.dsh-guard.local/*.yaml`, meant to stay out of version control
5. `extraRuleFiles` from the plugin config
6. built-in rules (see Self-protection), which no file can override or disable; ids starting with `dsh-guard.` are reserved for them

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

Each decision appends one JSON line to the log: `time`, `rule`, `verdict` (`block`, `ask`, `warn`, `redact`, `override`, `ask-allowed`, `ask-denied`, `budget-exceeded-open|closed`, `internal-error-open|closed`, and `authoring-add|modify|remove` for changes written by `guard_apply`), `tool`, `summary` (the primary field, one line, capped), `cwd`, and `callId` and `reason` where they apply.

## Authoring rules in conversation

The plugin registers five tools, so a dsh user can create, change and remove rules by talking to the agent. Each tool takes the same change request (`op`: `add`, `modify` or `remove`; `layer`: `user`, `project` or `local`; `rule`, `id`, `reason`, `mode`) and checks it again from scratch, so no draft state is kept between calls.

| tool | writes | does |
|---|---|---|
| `guard_list` | no | Rules in force for the session: id, defining and overriding layers, phase and tools, action (with `promote_to` for observe-mode rules), hit and override counts from the decision log, file. With no rules yet, it says so and points the user to describing what to guard. |
| `guard_draft` | no | Validates the schema and regexes, then loads all layers with the change simulated in memory, so layering and the tighten-only rule apply exactly as they will on disk. Returns the problems, or the entry that would be written and the rule in force afterwards. |
| `guard_test` | no | Runs the drafted rule's examples: each `block` example must fire, each `pass` example must not. A new rule needs at least one of each. |
| `guard_replay` | no | Runs the draft against the newest 500 tool calls of the session history and lists the calls it would fire on (`new`), still fires on (`kept`) or no longer fires on (`gone`). |
| `guard_apply` | yes | Drafts, tests and replays the change again, then asks the user through `ctx.approval`; the prompt shows the entry, the example results and the replay hits. Only `allowed-once` writes the file. If the file changed while the prompt was open, nothing is written; if the written file does not load as drafted, the previous content is restored. |

`add` writes a new rule. `modify` changes the given fields, in the rule's own file or as an override entry in a higher layer, where the tighten-only rule applies. `remove` deletes the rule's entry from the layer that defines it or, for a rule defined in a lower layer, writes `disabled: true` with the `reason` (user and local layers only). The tools never write `check` hooks, and built-in rules cannot be changed. Rules are written to `rules.yaml` in the layer's directory, or to the file that already holds the rule; comments and other entries of an existing file are kept. Each applied change is logged with the verdict `authoring-add`, `authoring-modify` or `authoring-remove`.

The plugin adds a short section to the system prompt (`guidance/authoring.md`). It tells the agent to ask about the boundary first (what must be stopped, which similar calls must keep working, which layer), to go through draft, test and replay before apply, and never to write rule files any other way.

### Observe mode

A new rule is written in observe mode unless the request says `mode: enforce`: its action becomes `warn` and the drafted action is kept in `promote_to`. The rule then only adds a warning to matching calls, and each hit is logged. The approval prompt states the mode; to enforce at once, the user rejects the prompt and asks for `mode: enforce`.

`dsh-guard stats` lists the observe-mode rules with the number of calls they would have blocked (or asked on, or redacted) and their false-positive candidates, the calls that passed the rule with an override comment (only rules with `override: true` collect these). It suggests promotion when a rule has hits and no candidates, but never changes a rule. Promotion is a `modify` that sets `action` to the `promote_to` value, through `guard_apply` and its approval like any other change.

### Self-protection

The built-in rule `dsh-guard.self-protect` blocks generic tools from changing the guard's own state:

- `write`, `edit`, `apply_patch` and `str_replace_editor` calls on the user rule directory, `<cwd>/.dsh-guard/`, `<cwd>/.dsh-guard.local/`, `extraRuleFiles`, the decision log, the plugin code and the configured packs, and the dsh configuration files (`$DSH_HOME/cordis.patch.yml`, and `cordis.patch.yml`, `package.json` and `pnpm-workspace.yaml` of each profile);
- shell commands that name one of these locations (or any `.dsh-guard` directory) and contain a write verb or redirection (`>`, `rm`, `mv`, `cp`, `tee`, `sed -i`, `Set-Content`, `Remove-Item`, `git checkout` and others); reading, for example `cat .dsh-guard/rules.yaml`, passes;
- `plugin_manager` calls that disable or remove the dsh-guard plugin or bundle.

The rule loads after every layer, cannot be overridden or disabled, and has `override: false`. Only `guard_apply`, after an approval, writes rule files. Like every regex rule it sees text, not intent: a script that writes the files indirectly passes the shell check.

### Settings card

`src/settings.ts` provides the data and actions of a settings card: the rules per layer with their on/off state where a layer may switch them (a pack rule from the user layer, a project rule from the local layer, built-in and `extraRuleFiles` rules never), the log counts, and the observe-mode rules with a promotion request. While no rule file defines a rule, the snapshot is marked `empty` and carries a hint that rules are created by describing them in a conversation. Every switch and promotion is a change request for `GuardAuthoring.apply`, with the same checks and the same prompt as `guard_apply`. The browser half of the card is not shipped yet; see Limitations.

## Command line

```sh
dsh-guard test                 # run every rule's examples; exit 1 on a mismatch or a load error
dsh-guard lint                 # schema, regexes, overrides, risky patterns; exit 1 on errors or warnings
dsh-guard stats                # observe-mode rules: would-have counts, false-positive candidates, promotion hints
dsh-guard explain '{"tool": "bash", "input": {"command": "git push -f"}}'
dsh-guard explain '{"tool": "read", "input": {"file_path": "x"}, "output": "sk-..."}'
```

`explain` lists each field it extracted, each rule of the phase with its result, the final verdict, and the masked output of redact rules. It also accepts a dsh `tool/call` record (`{"name": ..., "arguments": "<json string>"}`). Options: `--cwd <dir>` selects the project, `--no-user` skips `~/.dsh-guard`, `--user-dir <dir>`, `--packs a,b` (rule files or directories, none by default), `--rules <file>` (repeatable), `--phase pre_tool|post_tool` for `explain`, and `--log <file>` and `--all` (every rule with log records) for `stats`. `test` and `lint` include the built-in rules.

## Development

```sh
npm run typecheck
npm test                  # unit tests: loader, layering, matcher, actions, plugin wiring, authoring, self-protection
npm run test:integration  # boots dsh headless with a scripted model adapter and a scripted approver; no API key needed
node test/integration/plugin-add.ts  # manual: dsh plugin add into a temporary profile; needs pnpm on PATH
npm run guard:test        # dsh-guard test on the synthetic rules in test/fixtures/rules
npm run guard:lint
npm run export -- --clean <dir>  # copy the publishable tree to <dir> and scan it for leftovers
```

`test/fixtures/rules/` holds a handful of synthetic rules (one per action, `not_path`, an override comment, a content/edit/output pattern) used only to exercise the engine; they are not loaded by the plugin and protect nothing. `scripts/export.ts` is a development script and is not part of the package. Besides its built-in checks (absolute home paths, email addresses other than noreply placeholders, YAML files outside `test/fixtures/rules/`, and fixture rules that reuse an id or a regex of a private rule folder given with `--rules-dir <dir>` or `DSH_GUARD_PRIVATE_RULES`, by default a `rules` folder beside the pattern file), it reads a private pattern file with one regular expression per line, given with `--patterns <file>` or `DSH_GUARD_EXPORT_PATTERNS`; `--no-private-patterns` skips it. A failed scan removes the copy and exits with 1.

Sources run directly on Node.js 24 type stripping; `npm run build` emits `dist/` for dsh.

## Limitations

- Regex rules see text, not intent: a command assembled from variables, an alias or a script file passes a command pattern. Rules are a safety net for an agent's mistakes, not a sandbox; keep dsh's own sandbox and approval policy on.
- `run_code` (PTC mode) is checked as one call, and its sub-calls are checked individually; warnings are not delivered for sub-calls because dsh omits their additional context.
- A post-execute listener that replaces a result's canonical `value` hides the rendered content from redact and post_tool rules.
- The time budget is checked between rules; one slow regex is not interrupted. `dsh-guard lint` warns about nested quantifiers.
- `check` hooks must be synchronous.
- The settings card has no browser half yet. A third-party plugin cannot add a Host Remote to the Web client: the client reaches Host services only through the generated Typert contributions that `@deepseek-ai/dsh-api-remotes` selects, and a package's browser half is attached only to a Loader row named by the bare package name. `ctx.approval.request` also requires an open agent turn, so a card button cannot raise the same approval outside a conversation; the card's actions need a confirmation dialog of the surface that hosts them.
- Replay reads at most the newest 200 sessions and 500 calls, uses each session's starting directory for project rules, and skips calls without a recorded result for post_tool rules.
