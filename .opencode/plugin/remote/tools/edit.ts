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

export const editTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Replaces text in a file on the remote machine',
  args: {
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
  },
  async execute(args: { filePath: string; oldString: string; newString: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const read = await ssh.exec(`cat -- ${shellQuote(args.filePath)}`, { cwd: session.workspacePath })
    if (read.code !== 0) {
      throw new Error(`Failed to read ${args.filePath}: ${read.stderr || read.stdout}`)
    }
    const content = read.stdout
    if (args.oldString === '') {
      throw new Error(`oldString must be non-empty; refusing to prepend to ${args.filePath}.`)
    }
    const occurrences = content.split(args.oldString).length - 1
    if (occurrences === 0) {
      throw new Error(`oldString not found in ${args.filePath}; no changes were made.`)
    }
    if (occurrences > 1) {
      throw new Error(
        `oldString is ambiguous (${occurrences} matches) in ${args.filePath}; no changes were made.`,
      )
    }
    const newContent = content.replace(args.oldString, args.newString)
    const write = await ssh.exec(`cat > ${shellQuote(args.filePath)}`, {
      cwd: session.workspacePath,
      input: newContent,
    })
    if (write.code !== 0) {
      throw new Error(`Failed to write ${args.filePath}: ${write.stderr || write.stdout}`)
    }
    return `Edited ${args.filePath}`
  },
})
