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

export const multieditTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Applies multiple edits to a file on the remote machine atomically',
  args: {
    filePath: z.string(),
    edits: z.array(
      z.object({
        oldString: z.string(),
        newString: z.string(),
      }),
    ),
  },
  async execute(args: { filePath: string; edits: Array<{ oldString: string; newString: string }> }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const read = await ssh.exec(`cat -- ${shellQuote(args.filePath)}`, { cwd: session.workspacePath })
    if (read.code !== 0) {
      throw new Error(`Failed to read ${args.filePath}: ${read.stderr || read.stdout}`)
    }
    let content = read.stdout

    for (const [i, edit] of args.edits.entries()) {
      if (edit.oldString === '') {
        throw new Error(`edits[${i}].oldString is empty; refusing to prepend to ${args.filePath}.`)
      }
      const occurrences = content.split(edit.oldString).length - 1
      if (occurrences === 0) {
        throw new Error(
          `edits[${i}].oldString not found in ${args.filePath}: ${JSON.stringify(edit.oldString)}`,
        )
      }
      if (occurrences > 1) {
        throw new Error(
          `edits[${i}].oldString is ambiguous (${occurrences} matches) in ${args.filePath}: ${JSON.stringify(edit.oldString)}`,
        )
      }
      content = content.replace(edit.oldString, edit.newString)
    }

    const write = await ssh.exec(`cat > ${shellQuote(args.filePath)}`, {
      cwd: session.workspacePath,
      input: content,
    })
    if (write.code !== 0) {
      throw new Error(`Failed to write ${args.filePath}: ${write.stderr || write.stdout}`)
    }
    return `Applied ${args.edits.length} edits to ${args.filePath}`
  },
})
