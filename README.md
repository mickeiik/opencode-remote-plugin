# OpenCode Remote Plugin

This is a fork of [`@daytona/opencode`](https://github.com/daytona/integrations/tree/main/packages/opencode-plugin) that replaces Daytona sandboxes with any machine you can reach over SSH. All OpenCode sessions run on your remote machine — the agent works entirely there, while changes stay synchronized to local git branches.

No Daytona account, API key, or SDK is involved anymore: if you can `ssh user@host`, you can run OpenCode sessions on that host.

## Features

- Runs each OpenCode session on a remote machine you control (server, homelab box, CI runner…)
- The agent's file operations, shell commands, and searches all execute on the remote machine — your system is never exposed
- Shadows OpenCode's built-in `apply_patch` tool with a plugin implementation that applies patches on the machine over SSH, so patch-based edits also land there even with models (GPT-5 family) that force-enable the built-in
- Background git sync keeps each session mirrored to a local `opencode/N` branch
- Each session gets its own numbered working directory on the machine, so several sessions can share one machine concurrently
- Uses your normal SSH setup: `~/.ssh/config`, keys, agents, jump hosts
- Optional host-key pinning for noninteractive environments (CI, supervised agent runs)

## Requirements

**Local machine**

- OpenCode
- Linux or macOS — Windows is not supported (see note below)
- Your project must be a git repository (`git init`)

> [!NOTE]
> **Windows hosts are not supported.** The plugin runs commands through the system `ssh` binary and keeps a single multiplexed SSH connection open between commands (`ControlMaster`/`ControlPath`), so it doesn't pay a fresh TCP connection + authentication handshake for every command it runs. OpenSSH's Windows port does not implement connection multiplexing and rejects these options, which makes every plugin SSH call fail on Windows. Workaround: run OpenCode (and this plugin) inside [WSL](https://learn.microsoft.com/en-us/windows/wsl/about), which provides the full Linux OpenSSH. The remote machine itself can be anything with an SSH server.

**Remote machine**

- SSH server with key-based authentication configured for noninteractive login
- `git` installed
- Whatever toolchain your project needs (the plugin does not provision anything — prepare the machine yourself once)

## Installation

Point your project's `opencode.json` at this checkout:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-remote-plugin/.opencode/plugin"]
}
```

To load it globally, put the same entry in `~/.config/opencode/opencode.json`.

## Environment Configuration

Configure the remote machine through environment variables:

| Variable                  | Required | Description                                                        |
| ------------------------- | -------- | ------------------------------------------------------------------ |
| `REMOTE_HOST`             | yes      | Target machine — a bare hostname/IP or `user@host`                 |
| `REMOTE_PORT`             | no       | SSH port (default `22`)                                            |
| `REMOTE_USER`             | no       | Login user (default: your local username, like plain `ssh`)        |
| `REMOTE_PROJECT_PATH`     | yes      | Directory root on the machine where session workspaces are created |
| `REMOTE_SSH_KNOWN_HOSTS`  | no       | Path to a `known_hosts` file used to pin the machine's host key    |

Or create a `.env` file in your project root:

```env
REMOTE_HOST=buildbox.example.com
REMOTE_USER=dev
REMOTE_PROJECT_PATH=/home/dev/projects/myapp
```

Anything else — identity files, `ProxyJump`, aliases — comes from your regular `~/.ssh/config`; the plugin deliberately does not manage keys itself. A typical setup looks like:

```ssh-config
# ~/.ssh/config
Host buildbox
    HostName buildbox.example.com
    User dev
    IdentityFile ~/.ssh/id_ed25519_buildbox
    ForwardAgent no
```

```bash
export REMOTE_HOST=buildbox
export REMOTE_PROJECT_PATH=/home/dev/projects/myapp
```

### Pinning the host key

Git syncing transfers commits between your machine and the remote machine over SSH. By default, host verification follows your normal SSH configuration — on a machine that has never connected before, this means an interactive trust-on-first-use prompt, which blocks noninteractive environments such as CI or supervised agent runs.

To make syncing noninteractive and independently verifiable, point `REMOTE_SSH_KNOWN_HOSTS` at a `known_hosts` file containing the machine's host keys:

```bash
mkdir -p ~/.config/opencode-remote
ssh-keyscan buildbox.example.com > ~/.config/opencode-remote/known_hosts
export REMOTE_SSH_KNOWN_HOSTS=~/.config/opencode-remote/known_hosts
```

Verify the collected fingerprints out of band (`ssh-keygen -lf ~/.config/opencode-remote/known_hosts`) before trusting the file. When `REMOTE_SSH_KNOWN_HOSTS` is set, git transfers use that file as the only host-key database (`StrictHostKeyChecking=yes`, system-wide known hosts ignored); SSH behavior for every other remote is unaffected. When unset, behavior is unchanged. Paths containing spaces are supported; a literal `"` in the path is rejected.

## Running OpenCode

Before starting OpenCode, ensure that your project is a git repository:

```bash
git init
```

Now start OpenCode in your project:

```bash
opencode
```

To check that the plugin is working, type `pwd` in the chat. You should see a path on the remote machine (e.g. `/home/dev/projects/myapp/1`), and a toast notification that a new session was started.

OpenCode creates local branches using the format `opencode/1`, `opencode/2`, etc., each mirroring the session's working directory on the machine. To work with these changes, use normal git commands in a separate terminal window:

```
git branch          # list branches
git checkout opencode/1   # check out OpenCode's latest changes locally
```

To view live logs from the plugin for debugging, run this command in a separate terminal:

```bash
tail -f ~/.local/share/opencode/log/remote.log
```

If the agent starts a dev server on the remote machine, reach it with an SSH tunnel from your machine:

```bash
ssh -L 3000:localhost:3000 buildbox
```

(Managed preview links are a Daytona-only feature and were removed in this fork.)

## How It Works

### File Synchronization

The plugin uses git to synchronize files between the remote machine and your local system. This happens automatically and in the background, keeping your copy of the code up-to-date without exposing your system to the agent.

#### Setup

When a session starts:

1. The plugin looks for a git repository in the local directory. If none is found, file synchronization will be disabled.
2. A parallel bare repository is created on the machine, and a session workspace is created under `REMOTE_PROJECT_PATH` (numbered directories: `1`, `2`, … so concurrent sessions never collide).
3. A new git remote (currently named `sandbox`) is added to the local repository, connecting to the machine over SSH.
4. The `HEAD` of the local repository is pushed to the machine, and the workspace is reset to match this initial state.
5. Each session is assigned a unique incrementing number that persists across sessions; the workspace and the local `opencode/N` branch both derive from it.

#### Synchronization

Each time the agent makes changes:

1. A new commit is created in the workspace repository on the `opencode` branch.
2. The plugin pulls the latest commits into the unique local branch `opencode/N`. This keeps both sides in sync while isolating changes from different sessions in separate local branches.

The plugin only synchronizes changes from the remote machine to your system. To pass local changes to the agent, commit them to a local branch, and start a new OpenCode session with that branch checked out.

> [!CAUTION]
> When changes are synchronized to local `opencode` branches, any locally made changes will be overwritten.

#### Sync guarantees

The per-turn sync runs in the background: OpenCode dispatches the `session.idle` event without waiting for plugin work, so observing that event does not mean the changes have reached your local repository yet. The plugin provides two stronger boundaries:

- **`gitSync` tool** — commits pending changes on the machine and pulls them into the local `opencode/N` branch, returning only after they are in the local repository. Failures are returned as tool errors. Automation that needs a reliable handoff (for example, a supervisor driving OpenCode through the SDK) should ask the agent to run `gitSync` as its final step and check the tool result instead of treating `session.idle` as proof that changes have landed.
- **Shutdown** — when OpenCode shuts down gracefully, it waits (up to 60 seconds) for the plugin to finish in-flight syncs before exiting.

There is no sandbox deletion step in this fork: the remote machine persists, and the plugin never deletes anything on it. Deleting an OpenCode session only removes the local mapping and stops syncing it; leftover workspaces under `REMOTE_PROJECT_PATH` are yours to clean up manually.

### Session to machine mapping

The plugin keeps track of which machine and workspace belong to each OpenCode session using local state files. This data is stored in a separate JSON file for each project:

- Default (when `XDG_DATA_HOME` is unset): `~/.local/share/opencode/storage/remote/[projectid].json`.
- When `XDG_DATA_HOME` is set: `$XDG_DATA_HOME/opencode/storage/remote/[projectid].json`.

Each JSON file contains the machine details and workspace metadata for each session in the project, including when it was created and last used.

The plugin uses [XDG Base Directory](https://specifications.freedesktop.org/basedir/latest/) specifically to resolve the path to this directory, following the convention [set by OpenCode](https://github.com/anomalyco/opencode/blob/052f887a9a7aaf79d9f1a560f9b686d59faa8348/packages/opencode/src/global/index.ts#L8).

## Differences From the Upstream Daytona Plugin

| Upstream                                   | This fork                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Ephemeral sandbox per session              | One persistent machine shared by sessions, isolated by workspace + git |
| Sandboxes created from snapshots           | Nothing is provisioned; you prepare the machine yourself               |
| Live preview links for started servers     | Use SSH tunnels (`ssh -L`)                                             |
| Sandbox state cleaned up on session delete | Remote files are never touched; only local mapping/state is removed    |
| Daytona SDK + API key                      | Just SSH                                                               |

## Development

This is a standalone repo — no monorepo tooling, no workspace dependencies beyond the ones declared in `package.json`.

### Setup

```bash
git clone <this-repo>
cd opencode-remote-plugin
npm install
```

### Development and Testing

To modify the plugin, edit the source code files in `.opencode/plugin`.

To test the plugin, create a test project to run OpenCode in:

```bash
mkdir ~/myproject
cd ~/myproject
```

Add a symlink from the project directory to the plugin source code:

```
ln -s [ABSOLUTE_PATH_TO_REPO]/opencode-remote-plugin/.opencode .opencode
```

Initialize git to enable file syncing:

```
git init
```

Start OpenCode in the test project:

```bash
opencode
```

Use the instructions from [Running OpenCode](#running-opencode) above to check that the plugin is running and view live logs for debugging.

> [!NOTE]
> When developing locally with a symlink, OpenCode loads the TypeScript source directly, so no build step is required.

### Building

Build the plugin — `tsc` compiles `.opencode/plugin/**/*.ts` to `.js` + `.d.ts` in place:

```bash
npm run build
```

To test the built package, create a test project and add a plugin loader file (replace `[ABSOLUTE_PATH_TO_REPO]` with your clone path):

```bash
mkdir -p ~/myproject && cd ~/myproject
mkdir -p .opencode/plugins
cat > .opencode/plugins/opencode-remote.js << 'EOF'
module.exports = require('[ABSOLUTE_PATH_TO_REPO]/opencode-remote-plugin/.opencode/plugin')
EOF
```

Initialize git to enable file syncing, configure `REMOTE_*` variables, and start OpenCode:

```bash
git init
opencode
```

Type-check the sources with:

```bash
npm run typecheck
```

## Project Structure

```
opencode-remote-plugin/
├── .opencode/plugin/             # Plugin source (TypeScript)
│   ├── remote/                   # Main integration
│   └── index.ts                  # Plugin entry point (compiled to .js in place)
├── .gitignore
├── .npmignore
├── package.json                  # Package metadata (main/types + build script)
├── tsconfig.json                 # TypeScript config
└── README.md
```

## Credits & License

Based on [`@daytona/opencode`](https://github.com/daytona/integrations/tree/main/packages/opencode-plugin) by Daytona Platforms Inc., licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The original copyright and attribution notices are retained in [`LICENSE`](LICENSE).

Modifications © 2026 mickeiik, released under the same Apache-2.0 license.
