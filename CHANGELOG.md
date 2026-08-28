# Changelog

All notable changes to this project are documented here. This project forked from [`@daytona/opencode`](https://github.com/daytona/integrations/tree/main/packages/opencode-plugin); upstream history up to version 0.192.0 is visible [there](https://github.com/daytona/integrations/blob/main/packages/opencode-plugin/CHANGELOG.md).

## [0.1.0] - 2026-08-26

Initial fork release, based on `@daytona/opencode` 0.192.0.

### Added

- `REMOTE_*` configuration resolution (`REMOTE_HOST`, `REMOTE_PORT`, `REMOTE_USER`, `REMOTE_PROJECT_PATH`, `REMOTE_SSH_KNOWN_HOSTS`) with `.env` support in the project root; process env takes precedence (issues #1, #2)
- SSH transport core (`core/ssh.ts`): `SshExecutor` runs commands over the system `ssh` binary (honoring `~/.ssh/config`, keys, agents, jump hosts) with ControlMaster connection reuse and keepalive probes that drop dead connections within ~45s; when `REMOTE_SSH_KNOWN_HOSTS` is set, command execution pins host-key verification to that file (same semantics as git transfers). Also exports `shellQuote` and `sshCommonArgs` helpers (issue #3)

### Changed

- Git layer migrated to the SSH/bare-repo design (issue #5): `git/host-git-manager.ts` reads `REMOTE_SSH_KNOWN_HOSTS` instead of `DAYTONA_SSH_KNOWN_HOSTS`, now always sets `GIT_SSH_COMMAND` for transfers (BatchMode + connection reuse via `core/ssh` helpers; host-key pinning appended only when `REMOTE_SSH_KNOWN_HOSTS` is set), uses `opencode-remote@localhost` for reservation commits, and gains `removeRemote()`; `git/sandbox-git-manager.ts` renamed to `remote-git-manager.ts` with `RemoteGitManager` (no SDK types) running git over `SshExecutor` in the remote workspace and transporting commits through a per-session bare repository (`initFromBare`, `ensureBareRepo`, `pushToBare`). The plugin does not compile until dependent modules are migrated (issues #6–#8)
- Session storage schema tracks the remote workspace instead of a sandbox: `SessionInfo.sandboxId` renamed to `workspacePath`, `SandboxInfo`/`SessionSandboxMap` and the `@daytona/sdk` import removed from `core/types.ts`, new `RemoteSession` in-memory session handle type, and `getBranchNumberForSandbox` renamed to `getBranchNumberForWorkspace` in `core/project-data-storage.ts` (issue #4). The plugin does not compile until dependent modules are migrated (issues #5–#8)
- Repositioned as `opencode-remote-plugin`: runs OpenCode sessions on any SSH-reachable machine instead of Daytona sandboxes (documentation updated)
- Package renamed from `@daytona/opencode` to `opencode-remote-plugin`; metadata points to this repository
