/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { RemoteSessionManager } from '../core/session-manager'
import { shellQuote } from '../core/ssh'

export const readTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Reads file from the remote machine',
  args: {
    filePath: z.string(),
  },
  async execute(args: { filePath: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const result = await ssh.exec(`cat -- ${shellQuote(args.filePath)}`, { cwd: session.workspacePath })
    if (result.code !== 0) {
      throw new Error(`Failed to read ${args.filePath}: ${result.stderr || result.stdout}`)
    }
    return result.stdout
  },
})
