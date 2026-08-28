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

export const lsTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Lists files in a directory on the remote machine',
  args: {
    dirPath: z.string().optional(),
  },
  async execute(args: { dirPath?: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const path = args.dirPath || session.workspacePath
    const result = await ssh.exec(`ls -1A -- ${shellQuote(path)}`, { cwd: session.workspacePath })
    if (result.code !== 0) {
      throw new Error(`Failed to list ${path}: ${result.stderr || result.stdout}`)
    }
    return result.stdout
      .split('\n')
      .filter((name) => name !== '')
      .join('\n')
  },
})
