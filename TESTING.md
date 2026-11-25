# Testing dsh-guard

Thank you for trying dsh-guard. This page covers installing the plugin into the DeepSeek Harness desktop app, five short things to try, and what to send back. The README describes the plugin in full.

## Prerequisites

- The DeepSeek Harness desktop app (dsh 0.2.2-rc.5), on Windows or macOS, signed in to a DeepSeek account.
- The zip `dsh-guard-0.1.0.zip`, unpacked to a folder that stays where it is, for example `C:\Tools\dsh-guard-0.1.0` or `~/Tools/dsh-guard-0.1.0`. The app links this folder; moving or deleting it later breaks the plugin.
- No Node.js, npm or pnpm: the app brings its own.

## Install in three commands

Windows, in PowerShell:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add C:\Tools\dsh-guard-0.1.0
& $dsh --version
```

macOS, in a terminal (the launcher path is inferred from the Windows layout and not yet verified; if it does not exist, please report the path you found inside the app bundle):

```sh
dsh="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$dsh" plugin --profile desktop add ~/Tools/dsh-guard-0.1.0
"$dsh" --version
```

`plugin add` prints a warning that the linked package's peer dependencies will not resolve from the target `node_modules`; this is expected. Then quit the app completely and start it again.

## Five things to try

1. **No rules, nothing changes.** Work as usual for a few minutes. dsh-guard ships no rules, so every tool call should pass, except an attempt by the agent to edit the guard's own rule files or the dsh configuration.
2. **List the rules.** Ask the agent: "What guard rules do I have?" It should call `guard_list` and say that no rules exist yet, listing only the built-in rule `dsh-guard.self-protect`.
3. **Create a rule in conversation.** Ask for a rule that blocks something harmless, for example: "Create a guard rule that blocks shell commands which delete a file named `canary.txt`, but still lets me read it." Watch the agent ask about the boundary, then go through `guard_draft`, `guard_test` and `guard_replay`, and finally `guard_apply`, which shows an approval prompt with the rule, the example results and the replay hits. Approve it. A new rule starts in observe mode (it only warns) unless you ask for it to be enforced at once.
4. **Trigger it.** Create `canary.txt` in a scratch project and ask the agent to delete it. In observe mode the call runs and the agent receives a warning from dsh-guard; an enforced rule blocks the call with `Blocked by dsh-guard: [rule id] ...`. Asking the agent to read the file should pass.
5. **Ask the agent to edit the rule file directly.** Ask: "Open the guard rule file and change the rule by editing the YAML yourself." The built-in self-protection rule should block the write (and the same for a shell command that writes the file); the agent is expected to offer the change through `guard_apply` instead.

## What to send back

For anything that failed or surprised you, send:

- the dsh version (`dsh --version` with the launcher above) and your OS with its version;
- the `dsh-guard` row from `--dump-config` of a test profile, if you made one (see Try it in a headless session in the README), or otherwise the output of the `plugin add` command;
- the lines of `~/.dsh-guard/log.jsonl` (on Windows `%USERPROFILE%\.dsh-guard\log.jsonl`) for the failing call; each line is one decision, with its time, rule, verdict, tool and a one-line summary of the call;
- the exact error text, copied rather than paraphrased, and what you asked the agent.

The log records a summary of each checked call, which can include commands, file paths and parts of tool output. Read the lines before sending them and remove anything private.
