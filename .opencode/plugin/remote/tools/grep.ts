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

export const grepTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Searches for text pattern in files on the remote machine',
  args: {
    pattern: z.string(),
  },
  async execute(args: { pattern: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const result = await ssh.exec(`grep -rnI -e ${shellQuote(args.pattern)} .`, { cwd: session.workspacePath })
    if (result.code === 1) {
      return 'No matches found'
    }
    if (result.code > 1) {
      throw new Error(`Failed to search for ${args.pattern}: ${result.stderr || result.stdout}`)
    }
    const lines = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (line.startsWith('./') ? line.slice(2) : line))
    const maxMatches = 100
    const formatted = lines.slice(0, maxMatches).join('\n')
    if (lines.length > maxMatches) {
      return `${formatted}\n... (${lines.length - maxMatches} more matches truncated; refine your pattern)`
    }
    return formatted
  },
})
