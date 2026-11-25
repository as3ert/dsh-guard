/** Claude Code adapter: mapping, hook decisions, self-protection, approval by typed code, transcript replay, CLI. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runExamples } from '../src/core/examples.ts'
import { APPROVE_PROMPT, PENDING_TTL_MS, createPending, findByCode, issueCode, listPending } from '../src/claude-code/approval.ts'
import { GuardAuthoring } from '../src/core/authoring.ts'
import { readConfig } from '../src/claude-code/config.ts'
import { EVENTS, failureOutput, handle, hookCore } from '../src/claude-code/hook.ts'
import type { HookOutput } from '../src/claude-code/hook.ts'
import { callOf, maskResponse, outputText, replaceResponse, sameShape } from '../src/claude-code/mapping.ts'
import { parseTranscript, projectKey, transcriptHistory } from '../src/claude-code/transcript.ts'
import { viewOf } from '../src/core/tools.ts'
import { failClosedHooks } from '../scripts/pack-claude-code.ts'
import { tempDir, writeTree } from './helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const FIXTURES = join(HERE, 'fixtures', 'claude-code')

const RULES = `rules:
  - id: t.block-push
    tool: shell
    match: { command: 'git\\s+push\\s+.*--force' }
    action: block
    message: No force pushes.
    override: true
  - id: t.ask-rm
    tool: shell
    match: { command: '\\brm\\s+-rf\\b' }
    action: ask
    message: Recursive delete needs agreement.
  - id: t.ask-write-env
    tool: write
    match: { path: '\\.env$' }
    action: ask
    message: Writing .env needs agreement.
  - id: t.warn-curl
    tool: shell
    match: { command: '\\bcurl\\b' }
    action: warn
    message: Network access noted.
  - id: t.redact-key
    when: post_tool
    tool: any
    match: { output: '\\bKEY-[0-9A-F]{8}\\b' }
    action: redact
    message: key masked
`

/** A temporary guard home, state, config dir and project; returns the hook environment. */
function setup(rules = RULES) {
  const root = tempDir('dsh-guard-cc-')
  writeTree(root, { 'home/rules.yaml': rules, 'project/.keep': '', 'cfg/projects/.keep': '' })
  const env: NodeJS.ProcessEnv = {
    DSH_GUARD_HOME: join(root, 'home'),
    DSH_GUARD_STATE: join(root, 'state'),
    CLAUDE_CONFIG_DIR: join(root, 'cfg'),
    CLAUDE_PLUGIN_ROOT: join(root, 'plugin'),
  }
  return { root, env, cwd: join(root, 'project') }
}

function pre(env: NodeJS.ProcessEnv, cwd: string, tool: string, input: Record<string, unknown>) {
  return handle('pre', { hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: input, tool_use_id: 'toolu_t', session_id: 's' }, env)
}

function decision(out: HookOutput | undefined): { decision?: string, reason?: string, context?: string } {
  const hook = (out?.hookSpecificOutput ?? {}) as Record<string, string>
  return {
    ...hook.permissionDecision !== undefined ? { decision: hook.permissionDecision } : {},
    ...hook.permissionDecisionReason !== undefined ? { reason: hook.permissionDecisionReason } : {},
    ...hook.additionalContext !== undefined ? { context: hook.additionalContext } : {},
  }
}

