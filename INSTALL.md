# Installing dsh-guard: instructions for the agent

This page is written for the agent inside the DeepSeek Harness desktop app (or any other coding agent) that a user has asked to install, update or remove dsh-guard. The user may know nothing about computers. Do the steps yourself, keep what you say to the user short and plain, and answer in the user's language.

dsh-guard is a plugin for DeepSeek Harness that checks the agent's tool calls against rules the user creates. After installation it has no rules and changes nothing, except that it keeps the agent from editing its own guard configuration.

The installer downloads a prebuilt release from GitHub. It needs no git, no Node.js, no build and no administrator rights, and it changes no system settings. It writes only to one per-user folder and to the app's plugin list.

## 1. Find out the operating system

Run a harmless command, or use what you already know about the session:

- Windows: `$env:OS` in PowerShell, or `echo %OS%` in cmd, prints `Windows_NT`.
- macOS: `uname -s` prints `Darwin`.

Linux has no DeepSeek Harness desktop app; stop and tell the user that this installer is for the desktop app on Windows and macOS.

## 2. Run one command

Run exactly one of these commands with your shell tool. Allow it up to two minutes; it prints a few lines and ends.

**Windows** (works from PowerShell, cmd or Git Bash):

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.ps1 | iex"
```

**macOS:**

```
curl -fsSL https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.sh | sh -s --
```

The same command installs the first time and updates later; running it twice is safe.

## 3. Read the output

On success the last lines are:

```
NEXT STEP: Quit DeepSeek Harness completely and open it again.
CHECK: After the restart, ask the agent: "What guard rules do I have?" ...
```

and the lines above them say what happened, for example `Installed dsh-guard 0.1.1 in ...`, `Updated dsh-guard from 0.1.1 to 0.1.2 in ...`, `Added dsh-guard to profile 'desktop'.` or `Profile 'desktop' already loads dsh-guard from this folder.`

On failure a line starts with `dsh-guard install: ERROR:` and the command exits with code 1. What the errors mean:

| error text contains | meaning | what to do |
|---|---|---|
| `DeepSeek Harness was not found` | The app is not in its usual place. | Ask the user where the app is installed. On Windows the launcher is `<app folder>\resources\runtime\cli\bin\dsh.cmd`, on macOS `<app>.app/Contents/Resources/runtime/cli/bin/dsh`. Run the command again with `-Dsh "<path>"` (Windows) or `--dsh "<path>"` (macOS); see section 6 for the form with options. |
| `the desktop profile does not exist yet` | The app has never been started with this user account. | Tell the user to open DeepSeek Harness once, then run the command again. |
| `download failed` | GitHub could not be reached. | Check whether `https://github.com` is reachable. Try once more. If it still fails, tell the user that the computer cannot reach GitHub (a network, proxy or firewall problem) and that the installation needs it. |
| `not a valid zip` or `does not contain a dsh-guard package` | The download was damaged or replaced by a proxy page. | Run the command once more. If it fails again, report the exact error to the user. |
| `could not replace` | A file of the old version is in use. | Run the command once more. If it fails again, ask the user to quit DeepSeek Harness, open PowerShell (Windows) or Terminal (macOS), paste the command from section 2, and press Enter. |
| `is not a dsh-guard folder` | The install folder holds something else. | Do not delete it. Tell the user the folder name and ask what it is. |
| `dsh could not add the plugin` or `could not remove` | The app's plugin manager failed; its own output follows the error line. | Show the user the error lines unchanged and stop. |
| PowerShell reports that scripts are disabled or blocked by policy | The computer is managed by an organisation that forbids scripts. | Stop and tell the user that their administrator's policy prevents the installation. |

A pnpm warning about peer dependencies that do not resolve can appear in the output of the app's plugin manager; it is expected and harmless.

## 4. Tell the user what to do next

You cannot restart the app yourself, and you must not try: quitting the app ends this conversation. After a successful run, tell the user, in their language and in about these words:

> dsh-guard is installed. Please quit DeepSeek Harness completely (on Windows close the window and make sure it is not still running in the taskbar corner; on macOS press Cmd+Q) and open it again. Then ask me: "What guard rules do I have?" If I answer that there are no rules yet and mention the built-in rule dsh-guard.self-protect, it works.

After an update, say that it was updated and that the same restart is needed. If the output said the plugin was already installed and the version did not change, say so; a restart is still harmless.

When the user asks "What guard rules do I have?" in the new session, call the tool `guard_list` and pass its answer on. If the tool does not exist, the plugin did not load: check that the user really quit the app (not only closed the window), and run the installer again.

To create a first rule, the user only has to describe in words what the agent should not be allowed to do; the plugin's own guidance explains the rest to the agent.

## 5. Update and remove

- **Update** ("update dsh-guard"): run the same command as in section 2. Rules the user has created are kept. Then ask the user to restart the app as in section 4.
- **Remove** ("remove dsh-guard", "uninstall dsh-guard"): only when the user asked for it in this conversation. Run:

  Windows:

  ```
  powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.ps1))) -Uninstall"
  ```

  macOS:

  ```
  curl -fsSL https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.sh | sh -s -- --uninstall
  ```

  This removes the plugin from the app and deletes its folder. The user's rules (the folder `.dsh-guard` in the user's home folder) are kept, and the output says so; tell the user that they can delete that folder by hand if they no longer want the rules. Then ask the user to restart the app. Do not use the app's plugin manager tool to disable or remove dsh-guard: the guard blocks that and asks for the user instead.

## 6. Options

Options are passed after the script. On Windows use the `[scriptblock]` form shown under Remove and put the options at the end; on macOS put them after `sh -s --`.

| Windows | macOS | effect |
|---|---|---|
| `-Version v0.1.1` | `--version v0.1.1` | install this release instead of the latest |
| `-Profile <name>` | `--profile <name>` | install into another dsh profile (default `desktop`, the app's own) |
| `-Dsh "<path>"` | `--dsh "<path>"` | use this dsh launcher |
| `-InstallDir "<folder>"` | `--install-dir "<folder>"` | install folder (default `%LOCALAPPDATA%\dsh-guard`, macOS `~/Library/Application Support/dsh-guard`) |
| `-Uninstall` | `--uninstall` | remove, as in section 5 |

## 7. Rules for the agent

- Do not edit `~/.dsh` (the app's configuration), the install folder or the rule files in `~/.dsh-guard` by hand. Once dsh-guard is loaded, its built-in self-protection rule blocks such edits; rules are created and changed through the guard tools after the user approves.
- Do not install Node.js, git or anything else for this; the installer does not need it.
- Do not start, stop or kill the DeepSeek Harness app.
- Quote error messages exactly when you report them; do not guess at causes beyond the table in section 3.
