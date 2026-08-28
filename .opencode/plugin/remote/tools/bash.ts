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

export const bashTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Executes shell commands on the remote machine',
  args: {
    command: z.string(),
    background: z.boolean().optional(),
  },
  async execute(args: { command: string; background?: boolean }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)

    if (args.background) {
      const logPath = `/tmp/opencode-remote-${ctx.sessionID}-${Date.now()}.log`
      const result = await ssh.exec(`nohup sh -c ${shellQuote(args.command)} > ${shellQuote(logPath)} 2>&1 & echo $!`, {
        cwd: session.workspacePath,
      })
      if (result.code !== 0) {
        throw new Error(`Failed to start background command: ${result.stderr || result.stdout}`)
      }
      const pid = result.stdout.trim()
      return `Command started in background (pid: ${pid}). Output: ${logPath}`
    }

    const result = await ssh.exec(args.command, { cwd: session.workspacePath })
    let output = `Exit code: ${result.code}\n${result.stdout}`
    if (result.stderr) {
      output += `\n${result.stderr}`
    }
    return output
  },
})
