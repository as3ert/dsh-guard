# dsh API notes (dsh 0.2.2-rc.5)

Exact seams that dsh-guard uses. Paths are relative to `node_modules/@deepseek-ai/` of the pinned devDependency `@deepseek-ai/dsh@0.2.2-rc.5`; line numbers refer to the shipped `src/` files.

## Plugin shape and loading

- A plugin is a module exporting `name`, optional `inject`, optional `Config` (a Schemastery schema, not a plain object) and `apply(ctx, config)`. See `dsh/docs/user/develop/basic/index.md` ("What is a plugin?") and `dsh/docs/user/develop/basic/config.md` ("Define the Config type").
- Registrations made through `ctx.on`, `ctx.effect` and `ctx.tools.guard` are effects and are disposed when the plugin unloads (`dsh/docs/cordis-primer.md`, "Registrations are reversible effects").
- `ctx.on(name, listener, options?)`; `options` is `boolean | { prepend?: boolean }`, a boolean being shorthand for `prepend` (`cordis/src/events.ts:96`, `:113`, `:294`).
- A local plugin is loaded by an overlay passed with `dsh <profile> --patch <file>`; the row names the module by absolute path (`dsh/docs/user/develop/basic/index.md`, "Register it in cordis.yml"):

  ```yaml
  - insert:
      - id: dsh-guard
        name: '/absolute/path/to/dsh-guard/dist/index.js'
        config: { failMode: open }
  ```

  The same row can live in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A patch row with an existing `id` and no `insert` replaces that row's fields, for example `- id: agent-default-model` with a new `config` (pattern used in `dsh-headless/cordis.patch.yml`).

## Tool pipeline events

Declared in `dsh-tools/src/events.ts`, dispatched in `dsh-tools/src/pipeline.ts`.

- `'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>`, waterfall (`events.ts:18`). Dispatched at `pipeline.ts:200`; the terminal `next()` resolves to `{ kind: 'allow' }`.
- `PreToolDecision = {kind:'allow'} | {kind:'deny', reason, info?} | {kind:'cancel'} | {kind:'ask', reason?, displayReason?: {en, [locale]}}` (`contracts.ts:375-379`). Arguments cannot be rewritten in pre-execute; they are already logged.
- `'tools/post-execute'(exec, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>`, waterfall (`events.ts:41`), applied at `pipeline.ts:495-532`.
- `PostToolDecision = {kind:'accept', content?, additionalContexts?} | {kind:'accept', value, additionalContexts?} | {kind:'block', feedback: ContentBlock[], info?, additionalContexts?}` (`contracts.ts:386-389`). `block` turns the result into an error whose content is `feedback`; context deferred by the tool body is dropped on block, decision context is kept (`pipeline.ts:484-509`).
- Denied calls (pre-execute deny, guard deny, refused approval) still traverse `tools/post-execute` as error results (`pipeline.ts:214-225`; also stated in `dsh-repeat-tool-reminder/src/index.ts:188-195`).
- `ToolExecutionResult` (`contracts.ts:340-364`): `{ isError, content: ContentBlock[], value?, error?, meta?, additionalContexts?: UserMessage[] }`.
- `ToolExecution` (`contracts.ts:175-225`): `callId`, `rootCallId`, `name`, `arguments` (parsed, deep-frozen), `agent?`, `parent?` (set for PTC sub-calls), `signal`, `token`.

## Monotonic guard

- `ctx.tools.guard(guard: ToolGuard): () => void` (`dsh-tools/src/index.ts:384`), an effect in the calling scope.
- `ToolGuard = (execution: Readonly<ToolExecution>) => string | ToolGuardDenial | undefined`, `ToolGuardDenial = { reason, info? }` (`contracts.ts:410-417`). Guards are synchronous and have no allow result.
- Order: pre-execute waterfall, then ask resolution, then guards, which run only when the decision is allow (`pipeline.ts:204-214`). A denial is rendered to the model as `Error: <reason>` (`pipeline.ts:217-222`).

## Approval

