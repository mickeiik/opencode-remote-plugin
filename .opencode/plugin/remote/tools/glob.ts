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

export const globTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Searches for files matching a pattern on the remote machine',
  args: {
    pattern: z.string(),
  },
  async execute(args: { pattern: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const result = await ssh.exec(`find . -type f -name ${shellQuote(args.pattern)}`, {
      cwd: session.workspacePath,
    })
    if (result.code !== 0) {
      throw new Error(`Failed to search for files matching ${args.pattern}: ${result.stderr || result.stdout}`)
    }
    return result.stdout
      .split('\n')
      .filter((path) => path !== '')
      .map((path) => (path.startsWith('./') ? path.slice(2) : path))
      .join('\n')
  },
})
