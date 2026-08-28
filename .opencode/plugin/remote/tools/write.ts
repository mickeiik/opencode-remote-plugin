/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod'
import { posix } from 'path'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { RemoteSessionManager } from '../core/session-manager'
import { shellQuote } from '../core/ssh'

export const writeTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Writes content to file on the remote machine',
  args: {
    filePath: z.string(),
    content: z.string(),
  },
  async execute(args: { filePath: string; content: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const command = `mkdir -p ${shellQuote(posix.dirname(args.filePath))} && cat > ${shellQuote(args.filePath)}`
    const result = await ssh.exec(command, { cwd: session.workspacePath, input: args.content })
    if (result.code !== 0) {
      throw new Error(`Failed to write ${args.filePath}: ${result.stderr || result.stdout}`)
    }
    return `Written ${Buffer.byteLength(args.content, 'utf8')} bytes to ${args.filePath}`
  },
})
