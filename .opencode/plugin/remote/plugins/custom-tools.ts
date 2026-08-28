/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import { createRemoteTools } from '../tools'
import { logger } from '../core/logger'
import type { RemoteSessionManager } from '../core/session-manager'

/**
 * Custom tools for the remote machine: file ops, command execution, search.
 */
export async function customTools(ctx: PluginInput, sessionManager: RemoteSessionManager) {
  logger.info('OpenCode started with remote machine plugin')
  const projectId = ctx.project.id
  // Active worktree (not ctx.project.worktree, which is the first-seen checkout persisted
  // per project); see the matching comment in plugins/session-events.ts.
  const worktree = ctx.worktree
  return createRemoteTools(sessionManager, projectId, worktree, ctx)
}