describe('Claude Code mapping', () => {
  it('maps Claude Code tools onto canonical tools and fields', () => {
    const cases: [string, Record<string, unknown>, string, Record<string, string>][] = [
      ['Bash', { command: 'ls', description: 'x' }, 'shell', { command: 'ls' }],
      ['PowerShell', { command: 'Get-ChildItem' }, 'shell', { command: 'Get-ChildItem' }],
      ['Write', { file_path: 'C:\\repo\\a.txt', content: 'hi' }, 'write', { path: 'C:/repo/a.txt', content: 'hi' }],
      ['Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, 'edit', { path: '/r/a.ts', old: 'a', new: 'b' }],
      ['MultiEdit', { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, 'edit', { path: '/r/a.ts', old: 'a\nc', new: 'b\nd' }],
      ['NotebookEdit', { notebook_path: '/r/n.ipynb', new_source: 'print(1)' }, 'edit', { path: '/r/n.ipynb', new: 'print(1)' }],
      ['Read', { file_path: '/r/.env' }, 'read', { path: '/r/.env' }],
      ['Grep', { pattern: 'token', path: '/r' }, 'search', { query: 'token', path: '/r' }],
      ['Glob', { pattern: '**/*.pem' }, 'search', { query: '**/*.pem' }],
      ['WebFetch', { url: 'https://example.com', prompt: 'x' }, 'fetch', { url: 'https://example.com' }],
      ['WebSearch', { query: 'weather' }, 'search', { query: 'weather' }],
      ['mcp__files__delete', { target: 'x' }, 'mcp__files__delete', { target: 'x' }],
    ]
    for (const [tool, input, canonical, fields] of cases) {
      const view = viewOf(callOf({ tool_name: tool, tool_input: input }))
      assert.equal(view.canonical, canonical, tool)
      for (const [key, value] of Object.entries(fields)) assert.equal(view.fields[key], value, `${tool}.${key}`)
    }
  })

  it('adds context fields without hiding raw input fields', () => {
    const view = viewOf(callOf({ tool_name: 'mcp__x__y', tool_input: { agent_type: 'raw' }, agent_type: 'Explore', permission_mode: 'bypassPermissions', mcp_server: { name: 'x', source: 'plugin' } }))
    assert.equal(view.fields.agent_type, 'raw')
    assert.equal(view.fields.permission_mode, 'bypassPermissions')
    assert.equal(view.fields.mcp_source, 'plugin')
  })

  it('masks string leaves and keeps the output shape', () => {
    const response = { type: 'text', file: { filePath: '/r/k.txt', content: 'a KEY-0A1B2C3D b', numLines: 1 } }
    const core = hookCore(readConfig(setup().env))
    const hit = { rule: { id: 'r', action: 'redact', match: { output: ['\\bKEY-[0-9A-F]{8}\\b'] } }, message: '' } as never
    const masked = maskResponse(response, [hit])
    assert.equal(masked.count, 1)
    assert.ok(sameShape(response, masked.value))
    assert.equal((masked.value as typeof response).file.content, 'a [REDACTED:r] b')
    assert.equal(outputText(response).includes('KEY-0A1B2C3D'), true)
    assert.equal(sameShape({ a: 'x' }, { a: 1 }), false)
    assert.ok(core.builtin.length > 0)
  })

  it('replaces only content leaves for a post_tool block', () => {
    const out = replaceResponse({ type: 'text', file: { filePath: '/r/a', content: 'secret' } }, 'Blocked') as { type: string, file: { content: string, filePath: string } }
    assert.deepEqual(out, { type: 'text', file: { filePath: '/r/a', content: 'Blocked' } })
    assert.equal(replaceResponse('plain', 'Blocked'), 'Blocked')
  })
})

describe('Claude Code PreToolUse', () => {
  it('denies a block hit with the reason and the override hint', async () => {
    const { env, cwd } = setup()
    const out = decision(await pre(env, cwd, 'Bash', { command: 'git push --force origin main' }))
    assert.equal(out.decision, 'deny')
    assert.match(out.reason ?? '', /\[t\.block-push\] No force pushes\./)
    assert.match(out.reason ?? '', /# guard: allow/)
  })

  it('turns an ask hit into a deny that asks for the user agreement in the chat', async () => {
    const { env, cwd } = setup()
    const out = decision(await pre(env, cwd, 'Bash', { command: 'rm -rf build' }))
    assert.equal(out.decision, 'deny')
    assert.match(out.reason ?? '', /needs the user's agreement: \[t\.ask-rm\]/)
    assert.match(out.reason ?? '', /Only after the user agrees, run the same command again with `# guard: allow/)
  })

  it('lets an ask rule pass with the override comment, without override: true', async () => {
    const { root, env, cwd } = setup()
    assert.equal(await pre(env, cwd, 'Bash', { command: 'rm -rf build # guard: allow user agreed in chat' }), undefined)
    const log = readFileSync(join(root, 'home', 'log.jsonl'), 'utf8')
    assert.match(log, /"verdict":"override","reason":"user agreed in chat"/)
    assert.match(log, /"harness":"claude-code"/)
  })

  it('does not offer the comment for an ask hit on a non-shell tool', async () => {
    const { env, cwd } = setup()
    const out = decision(await pre(env, cwd, 'Write', { file_path: join(cwd, '.env'), content: 'X=1' }))
    assert.equal(out.decision, 'deny')
    assert.match(out.reason ?? '', /not a shell command/)
  })

  it('passes warn hits as additional context and allows by giving no output', async () => {
    const { env, cwd } = setup()
    assert.deepEqual(decision(await pre(env, cwd, 'Bash', { command: 'curl https://example.com' })), { context: 'dsh-guard warning [t.warn-curl]: Network access noted.' })
    assert.equal(await pre(env, cwd, 'Bash', { command: 'ls' }), undefined)
  })

  it('never emits allow', async () => {
    const { env, cwd } = setup()
    for (const command of ['ls', 'curl x', 'rm -rf a', 'git push --force']) {
      const out = await pre(env, cwd, 'Bash', { command })
      assert.notEqual((out?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision, 'allow')
    }
  })

  it('reports internal errors instead of passing silently', () => {
    const open = failureOutput('pre', new Error('boom'), 'open')
    assert.match(String(open.systemMessage), /internal error in the PreToolUse hook; this call was NOT checked: boom/)
    const closed = failureOutput('pre', new Error('boom'), 'closed')
    assert.equal((closed.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'deny')
  })

  it('denies when a hook process gets unparseable input, in fail-closed mode', () => {
    const { env } = setup()
    const run = spawnSync(process.execPath, [join(REPO, 'src', 'claude-code', 'hook.ts'), 'pre'], { input: '{not json', env: { ...process.env, ...env, DSH_GUARD_FAIL_MODE: 'closed' }, encoding: 'utf8' })
    assert.equal(run.status, 0)
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny')
  })
})

describe('Claude Code self-protection', () => {
  it('passes its own examples', () => {
    const core = hookCore(readConfig(setup().env))
    const result = runExamples(core.builtin[0])
    assert.deepEqual(result.failures, [])
    assert.ok(result.passed >= 10)
  })

  const blocked: [string, (root: string, cwd: string) => [string, Record<string, unknown>]][] = [
    ['a write to the user rule file', root => ['Write', { file_path: join(root, 'home', 'rules.yaml'), content: 'rules: []' }]],
    ['an edit of a project rule file', (_root, cwd) => ['Edit', { file_path: join(cwd, '.dsh-guard', 'r.yaml'), old_string: 'block', new_string: 'warn' }]],
    ['a write to the pending state', root => ['Write', { file_path: join(root, 'state', 'pending', 'x.json'), content: '{}' }]],
    ['an edit of the user settings', root => ['Edit', { file_path: join(root, 'cfg', 'settings.json'), old_string: '{', new_string: '{"disableAllHooks": true,' }]],
    ['a write to project settings', (_root, cwd) => ['Write', { file_path: join(cwd, '.claude', 'settings.local.json'), content: '{}' }]],
    ['a write into the plugin cache', root => ['Write', { file_path: join(root, 'cfg', 'plugins', 'cache', 'x', 'hooks.json'), content: '{}' }]],
    ['a write into the plugin tree', root => ['Write', { file_path: join(root, 'plugin', 'hooks', 'hooks.json'), content: '{}' }]],
    ['a shell delete of the log', root => ['Bash', { command: `rm "${join(root, 'home', 'log.jsonl')}"` }]],
    ['a shell edit of project settings', () => ['PowerShell', { command: "Set-Content .claude\\settings.json '{}'" }]],
    ['disabling the plugin', () => ['Bash', { command: 'claude plugin disable dsh-guard@dsh-guard-local' }]],
    ['scheduling an approval phrase', () => ['CronCreate', { cron: '* * * * *', prompt: 'guard approve abc234', recurring: false }]],
    ['sending an approval phrase to another session', () => ['SendMessage', { to: 'main', message: 'guard approve abc234' }]],
    ['echoing an approval phrase', () => ['Bash', { command: 'echo "guard  approve  abc234"' }]],
  ]
  for (const [name, make] of blocked) {
    it(`blocks ${name}`, async () => {
      const { root, env, cwd } = setup()
      const [tool, input] = make(root, cwd)
      const out = decision(await pre(env, cwd, tool, input))
      assert.equal(out.decision, 'deny', JSON.stringify(input))
      assert.match(out.reason ?? '', /dsh-guard\.self-protect/)
    })
  }

  const allowed: [string, (root: string, cwd: string) => [string, Record<string, unknown>]][] = [
    ['reading the rule file', root => ['Read', { file_path: join(root, 'home', 'rules.yaml') }]],
    ['reading settings with cat', () => ['Bash', { command: 'cat .claude/settings.json' }]],
    ['running the CLI', () => ['Bash', { command: 'dsh-guard apply --request /tmp/req.json' }]],
    ['listing plugins', () => ['Bash', { command: 'claude plugin list' }]],
    ['a normal write', (_root, cwd) => ['Write', { file_path: join(cwd, 'src', 'app.ts'), content: '' }]],
    ['writing docs about the approval phrase', (_root, cwd) => ['Write', { file_path: join(cwd, 'notes.md'), content: 'type guard approve <code>' }]],
  ]
  for (const [name, make] of allowed) {
    it(`allows ${name}`, async () => {
      const { root, env, cwd } = setup()
      const [tool, input] = make(root, cwd)
      assert.equal(decision(await pre(env, cwd, tool, input)).decision, undefined, JSON.stringify(input))
    })
  }
})

describe('Claude Code PostToolUse', () => {
  it('masks redact matches through updatedToolOutput', async () => {
    const { env, cwd } = setup()
    const out = await handle('post', { cwd, tool_name: 'Bash', tool_input: { command: 'cat k' }, tool_response: { stdout: 'value KEY-0A1B2C3D', stderr: '', interrupted: false, isImage: false } }, env)
    const updated = (out?.hookSpecificOutput as { updatedToolOutput: { stdout: string, interrupted: boolean } }).updatedToolOutput
    assert.equal(updated.stdout, 'value [REDACTED:t.redact-key]')
    assert.equal(updated.interrupted, false)
  })

  it('masks the persisted file of a large output in place, beyond what the hook was given', async () => {
    const { root, env, cwd } = setup()
    const file = join(root, 'cfg', 'projects', 'k', 's', 'tool-results', 'b1.txt')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `head KEY-0A1B2C3D\n${'x'.repeat(5000)}\ntail KEY-FFFF0000\n`)
    const out = await handle('post', { cwd, tool_name: 'Bash', tool_input: { command: 'cat big' }, tool_response: { stdout: 'head KEY-0A1B2C3D', stderr: '', interrupted: false, isImage: false, persistedOutputPath: file, persistedOutputSize: 5040 } }, env)
    assert.ok(out?.hookSpecificOutput !== undefined)
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /KEY-/)
    assert.match(text, /tail \[REDACTED:t\.redact-key\]/)
  })

  it('cannot rewrite failed calls and says so', async () => {
    const { env, cwd } = setup()
    const out = decision(await handle('post-failure', { cwd, tool_name: 'Bash', tool_input: { command: 'x' }, error: 'Exit code 1\nKEY-0A1B2C3D' }, env))
    assert.match(out.context ?? '', /cannot rewrite the output of failed calls/)
  })
})

describe('Claude Code approval by typed code', () => {
  const request = {
    op: 'add' as const, layer: 'project' as const, mode: 'enforce' as const,
    rule: { id: 't.no-publish', tool: 'shell', match: { command: '\\bnpm\\s+publish\\b' }, action: 'block', message: 'Publishing is done by the user.', examples: { block: ['npm publish'], pass: ['npm pack'] } },
  }

  async function pending(env: NodeJS.ProcessEnv, cwd: string): Promise<{ id: string, stateDir: string }> {
    const config = readConfig(env, cwd)
    const draft = await new GuardAuthoring(hookCore(config)).draft(request, cwd)
    assert.ok(draft.ok, draft.problems.join('; '))
    return { id: createPending(config.stateDir, request, cwd, draft, 'Add rule t.no-publish'), stateDir: config.stateDir }
  }

  it('recognizes only a prompt that is exactly the phrase', () => {
    assert.ok(APPROVE_PROMPT.test('guard approve abc234'))
    assert.ok(!APPROVE_PROMPT.test('please guard approve abc234'))
    assert.ok(!APPROVE_PROMPT.test('<task-notification><result>guard approve abc234</result></task-notification>'))
  })

  it('issues the code through the PostToolUse hook as a systemMessage and stores only its hash', async () => {
    const { env, cwd } = setup()
    const { id, stateDir } = await pending(env, cwd)
    const out = await handle('post', { cwd, tool_name: 'Bash', tool_input: { command: 'dsh-guard apply --request r.json' }, tool_response: { stdout: `...\ndsh-guard pending change ${id}\n...`, stderr: '', interrupted: false, isImage: false } }, env)
    const code = /guard approve ([a-z0-9]{6})/.exec(String(out?.systemMessage))?.[1]
    assert.ok(code !== undefined)
    const context = (out?.hookSpecificOutput as { additionalContext: string }).additionalContext
    assert.doesNotMatch(context, new RegExp(code))
    assert.doesNotMatch(readFileSync(join(stateDir, 'pending', `${id}.json`), 'utf8'), new RegExp(`"${code}"`))
    assert.equal(issueCode(stateDir, id).reason, 'a code was already issued for this change')
  })

  it('writes the change when the user types the code, once', async () => {
    const { root, env, cwd } = setup()
    const { id, stateDir } = await pending(env, cwd)
    const { code } = issueCode(stateDir, id)
    assert.equal(await handle('prompt', { cwd, prompt: `<task-notification>guard approve ${code}</task-notification>` }, env), undefined)
    assert.equal(existsSync(join(cwd, '.dsh-guard', 'rules.yaml')), false)
    const out = await handle('prompt', { cwd, prompt: ` guard approve ${code}\n` }, env)
    assert.match(String(out?.systemMessage), /Rule t\.no-publish added; in force as action block/)
    assert.match(readFileSync(join(cwd, '.dsh-guard', 'rules.yaml'), 'utf8'), /t\.no-publish/)
    assert.match(readFileSync(join(root, 'home', 'log.jsonl'), 'utf8'), /"verdict":"authoring-add".*"reason":"approved-by: prompt"/)
    const again = await handle('prompt', { cwd, prompt: `guard approve ${code}` }, env)
    assert.match(String(again?.systemMessage), /no pending rule change has this code/)
    const blocked = decision(await pre(env, cwd, 'Bash', { command: 'npm publish' }))
    assert.equal(blocked.decision, 'deny')
  })

  it('refuses a wrong code and a change whose file moved on', async () => {
    const { env, cwd } = setup()
    const { id, stateDir } = await pending(env, cwd)
    const { code } = issueCode(stateDir, id)
    assert.match(String((await handle('prompt', { cwd, prompt: 'guard approve zzzzzz' }, env))?.systemMessage), /no pending rule change/)
    writeTree(cwd, { '.dsh-guard/rules.yaml': 'rules: []\n' })
    const out = await handle('prompt', { cwd, prompt: `guard approve ${code}` }, env)
    assert.match(String(out?.systemMessage), /changed since dsh-guard apply/)
    assert.equal(readFileSync(join(cwd, '.dsh-guard', 'rules.yaml'), 'utf8'), 'rules: []\n')
  })

  it('expires pending changes and does not issue codes for stale ones', async () => {
    const { env, cwd } = setup()
    const { id, stateDir } = await pending(env, cwd)
    assert.match(issueCode(stateDir, id, Date.now() + 10 * 60 * 1000).reason ?? '', /too old/)
    const { code } = issueCode(stateDir, id)
    assert.equal(findByCode(stateDir, code as string, Date.now() + PENDING_TTL_MS + 1000), undefined)
    assert.equal(listPending(stateDir).length, 0)
  })
})

describe('Claude Code transcripts', () => {
  function projects(): { dir: string, cwd: string } {
    const dir = tempDir('dsh-guard-cc-projects-')
    const cwd = '/work/demo'
    const project = join(dir, projectKey(cwd))
    mkdirSync(join(project, 'sess', 'subagents'), { recursive: true })
    copyFileSync(join(FIXTURES, 'transcript.jsonl'), join(project, '00000000-0000-4000-8000-000000000001.jsonl'))
    copyFileSync(join(FIXTURES, 'subagent.jsonl'), join(project, 'sess', 'subagents', 'agent-fixture.jsonl'))
    return { dir, cwd }
  }

  it('reads tool calls and results and skips lines it cannot parse', () => {
    const parsed = parseTranscript(readFileSync(join(FIXTURES, 'transcript.jsonl'), 'utf8'), 'x')
    assert.equal(parsed.badLines, 1)
    assert.deepEqual(parsed.calls.map(call => [call.tool, call.callId]), [['Bash', 'toolu_fixture_01'], ['Read', 'toolu_fixture_02'], ['Bash', 'toolu_fixture_03']])
    assert.equal(parsed.calls[0].output, 'npm notice dry run')
    assert.equal(parsed.calls[1].output, 'API_KEY=fixture-key-0000')
    assert.equal(parsed.calls[2].output, undefined)
    assert.equal(parsed.calls[0].cwd, '/work/demo')
  })

  it('lists newest calls first across sessions and subagents, filtered by project', async () => {
    const { dir, cwd } = projects()
    const history = await transcriptHistory({ projectsDir: dir, project: cwd })(500)
    assert.equal(history.calls.length, 4)
    assert.equal(history.calls[0].callId, 'toolu_fixture_04')
    assert.match(history.note ?? '', /1 transcript line/)
    const other = await transcriptHistory({ projectsDir: dir, project: '/elsewhere' })(500)
    assert.equal(other.calls.length, 0)
    assert.match(other.note ?? '', /--all-projects/)
    const missing = await transcriptHistory({ projectsDir: join(dir, 'nope') })(10)
    assert.match(missing.note ?? '', /history unavailable/)
  })

  it('replays a draft over the transcripts', async () => {
    const { dir, cwd } = projects()
    const { env } = setup()
    const core = hookCore(readConfig(env, cwd))
    const authoring = new GuardAuthoring(core)
    const result = await authoring.propose({ op: 'add', layer: 'user', rule: { id: 't.publish', tool: 'shell', match: { command: '\\bnpm\\s+publish\\b' }, action: 'block', message: 'm', examples: { block: ['npm publish'], pass: ['npm pack'] } } }, cwd, transcriptHistory({ projectsDir: dir, project: cwd }))
    assert.equal(result.replay?.scanned, 4)
    assert.equal(result.replay?.firing, 2)
  })
})

describe('Claude Code command line and plugin files', () => {
  function cli(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [join(REPO, 'src', 'claude-code', 'cli.ts'), ...args], { cwd, env: { ...process.env, ...env, CLAUDECODE: '1' }, encoding: 'utf8' })
  }

  it('proposes and stores a pending change without writing the rule file', () => {
    const { root, env, cwd } = setup()
    const request = JSON.stringify({ op: 'add', layer: 'project', rule: { id: 't.no-publish', tool: 'shell', match: { command: '\\bnpm\\s+publish\\b' }, action: 'block', message: 'm', examples: { block: ['npm publish'], pass: ['npm pack'] } } })
    const propose = cli(env, cwd, 'propose', '--request-json', request, '--projects-dir', join(root, 'cfg', 'projects'))
    assert.equal(propose.status, 0, propose.stderr)
    assert.match(propose.stdout, /^Proposal READY/)
    const apply = cli(env, cwd, 'apply', '--request-json', request, '--projects-dir', join(root, 'cfg', 'projects'))
    assert.equal(apply.status, 0, apply.stderr)
    assert.match(apply.stdout, /dsh-guard pending change [0-9a-f]{12}/)
    assert.match(apply.stdout, /Mode: OBSERVE/)
    assert.doesNotMatch(apply.stdout, /guard approve [a-z0-9]{6}/)
    assert.equal(existsSync(join(cwd, '.dsh-guard', 'rules.yaml')), false)
    assert.equal(readdirSync(join(root, 'state', 'pending')).length, 1)
  })

  it('refuses a request whose examples fail, and explains Claude Code calls', () => {
    const { env, cwd } = setup()
    const bad = JSON.stringify({ op: 'add', layer: 'user', rule: { id: 't.bad', tool: 'shell', match: { command: 'x' }, action: 'block', message: 'm', examples: { block: ['y'], pass: ['z'] } } })
    const apply = cli(env, cwd, 'apply', '--request-json', bad)
    assert.equal(apply.status, 1)
    assert.match(apply.stdout, /Not applied/)
    const explain = cli(env, cwd, 'explain', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }))
    assert.match(explain.stdout, /canonical: shell/)
    assert.match(explain.stdout, /verdict: ask \(t\.ask-rm\)/)
    const test = cli(env, cwd, 'test')
    assert.equal(test.status, 0, test.stdout)
  })

  it('keeps the plugin manifest in step with the package and the hook events', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }
    const manifest = JSON.parse(readFileSync(join(REPO, 'plugin', 'claude-code', '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string, version: string }
    assert.equal(manifest.name, 'dsh-guard')
    assert.equal(manifest.version, pkg.version)
    const hooks = readFileSync(join(REPO, 'plugin', 'claude-code', 'hooks', 'hooks.json'), 'utf8')
    const parsed = JSON.parse(hooks) as { hooks: Record<string, { hooks: { args?: string[] }[] }[]> }
    const events = Object.values(parsed.hooks).flat().flatMap(group => group.hooks).filter(handler => handler.args?.[0]?.endsWith('hook.js')).map(handler => handler.args?.[1])
    assert.deepEqual([...new Set(events)].sort(), [...EVENTS].sort())
    assert.doesNotMatch(hooks, /"allow"/)
    const closed = JSON.parse(failClosedHooks(hooks)) as { hooks: Record<string, { hooks: { onFailure?: string }[] }[]> }
    assert.equal(closed.hooks.PreToolUse[0].hooks[0].onFailure, 'block')
    assert.equal(closed.hooks.UserPromptSubmit[0].hooks[0].onFailure, undefined)
  })
})
