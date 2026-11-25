# dsh-guard

dsh-guard is a plugin for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`) that checks every tool call the agent makes against declarative rules. A rule names a tool, gives regular expressions over the call's input or output, and states what happens on a match: the call is blocked, the user is asked first, the model receives a warning, or matching text in the tool output is masked before the model sees it. Rules live in YAML files. The plugin ships no rules: after installation every call passes, except those the built-in self-protection rule stops, until the user creates rules, usually by describing them to the agent in a conversation (see Authoring rules in conversation).

Tested against `@deepseek-ai/dsh` 0.2.2-rc.5 on Node.js 24. The same engine and rule files also run in Claude Code as a plugin; see [Claude Code](#claude-code).

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

dsh-guard is not published to npm. It is shared as a zip, `dsh-guard-<version>.zip`, or built from a checkout. The zip holds one folder, `dsh-guard-<version>/`, with the built plugin (`dist/`) and its only runtime dependency (`node_modules/yaml`), so installing it needs neither Node.js nor npm. Unpack it to a place where it can stay: `dsh plugin add` links the folder instead of copying it, so moving or deleting the folder later breaks the profile.

The commands below use `0.1.0` for `<version>`. In every variant, `plugin add` prints a pnpm warning that the linked package's peer dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`) will not resolve from the target `node_modules`. The warning is expected and harmless: these packages are part of dsh and are resolved from the running installation.

### Quick start: DeepSeek Harness desktop app

The desktop app contains a command-line launcher with its own Node.js and pnpm:

