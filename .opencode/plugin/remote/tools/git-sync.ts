/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { RemoteSessionManager } from '../core/session-manager'
import { SessionGitManager } from '../git/session-git-manager'

export const gitSyncTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Commits pending changes on the remote machine and pulls them into the local opencode/N branch. Returns only after the changes are in the local repository, and fails with the git error otherwise. Use as the final step when the user asks to sync, hand off, or finalize changes made on the remote machine.',
  args: {},
  async execute(_args: {}, ctx: ToolContext) {
    const sessionId = ctx.sessionID
    if (!sessionManager.hasSession(sessionId, projectId)) {
      return 'No remote workspace exists for this session; nothing to sync.'
    }
    const session = await sessionManager.getRemoteSession(sessionId, projectId, worktree, pluginCtx)
    const branchNumber = session.branchNumber
    if (branchNumber === undefined) {
      return 'Git syncing is disabled for this session (no local git repository); nothing to sync.'
    }
    const ssh = sessionManager.getSshExecutor(worktree)
    const sessionGit = new SessionGitManager(ssh, session.workspacePath, session.bareRepoPath, worktree, branchNumber)
    const didSync = await SessionGitManager.enqueueSessionSync(sessionId, () => sessionGit.autoCommitAndPull(pluginCtx))
    return didSync
      ? `Synced changes from the remote machine to local branch opencode/${branchNumber}.`
      : 'No changes to sync; the local repository is already up to date.'
  },
})