- An `ask` decision is resolved by `serviceAsk` (`pipeline.ts:442-480`) through `ctx.get('approval')`. No service, no agent, or the outcomes `unavailable`, `rejected`, `cancelled` all deny with `info.name = ApprovalError`; only `allowed-once` proceeds.
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` (`dsh-user-approval/src/types.ts:32`); answerers listen on `'approval/request'(req, next)` (`types.ts:87-91`); payload `ApprovalRequestEvent` (`types.ts:63-76`).
- The base composition mounts `@deepseek-ai/dsh-user-approval` as row `approval` with `policy: ask`, or `never` under `danger-full-access` (`dsh-base/cordis.patch.yml:259-262`). Headless has no live approval channel (`dsh-headless/README.md:100`), so an ask denies there.

## additionalContexts

- Built as a `UserMessage` with `createUserMessage({ content, source })` (`dsh-llm/src/message.ts:246`). The source kind must be declared by augmenting `MessageSourceMap` in `@deepseek-ai/dsh-llm`; `form: 'notice'` requires a one-line `summary` of at most 120 characters (`message.ts:86-101`). Working example: `dsh-repeat-tool-reminder/src/index.ts:14-18`, `:210-225`.
- Attached on a post-execute decision; injected as user messages after the batch's recorded tool results. PTC sub-calls omit them (`dsh/docs/tool-execution-pipeline.md`, last paragraph).

## Tool names and input fields (`dsh/docs/tool-catalog.md`)

| dsh tool | package | input fields | guard canonical |
|---|---|---|---|
| `bash` | dsh-tool-bash, dsh-tool-bash-persistent | `command`, `description`, `workdir`, `timeoutMs`, `run_in_background` (catalog l. 699) | `shell` |
| `pwsh` | dsh-tool-pwsh, dsh-tool-pwsh-persistent | same as bash (l. 904) | `shell` |
| `terminal_send` | dsh-tool-terminal | text sent to a PTY | `shell` |
| `edit` | dsh-tool-fs | `file_path`, `old_string`, `new_string`, `replace_all` (l. 1186) | `edit` |
| `apply_patch` | dsh-tool-fs | `input` (l. 1165) | `edit` |
| `write` | dsh-tool-fs | `file_path`, `content` (l. 1271) | `write` |
| `read` | dsh-tool-fs | `file_path`, `offset`, `limit` (l. 1221) | `read` |
| `str_replace_editor` | dsh-tool-str-replace-editor | `command` (view, create, str_replace, insert), `path`, `file_text`, `old_str`, `new_str`, `insert_line`, `view_range` (l. 1059) | by `command` |
| `web_fetch` | dsh-tool-web | `url` (l. 2817) | `fetch` |
| `web_search` | dsh-tool-web | `queries` (l. 2838) | `search` |
| `run_code` | dsh-tool-executor-ptc | program text; its sub-calls re-enter the pipeline with `parent` set | raw name only |

Windows compositions mount `pwsh`, the others `bash` (`dsh-base/cordis.patch.yml:281-287`).

## Session log access (for later replay)

- Each call is logged as session event `'tool/call': { turn, step, callId, name, arguments }`, `arguments` being the raw JSON string (`dsh-session/src/types.ts:369`), followed by `'tool/result'`.
- `ctx.sessionQuery.listEvents(sessionId)` returns event records in ascending order (`dsh-session-query/src/index.ts:281`). The JSONL backend stores logs under `dshHomePath('sessions')` (`dsh-base/cordis.patch.yml:138-141`); they are plain lines only with `compression: 'none'`, otherwise they must be read through the backend.

## Working directory

- `ctx.workingDirectory.get(session): string` is synchronous (`dsh-working-directory/src/index.ts:141`); the session is `exec.agent.session`. dsh-guard reads the service opportunistically with `ctx.get('workingDirectory')` to resolve project rule layers.

## LLM adapter (integration test)

- `abstract class LlmAdapter { abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk> }` (`dsh-llm/src/index.ts:223`, `:315`); `resolveModel()` defaults to `{ provider, id, name }` (`:288`). Register with `ctx.llm.registerAdapter([provider], adapter)` under `inject = ['llm']` (`dsh/docs/cookbook/adding-an-llm-adapter.md`).
- `StreamChunk` (`dsh-llm/src/types.ts:496`): `block-start`, `text-delta`, `tool-call-delta {id, name, argumentsDelta}`, `block-end {block}`, `usage`, `finish {reason: {kind: 'stop' | 'tool-calls' | ...}}`; usage before finish, nothing after finish.
- Fresh agents take their model from row `agent-default-model` (`config: { provider, model }`, `dsh-base/cordis.patch.yml:90-94`).
