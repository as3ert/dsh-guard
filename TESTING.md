# Testing dsh-guard

Thank you for trying dsh-guard. This page covers installing the plugin into the DeepSeek Harness desktop app, five short things to try, and what to send back. The README describes the plugin in full.

## Prerequisites

- The DeepSeek Harness desktop app (dsh 0.2.2-rc.5), on Windows or macOS, signed in to a DeepSeek account.
- No Node.js, npm or pnpm for the plugin itself: the app brings its own. The optional command line (`dsh-guard test`, `lint`, `stats`, `explain`, used in item 3 below) is a Node script that needs Node.js 24.9 or later. On Windows you can run it with the node the app bundles, without installing anything (see Command line check below); on macOS this is unverified.

## Install by asking the agent

Open the DeepSeek Harness desktop app and tell its agent:

```
Install dsh-guard from https://github.com/as3ert/dsh-guard
```

The agent reads [INSTALL.md](INSTALL.md), runs one installer command, and tells you to quit the app completely and open it again. After the restart, ask the agent "What guard rules do I have?" to check that the plugin loaded. Updating and removing work the same way: "update dsh-guard", "remove dsh-guard". Please report it if the agent does something other than what INSTALL.md describes, or if the installer prints a line starting with `dsh-guard install: ERROR:`.

The installer unpacks the plugin to `%LOCALAPPDATA%\dsh-guard` (Windows) or `~/Library/Application Support/dsh-guard` (macOS) and adds it to the `desktop` profile. The same commands can be run by hand; they are listed in INSTALL.md and in the README under "Installer scripts". The macOS installer has not yet been tried on macOS.

The sections below are the manual alternatives.

## Install from the zip in three commands

