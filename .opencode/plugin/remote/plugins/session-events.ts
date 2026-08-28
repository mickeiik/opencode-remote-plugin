/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import { SessionGitManager } from '../git/session-git-manager'
import { EVENT_TYPE_SESSION_DELETED, EVENT_TYPE_SESSION_IDLE, type EventSessionDeleted } from '../core/types'
import { toast } from '../core/toast'
import { logger } from '../core/logger'
import { resolveRemoteConfig } from '../core/config'
import type { RemoteSessionManager } from '../core/session-manager'

/**
 * Handles OpenCode session events.
 */
export async function eventHandlers(ctx: PluginInput, sessionManager: RemoteSessionManager) {
  const projectId = ctx.project.id
  // Use the ACTIVE worktree, not ctx.project.worktree: the project worktree is persisted
  // the first time a project is opened and never updated, so in linked-worktree setups
  // (`git worktree add`) it can point at a different checkout than the one this OpenCode
  // instance is running in. Git syncs must land in the active checkout.
  const worktree = ctx.worktree
  return async (args: any) => {
    const event = args.event
    if (event.type === EVENT_TYPE_SESSION_DELETED) {
      const sessionId = (event as EventSessionDeleted).properties.info.id
      try {
        const deleted = await sessionManager.deleteSession(sessionId, projectId)
        if (deleted) {
          // Name the host when the config resolves; a missing config must not break deletion.
          let host: string
          try {
            host = resolveRemoteConfig(worktree).host
          } catch {
            host = 'the remote machine'
          }
          toast.show({
            title: 'Session removed',
            message: `Remote files left untouched on ${host}.`,
            variant: 'success',
          })
        }
      } catch (err: any) {
        toast.show({ title: 'Delete failed', message: err?.message || 'Failed to delete session.', variant: 'error' })
        throw err
      }
    } else if (event.type === EVENT_TYPE_SESSION_IDLE) {
      const sessionId = event.properties.sessionID
      const start = Date.now()
      try {
        // The WHOLE pipeline is enqueued (synchronously, before any await) so that a
        // dispose() or delete arriving while the workspace is still being resolved cannot
        // observe an empty queue and proceed mid-operation.
        const didSync = await SessionGitManager.enqueueSessionSync(sessionId, async () => {
          // Re-checked inside the queue entry: a deletion may have completed while this
          // callback waited its turn, and syncing must not resurrect the session.
          if (sessionManager.isSessionDeleting(sessionId)) return false
          const session = await sessionManager.getRemoteSession(sessionId, projectId, worktree, ctx)
          if (session.branchNumber === undefined) return false
          const sessionGit = new SessionGitManager(
            sessionManager.getSshExecutor(worktree),
            session.workspacePath,
            session.bareRepoPath,
            worktree,
            session.branchNumber,
          )
          return sessionGit.autoCommitAndPull(ctx)
        })
        logger.info(`[idle] done sessionId=${sessionId} synced=${didSync} in ${Date.now() - start}ms`)
      } catch (err: any) {
        // autoCommitAndPull already shows a toast; only log here to avoid a duplicate
        // error toast and noisy propagation out of the idle event hook.
        logger.error(`[idle] error sessionId=${sessionId} in ${Date.now() - start}ms: ${err}`)
      }
    }
  }
}