| OS | launcher |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| macOS | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (the app's own command installer uses `Resources/runtime/cli/bin/dsh`; the app location `/Applications` is assumed and not verified on macOS) |

Windows, in PowerShell:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add C:\path\to\dsh-guard-0.1.0
```

macOS, in a terminal:

```sh
dsh="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$dsh" plugin --profile desktop add /path/to/dsh-guard-0.1.0
```

Quit and restart the app; it loads the plugin on its next start. The `desktop` profile belongs to the app: it cannot be booted from the command line (dsh reports that it is managed exclusively by the Electron application), so check the installation inside the app (see Verify that it is loaded) or try the plugin in a separate headless profile first (see Try it in a headless session).

### Quick start: dsh installed from npm

With `@deepseek-ai/dsh` installed from npm, `dsh plugin` forwards to pnpm, which must then be on `PATH` (a missing pnpm fails with `'pnpm' is not recognized` or `command not found`). Add the plugin to a profile that ships with dsh, for example `headless`:

```sh
dsh plugin --profile headless add /path/to/dsh-guard-0.1.0
```

For a shipped profile name, `plugin add` first initializes the profile from its template. For a new profile name it creates a bare profile that boots nothing; create such a profile from a template first, as shown in Try it in a headless session.

### Building from source

Building needs Node.js 24.9 or later with npm; dsh itself loads only the built `dist/`. From a Git checkout, `scripts/setup.ps1` (Windows) or `scripts/setup.sh` (macOS, Linux) does everything below in one command, falls back to the node and pnpm bundled with the desktop app, and installs git hooks that rebuild after `git pull`; see "Install from a Git checkout" in TESTING.md. By hand:

```sh
npm ci
npm run build
dsh plugin --profile desktop add /path/to/dsh-guard
```

`desktop` is the profile of the desktop app; use another name for a test profile. A checkout provides `yaml` from its own `node_modules`. `npm run pack:zip -- --out <dir>` builds the release zip (see Development).

### Verify that it is loaded

```sh
dsh --profile headless --dump-config
```

prints the composed profile; a loaded plugin shows the layer `# == dsh-guard` with the row `- id: dsh-guard`. In a session, including the desktop app, ask the agent "what guard rules do I have?". It answers with `guard_list`, which, before any rule exists, reports that no guard rules exist yet and lists only the built-in rule `dsh-guard.self-protect`.

### Try it in a headless session

A separate profile keeps the app's own profile untouched. With the desktop app on Windows, use `& $dsh` from the quick start in place of `dsh`:

```sh
dsh --profile guardtest --from-default-profile headless --dump-config
dsh plugin --profile guardtest add /path/to/dsh-guard-0.1.0
dsh --profile guardtest --dump-config
dsh --profile guardtest --patch /path/to/dsh-guard-0.1.0/examples/headless-account.yml "Call guard_list and quote its reply."
```

(`dsh <name>` and `dsh --profile <name>` are the same; this document uses `--profile`.) The first command creates the profile `guardtest` from the shipped `headless` template and prints it; the second adds the plugin; the third shows the `dsh-guard` row. The fourth runs one task. The headless template turns off the DeepSeek account that the desktop app signs in to; `examples/headless-account.yml` turns it back on and selects the account's model. With an API key instead, set `DEEPSEEK_API_KEY` in the environment and leave out `--patch`. Without either, the task fails with `MISSING_CREDENTIAL` (for the provider `deepseek-official`) or `ACCOUNT_SIGN_IN_REQUIRED`. A headless session has no approval channel, so `ask` rules deny and `guard_apply` cannot write a rule there; create rules in the app or another interactive profile. To remove the test profile, delete the folder `guardtest` below `$DSH_HOME/profiles` (by default `~/.dsh/profiles`).

### Rule directory and decision log

User rules are the `*.yaml` files in `~/.dsh-guard` (on Windows `%USERPROFILE%\.dsh-guard`); the decision log `log.jsonl` lies in the same directory. The environment variable `DSH_GUARD_HOME` replaces this directory for both, and must be set in the environment of the process that runs dsh, so for the desktop app before the app starts. In the plugin configuration, `userDir` takes precedence for the rules and `logPath` for the log. Project rules live in `<project>/.dsh-guard/` and `<project>/.dsh-guard.local/` (see Layers). `node dist/cli.js lint` prints the line `user rule directory: <dir>`, the directory the command line uses; it follows `DSH_GUARD_HOME` but does not read the plugin configuration.

### Command line

`plugin add` does not put the `dsh-guard` command on `PATH`, and a build does not either. Run it with Node.js 24.9 or later from the package folder, for example `node dist/cli.js lint`; in a checkout, `npm run guard:test` and `npm run guard:lint` run it on the synthetic fixture rules. The commands are described in Command line below.

### Configuration

`plugin add` appends `dsh-guard` to the profile's bundles and mounts the row `dsh-guard` with the default configuration; override its `config` in the profile's own `cordis.patch.yml` (for example `$DSH_HOME/profiles/headless/cordis.patch.yml`). Without `plugin add`, insert a row in a profile overlay, or pass a file with `dsh --profile headless --patch guard.yml`:

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
      output: '\bitk_[A-Za-z0-9]{32}'
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
| `search` | `web_search`, `grep`, `glob` | `query` (the `queries` of web_search, the `pattern` of grep and glob); grep and glob also `path` |

Every call also has `cwd`, the session's working directory, and post_tool rules see `output`, the text of the tool result. Any other tool, for example an MCP tool, is matched by its raw name and raw argument names.

### Examples

A plain-string example is shorthand only where the rule's first tool has one field that is meant: the command of a `shell` (or `any`) rule, the path of a `read` rule, the URL of a `fetch` rule, or the output of a post_tool rule. For `write`, `edit` and search tools (`search`, `grep`, `glob`, `web_search`) a string is ambiguous (path or content; path, old or new text; pattern, query or path), so `dsh-guard test`, `dsh-guard lint` and the authoring tools report it as an error that shows the object form instead of guessing a field. A mapping is either the input of that tool (`{ file_path: a.ts, content: ... }`) or a full call (`{ tool: grep, input: { pattern: token, path: .env } }`, `{ tool: pwsh, input: { command: ... }, output: ..., cwd: ... }`). Examples run with override comments honoured, so an overridden command belongs under `pass`.

In `redact` patterns, a token prefix needs a left boundary: `sk-[A-Za-z0-9_-]{16,}` alone also masks part of `desk-lamp-controller-service`, while `\bsk-...` or `(?<![A-Za-z0-9_-])sk-...` does not. `dsh-guard lint` warns about a redact alternative that starts with two to four letters and `-` or `_` without such a boundary.

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

The plugin registers six tools, so a dsh user can create, change and remove rules by talking to the agent. Each tool takes the same change request (`op`: `add`, `modify` or `remove`; `layer`: `user`, `project` or `local`; `rule`, `id`, `reason`, `mode`) and checks it again from scratch, so no draft state is kept between calls.

| tool | writes | does |
|---|---|---|
| `guard_list` | no | Rules in force for the session: id, defining and overriding layers, phase and tools, action (with `promote_to` for observe-mode rules), hit and override counts from the decision log, file. With no rules yet, it says so and points the user to describing what to guard. |
| `guard_propose` | no | Drafts, runs the examples and replays in one call, and returns a READY or NOT READY line with the problems, the example results and the replay hits. This is the tool the guidance uses; the three below run the same checks separately. |
| `guard_draft` | no | Validates the schema and regexes, then loads all layers with the change simulated in memory, so layering and the tighten-only rule apply exactly as they will on disk. Returns the problems, or the entry that would be written and the rule in force afterwards. |
| `guard_test` | no | Runs the drafted rule's examples: each `block` example must fire, each `pass` example must not. A new rule needs at least one of each. |
| `guard_replay` | no | Runs the draft against the newest 500 tool calls of the session history and lists the calls it would fire on (`new`), still fires on (`kept`) or no longer fires on (`gone`). |
| `guard_apply` | yes | Drafts, tests and replays the change again, then asks the user through `ctx.approval`; the prompt shows the entry, the example results and the replay hits. Only `allowed-once` writes the file. If the file changed while the prompt was open, nothing is written; if the written file does not load as drafted, the previous content is restored. |

The approval request carries two texts. `reason`, which dsh stores in the session's audit events, is the full multi-line prompt. `displayReason`, which the desktop app shows, is one paragraph, because the app renders it as the card's headline and collapses line breaks: a headline with operation, rule id, layer and mode, then `Rule: ...`, `Examples: ...`, `Replay of N past calls: ...` (with up to three hits) and `File: ...`, separated by ` | `. The full detail is also in the `guard_propose` result the agent shows beforehand.

When `guard_apply` is not approved, its result says why, as far as dsh tells: the user rejected the prompt (approval policy ask); the session's approval policy is set to never ask, so dsh rejected without showing anything, and the policy must be switched to ask for the change; no approval channel exists (`unavailable`, for example headless); or the prompt was cancelled. If the policy cannot be read, the result names both possibilities.

`add` writes a new rule. `modify` changes the given fields, in the rule's own file or as an override entry in a higher layer, where the tighten-only rule applies. `remove` deletes the rule's entry from the layer that defines it or, for a rule defined in a lower layer, writes `disabled: true` with the `reason` (user and local layers only). The tools never write `check` hooks, and built-in rules cannot be changed. Rules are written to `rules.yaml` in the layer's directory, or to the file that already holds the rule; comments and other entries of an existing file are kept. Each applied change is logged with the verdict `authoring-add`, `authoring-modify` or `authoring-remove`.

The plugin adds a short section to the system prompt (`guidance/authoring.md`). It tells the agent to list the rules, ask about the boundary (what must be stopped, which similar calls must keep working, which layer, which mode), call `guard_propose` until it is READY, show the result, and call `guard_apply` only after the user agreed; and never to write rule files any other way.

### Observe mode

A new rule is written in observe mode unless the request says `mode: enforce`: its action becomes `warn` and the drafted action is kept in `promote_to`. The guidance recommends observe mode for new rules, with one exception: a rule whose purpose is to prevent a leak or an irreversible loss on the first hit, such as reading credential or secret files, is recommended as `mode: enforce`, since observing it would let the first hit through. `redact` rules are always written enforced, whatever `mode` says, because an observe-mode redact rule only warns and masks nothing (the draft says so in a note). The rule then only adds a notice to matching calls, and each hit is logged. The notice says that the call was allowed and what the rule would do once promoted: `dsh-guard observe [<id>]: this call was allowed; once enforced the rule would block it: <message>` (`ask for confirmation` or `redact the matching output` for the other actions). A plain `warn` rule, without `promote_to`, keeps the form `dsh-guard warning [<id>]: <message>`. The approval prompt states the mode; to enforce at once, the user rejects the prompt and asks for `mode: enforce`.

`dsh-guard stats` lists the observe-mode rules with the number of calls they would have blocked (or asked on, or redacted) and their false-positive candidates, the calls that passed the rule with an override comment (only rules with `override: true` collect these). It suggests promotion when a rule has hits and no candidates, but never changes a rule. Promotion is a `modify` that sets `action` to the `promote_to` value, through `guard_apply` and its approval like any other change.

### Self-protection

The built-in rule `dsh-guard.self-protect` blocks generic tools from changing the guard's own state:

- `write`, `edit`, `apply_patch` and `str_replace_editor` calls on the user rule directory, `<cwd>/.dsh-guard/`, `<cwd>/.dsh-guard.local/`, `extraRuleFiles`, the decision log, the plugin code and the configured packs, and the dsh configuration files (`$DSH_HOME/cordis.patch.yml`, and `cordis.patch.yml`, `package.json` and `pnpm-workspace.yaml` of each profile);
- shell commands that name one of these locations (or any `.dsh-guard` directory) and contain a write verb or redirection (`>`, `rm`, `mv`, `cp`, `tee`, `sed -i`, `Set-Content`, `Remove-Item`, `git checkout` and others); reading, for example `cat .dsh-guard/rules.yaml`, passes;
- `plugin_manager` calls that disable or remove the dsh-guard plugin or bundle.

The rule loads after every layer, cannot be overridden or disabled, and has `override: false`. Only `guard_apply`, after an approval, writes rule files. Like every regex rule it sees text, not intent: a script that writes the files indirectly passes the shell check.

## Command line

The command is not on `PATH` (see Install); run it as `node dist/cli.js <command>` from the package folder. It needs Node.js 24.9 or later; on Windows the desktop app's node works (`ELECTRON_RUN_AS_NODE=1` with `DeepSeek Harness.exe`, see TESTING.md).

```sh
dsh-guard test                 # run every rule's examples; exit 1 on a mismatch or a load error
dsh-guard lint                 # schema, regexes, overrides, risky patterns; exit 1 on errors or warnings
dsh-guard stats                # observe-mode rules: would-have counts, false-positive candidates, promotion hints
dsh-guard list                 # rules in force with layers, actions and log counts (--layer <layer>, --observe)
dsh-guard explain '{"tool": "bash", "input": {"command": "git push -f"}}'
dsh-guard explain '{"tool": "read", "input": {"file_path": "x"}, "output": "sk-..."}'
```

`explain` lists each field it extracted, each rule of the phase with its result, the final verdict, and the masked output of redact rules. It also accepts a dsh `tool/call` record (`{"name": ..., "arguments": "<json string>"}`). Options: `--cwd <dir>` selects the project, `--no-user` skips `~/.dsh-guard`, `--user-dir <dir>`, `--packs a,b` (rule files or directories, none by default), `--rules <file>` (repeatable), `--phase pre_tool|post_tool` for `explain`, and `--log <file>` and `--all` (every rule with log records) for `stats`. `test` and `lint` include the built-in rules; `lint` also prints the user rule directory it read.

## Claude Code

The Claude Code adapter is a Claude Code plugin built from the same engine: the rule format, the layers, observe mode, the decision log and the self-protection rule are shared, so one rule directory serves both harnesses. It runs as command hooks, one Node.js process per event, plus the `dsh-guard` command line for authoring. Tested with Claude Code 2.1.332 on Windows; the plugin declares `engines.claude-code >=2.1.323`.

### Requirements and install

- Node.js 24 or later on `PATH` for Claude Code's hook processes and the Bash tool. If `node` is missing, the plugin's SessionStart hook says so in the session, and each tool hook fails visibly with a hook error; the calls are then not checked (see Fail mode).
- Build the release folder from a checkout: `npm ci`, then `npm run pack:claude-code -- --out <dir>`. It writes `<dir>/dsh-guard-claude-code-<version>/` (the plugin: manifest, hooks, skill, `bin/` launchers, compiled `dist/`, the vendored `yaml`), the same folder as a zip, and `<dir>/.claude-plugin/marketplace.json`, which lists the folder as the marketplace `dsh-guard-local`. The folder is scanned like the dsh export; the plugin ships no rules.
- Try it for one session without installing: `claude --plugin-dir <dir>/dsh-guard-claude-code-<version>`.
- Install from the local marketplace: `claude plugin marketplace add <dir>`, then `/plugin install dsh-guard@dsh-guard-local` (or `claude plugin install dsh-guard@dsh-guard-local`). A local-path marketplace loads the folder in place, so keep `<dir>` where it is, and do not point a marketplace at the checkout itself, whose `plugin/claude-code/` has no `dist/`.
- Private marketplace: commit the built folder and `.claude-plugin/marketplace.json` to a private Git repository (for example a release branch) and add that repository with `claude plugin marketplace add <owner>/<repo>`; each machine then installs and updates from it.
- Install the plugin in one way only: a plugin hook and an identical hook in a settings file both run.

### Rule locations and configuration

The adapter reads its configuration from the environment, so a value set in the `env` block of a Claude Code settings file reaches the hooks and the command line alike.

| variable | meaning | default |
|---|---|---|
| `DSH_GUARD_HOME` | user rule directory (`*.yaml`) | `~/.dsh-guard`, shared with dsh |
| `DSH_GUARD_LOG` | decision log; empty disables it | `<DSH_GUARD_HOME>/log.jsonl` |
| `DSH_GUARD_STATE` | pending rule changes | `<DSH_GUARD_HOME>/state` |
| `DSH_GUARD_PACKS`, `DSH_GUARD_RULES` | rule files or directories loaded before the user layer, and after the local layer (separated by the path delimiter) | none |
| `DSH_GUARD_PROTECT` | further files or directories the self-protection rule guards | none |
| `DSH_GUARD_FAIL_MODE` | `open` or `closed`, for internal errors and an exhausted time budget | `open` |
| `DSH_GUARD_TIME_BUDGET_MS` | evaluation budget per call and phase | 250 |

Project rules live in `<project>/.dsh-guard/` and `<project>/.dsh-guard.local/`, as in dsh (see Layers). Rules written against canonical tools apply in both harnesses; a rule naming a raw tool of one harness never matches in the other.

### Tools and fields in Claude Code

| canonical | Claude Code tools | fields |
|---|---|---|
| `shell` | `Bash`, `PowerShell` (and Monitor commands) | `command` |
| `edit` | `Edit`, `MultiEdit` (all `edits[]` joined), `NotebookEdit` | `path`, `old`, `new` |
| `write` | `Write` | `path`, `content` |
| `read` | `Read` | `path` |
| `fetch` | `WebFetch` | `url` |
| `search` | `WebSearch`, `Grep`, `Glob` | `query` (query or pattern), `path` |
| raw name | `Agent`, `Skill`, `CronCreate`, `mcp__<server>__<tool>`, ... | the raw input fields |

Paths arrive absolute; backslashes become `/`. Every rule can also match the context fields `agent_type` (in a subagent), `permission_mode` and, for MCP tools, `mcp_source` and `mcp_server`. The `output` of a post_tool rule is every string of the structured tool result, one per line.

### Actions in Claude Code

| action | hook | effect |
|---|---|---|
| `block` | PreToolUse `deny` | The call never runs, in every permission mode; Claude reads `Blocked by dsh-guard: [id] message`. |
| `ask` | PreToolUse `deny` | Claude Code's permission prompt is never used. The call is refused with the rule's message, and Claude is told to ask the user in the chat and, only after the user agrees, to repeat the shell command with `# guard: allow <reason>`. The comment passes every `ask` rule (no `override: true` needed) but works only on shell commands; for other tools Claude has to ask how to proceed. Rule examples are checked with the harness-neutral semantics, so a pass example with the comment on an `ask` rule needs `override: true`, which also makes the comment work in dsh. |
| `warn` | `additionalContext` | The call runs; the notice appears beside the result (observe-mode rules use the observe wording). |
| `redact` | PostToolUse `updatedToolOutput` | Every match in every string of the result is replaced with `[REDACTED:<id>]`, keeping the structure of the result, so the model and the transcript see the masked text. For a large output that Claude Code saved to a file and replaced by a preview, the saved file is masked in place as well. |
| post_tool `block` | PostToolUse `updatedToolOutput` | The content of the result is replaced by the rule message. |

The guard never answers `allow`, so it neither adds nor removes any of Claude Code's own prompts.

### Authoring and approval in Claude Code

The plugin ships the skill `dsh-guard:guard-authoring`, which gives Claude the procedure and the rule format. Claude writes a change request (the JSON object the dsh tools take) to a file and runs `dsh-guard propose --request <file>` until it reports READY, shows the user the rule and the replay hits, and after the user agrees runs `dsh-guard apply --request <file>`. `apply` checks everything again and stores the change as pending; it writes nothing.

The change is approved by a code the user types, without a dialog. Right after `apply`, the plugin's PostToolUse hook shows the user a line such as `To apply this rule change, type exactly:  guard approve k3f9qz`; Claude does not receive this line. When the user sends exactly `guard approve <code>` as a prompt, the UserPromptSubmit hook re-drafts the change, checks that the target file has not changed since `apply`, writes it, logs `authoring-<op>` with `approved-by: prompt`, and tells Claude the outcome. Codes are random, stored only as salted hashes, valid for 30 minutes and usable once. Claude Code also delivers some automated text as prompts (background subagent reports, scheduled tasks, messages from other sessions): a wrapped notification never equals the bare phrase, and the self-protection rule blocks every tool call whose input contains `guard approve <code>`, so Claude cannot schedule, send or script an approval. Run in a terminal outside Claude Code, `dsh-guard apply` asks for `yes` instead.

### Command line in Claude Code

`dsh-guard` is on the Bash tool's `PATH` while the plugin is enabled (`bin/dsh-guard`, and `bin/dsh-guard.cmd` for PowerShell and `cmd`); elsewhere run `node <plugin>/dist/claude-code/cli.js`. Commands: `list`, `test`, `lint`, `stats`, `explain '<json>'` (a Claude Code hook input such as `{"tool_name": "Bash", "tool_input": {"command": "..."}}`), and `draft`, `replay`, `propose`, `apply` with `--request <file>` or `--request-json '<json>'`. `replay` reads the transcripts under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects` read-only: the newest 200 transcript files of the current project (`--all-projects` for all, `--sessions <n>`, `--projects-dir <dir>`), subagent transcripts included, at most 500 calls; lines it cannot parse are counted and skipped.

### Self-protection in Claude Code

Besides the rule directories, the decision log and the guard's code, the built-in rule `dsh-guard.self-protect` blocks writes (Write, Edit, MultiEdit, NotebookEdit, and shell commands that look like writes) to the state directory, the installed plugin tree, the `plugins/` directory of the Claude Code configuration, `settings.json` and `settings.local.json` of the configuration directory and of the `.claude/` folder of any project, and the paths in `DSH_GUARD_PROTECT`; shell commands that disable or remove the plugin (`claude plugin disable|uninstall|remove ... dsh-guard`); and any tool call that carries an approval phrase. Reading stays allowed.

### Fail mode in Claude Code

A hook that hits an internal error answers with a `systemMessage` to the user ("this call was NOT checked") and a notice to Claude, and logs `internal-error-open`; with `DSH_GUARD_FAIL_MODE=closed` a PreToolUse error denies the call instead. A hook that cannot start at all (no `node`, a broken install) or times out is a non-blocking hook error in Claude Code, shown in the transcript. `npm run pack:claude-code -- --out <dir> --fail-closed` builds a variant whose PreToolUse handler sets `onFailure: "block"`, so such a failure blocks every tool call until it is fixed.

### Limits in Claude Code

- Failed calls (PostToolUseFailure) cannot be rewritten: a redact match in an error message reaches the model, which receives a notice to treat it as secret.
- The final answer of a background subagent arrives as a task notification, not as a tool result, and is not masked; the subagent's own tool calls are checked and masked as usual.
- Files inserted with `@` in a prompt pass no hook; set `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` when redact rules guard secrets, and guard secret files with a pre_tool `block` on reading them rather than relying on redaction.
- Pressing `Esc` during a call cancels its PostToolUse hook, so its output is not masked.
- The approval code is hidden from Claude's context but recorded in the transcript file with the hook's output; reading it back is possible, submitting it is blocked as described above.
- Not in this release: a ConfigChange hook, an external confirmation channel for `ask` and approvals, and a per-rule `harness:` field.

## Development

```sh
npm run typecheck
npm test                  # unit tests: loader, layering, matcher, actions, plugin wiring, authoring, self-protection
npm run test:integration  # boots dsh headless with a scripted model adapter and a scripted approver; no API key needed
node test/integration/plugin-add.ts  # manual: dsh plugin add into a temporary profile; needs pnpm on PATH
npm run guard:test        # dsh-guard test on the synthetic rules in test/fixtures/rules
npm run guard:lint
npm run export -- --clean <dir>  # copy the publishable tree to <dir> and scan it for leftovers
npm run pack:zip -- --out <dir>  # rebuild dist/, export and scan it with dist/ and yaml, write <dir>/dsh-guard-<version>.zip
npm run pack:claude-code -- --out <dir> [--fail-closed]  # build and scan the Claude Code plugin folder, zip and local marketplace
```

`test/fixtures/rules/` holds a handful of synthetic rules (one per action, `not_path`, an override comment, a content/edit/output pattern) used only to exercise the engine; they are not loaded by the plugin and protect nothing. `scripts/export.ts` is a development script and is not part of the package. Besides its built-in checks (absolute home paths, email addresses other than noreply placeholders, YAML files outside `test/fixtures/rules/`, and fixture rules that reuse an id or a regex of a private rule folder given with `--rules-dir <dir>` or `DSH_GUARD_PRIVATE_RULES`, by default a `rules` folder beside the pattern file), it reads a private pattern file with one regular expression per line, given with `--patterns <file>` or `DSH_GUARD_EXPORT_PATTERNS`; `--no-private-patterns` skips it. A failed scan removes the copy and exits with 1. `--with-dist` adds the built `dist/` and `--with-deps` the runtime dependencies from `node_modules/` to the copy and the scan; a vendored file may contain only those email addresses that its own `package.json` names. `scripts/pack.ts` runs the export with both, so the zip contains exactly the scanned tree, and refuses to pack when the installed `yaml` differs from the version in `package-lock.json`.

Sources run directly on Node.js 24 type stripping; `npm run build` emits `dist/` for dsh. The sources form three packages in one TypeScript project: `src/core/` (schema, loader, engine, authoring, self-protection with adapter-supplied targets; depends on `yaml` only), `src/dsh/` (the Cordis plugin, its authoring tools, session history and protected paths) and `src/claude-code/` (the Claude Code adapter). `src/index.ts` re-exports the dsh plugin, so the package root stays what `dsh plugin add` links; `test/packages.test.ts` keeps the core free of harness imports and the adapters independent of each other.

## Limitations

- Regex rules see text, not intent: a command assembled from variables, an alias or a script file passes a command pattern. Rules are a safety net for an agent's mistakes, not a sandbox; keep dsh's own sandbox and approval policy on.
- `run_code` (PTC mode) is checked as one call, and its sub-calls are checked individually; warnings are not delivered for sub-calls because dsh omits their additional context.
- A post-execute listener that replaces a result's canonical `value` hides the rendered content from redact and post_tool rules.
- The time budget is checked between rules; one slow regex is not interrupted. `dsh-guard lint` warns about nested quantifiers.
- `check` hooks must be synchronous.
- Replay reads at most the newest 200 sessions and 500 calls, uses each session's starting directory for project rules, and skips calls without a recorded result for post_tool rules.