Download `dsh-guard-0.1.1.zip` from the [releases page](https://github.com/as3ert/dsh-guard/releases) and unpack it to a folder that stays where it is, for example `C:\Tools\dsh-guard-0.1.1` or `~/Tools/dsh-guard-0.1.1`. The app links this folder; moving or deleting it later breaks the plugin.

Windows, in PowerShell:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add C:\Tools\dsh-guard-0.1.1
& $dsh --version
```

macOS, in a terminal (the path inside the app bundle comes from the app's own command installer, but the location `/Applications` is not yet verified; if the launcher does not exist there, please report the path you found inside the app bundle):

```sh
dsh="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$dsh" plugin --profile desktop add ~/Tools/dsh-guard-0.1.1
"$dsh" --version
```

`plugin add` prints a warning that the linked package's peer dependencies will not resolve from the target `node_modules`; this is expected. Then quit the app completely and start it again.

## Install from a Git checkout

An alternative to the zip, for anyone who prefers to follow the repository. Clone it to a folder that stays where it is, then run one command from the checkout. On Windows, in PowerShell:

```powershell
git clone https://github.com/as3ert/dsh-guard.git C:\Tools\dsh-guard
cd C:\Tools\dsh-guard
.\scripts\setup.ps1
```

On macOS or Linux (unverified there):

```sh
git clone https://github.com/as3ert/dsh-guard.git ~/Tools/dsh-guard
cd ~/Tools/dsh-guard
sh scripts/setup.sh
```

The script finds the desktop app's `dsh` launcher (else `dsh` on the PATH), builds the plugin, adds the checkout to the `desktop` profile and installs two local git hooks. It uses the system Node.js 24.9 or later with npm when present, and otherwise the node and pnpm that the app bundles, so nothing needs to be installed first. Then quit the app completely and start it again.

Options: `-Profile <name>` (`--profile <name>`) installs into another profile, `-Dsh <path>` (`--dsh <path>`) names the launcher explicitly, and `-NoHook` (`--no-hook`) skips the hooks. Running the script again is safe: a profile that already loads dsh-guard is left as it is.

Updating is `git pull` followed by restarting the app. The `post-merge` hook (and `post-checkout`, for branch switches) rebuilds the plugin and prints `dsh-guard rebuilt; restart the DeepSeek Harness app`. An existing hook of your own is kept: the rebuild is appended to it, or skipped with a message when it is not a shell script. If the hooks are not wanted, `git pull` followed by `.\scripts\setup.ps1` (`sh scripts/setup.sh`) does the same by hand.

To uninstall, or to roll back to the zip install, remove the plugin from the profile, then restart the app:

```powershell
& $dsh plugin --profile desktop remove dsh-guard
```

and delete the two blocks marked `dsh-guard rebuild` from `.git/hooks/post-merge` and `.git/hooks/post-checkout` (or the files, when they contain nothing else).

## Five things to try

1. **No rules, nothing changes.** Work as usual for a few minutes. dsh-guard ships no rules, so every tool call should pass, except an attempt by the agent to edit the guard's own rule files or the dsh configuration.
2. **List the rules.** Ask the agent: "What guard rules do I have?" It should call `guard_list` and say that no rules exist yet, listing only the built-in rule `dsh-guard.self-protect`.
3. **Create a rule in conversation.** Ask for a rule that blocks something harmless, for example: "Create a guard rule that blocks shell commands which delete a file named `canary.txt`, but still lets me read it." Watch the agent list the rules, ask about the boundary, call `guard_propose` (draft, examples and replay in one call) until it is READY, show you the result, and finally call `guard_apply`. In the desktop app (and other interactive surfaces) `guard_apply` shows an approval prompt with the rule, the example results and the replay hits; approve it. A new rule starts in observe mode (it only warns) unless you ask for it to be enforced at once. In a headless session there is no approval channel and `guard_apply` answers `Not applied: the approval was unavailable; ...`; use the headless fallback below instead. If dsh's approval policy is set to never ask, `guard_apply` reports that dsh rejected the approval without showing it; switch the policy to ask for this change.
4. **Trigger it.** Create `canary.txt` in a scratch project and ask the agent to delete it. In observe mode the call runs and the agent receives a notice from dsh-guard, `dsh-guard observe [rule id]: this call was allowed; once enforced the rule would block it: ...`; an enforced rule blocks the call with `Blocked by dsh-guard: [rule id] ...`. Asking the agent to read the file should pass.
5. **Ask the agent to edit the rule file directly.** Ask: "Open the guard rule file and change the rule by editing the YAML yourself." The built-in self-protection rule should block the write (and the same for a shell command that writes the file); the agent is expected to offer the change through `guard_apply` instead.

### Headless fallback for item 3

Copy the drafted rule into `$DSH_GUARD_HOME/rules.yaml`, or `~/.dsh-guard/rules.yaml` (on Windows `%USERPROFILE%\.dsh-guard\rules.yaml`) when `DSH_GUARD_HOME` is not set. This complete file loads as-is; it is also shipped as `examples/canary-rule.yaml`. It is written as an enforced `block` rule; to mimic observe mode, use `action: warn` with `promote_to: block`.

```yaml
rules:
  - id: user.canary-delete
    doc: Deleting the file canary.txt is blocked; reading it is fine.
    tool: shell
    match:
      command: '\b(rm|del|unlink|Remove-Item)\b[^;&|]*\bcanary\.txt\b'
    action: block
    message: Deleting canary.txt is blocked by the tester rule.
    examples:
      block:
        - rm canary.txt
        - Remove-Item .\canary.txt
      pass:
        - cat canary.txt
        - ls
```

Check exactly this file with the command line before relying on it (from the package folder, with the Node described below):

```sh
node dist/cli.js test --no-user --rules examples/canary-rule.yaml
node dist/cli.js lint --no-user --rules examples/canary-rule.yaml
```

Both should report 0 failures and 0 errors. The rules are read when a session starts, so start a new session afterwards.

### Command line check

The command line needs Node.js 24.9 or later and is optional for testers. On Windows, the desktop app's own node (verified with app node 24.21.0) runs it; in PowerShell, from the unpacked package folder:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" dist/cli.js test --no-user --rules examples/canary-rule.yaml
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

Replace `test` with `lint`, `stats` or `explain '<json>'` as needed. Do not use the app's `runtimein
ode.cmd` directly: it needs the variable `DSH_DESKTOP_NODE_EXECUTABLE`, which only the app sets. On macOS the same approach (`ELECTRON_RUN_AS_NODE=1` with the app's executable inside the bundle) is unverified; otherwise install Node.js 24.9+ or skip this check.

## What to send back

For anything that failed or surprised you, send:

- the dsh version (`dsh --version` with the launcher above) and your OS with its version;
- the `dsh-guard` row from `--dump-config` of a test profile, if you made one (see below), or otherwise the output of the `plugin add` command;
- the lines of `~/.dsh-guard/log.jsonl` (on Windows `%USERPROFILE%\.dsh-guard\log.jsonl`) for the failing call; each line is one decision, with its time, rule, verdict, tool and a one-line summary of the call;
- the exact error text, copied rather than paraphrased, and what you asked the agent.

The log records a summary of each checked call, which can include commands, file paths and parts of tool output. Read the lines before sending them and remove anything private.

### Making a test profile (optional)

A separate profile keeps the app's own profile untouched. In PowerShell, with `$dsh` as above and the package at `C:\Tools\dsh-guard-0.1.1` (on macOS use the sh launcher and `~/Tools/dsh-guard-0.1.1`; the form is `dsh --profile <name>`, and a bare first argument is also taken as the profile name):

```powershell
& $dsh --profile guardtest --from-default-profile headless --dump-config
& $dsh plugin --profile guardtest add C:\Tools\dsh-guard-0.1.1
$env:DSH_GUARD_HOME = "$env:USERPROFILE\guardtest-rules"   # optional: separate rules and log
& $dsh --profile guardtest --dump-config
& $dsh --profile guardtest --patch C:\Tools\dsh-guard-0.1.1\examples\headless-account.yml "Call guard_list and quote its reply."
```

The first command creates `guardtest` from the shipped `headless` template. The overlay `examples/headless-account.yml` turns the signed-in DeepSeek account back on; with an API key, set `DEEPSEEK_API_KEY` instead and leave out `--patch`. Delete the folder `guardtest` below `~/.dsh/profiles` to remove the profile.
