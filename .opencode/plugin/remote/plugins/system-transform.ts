/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import { resolveRemoteConfig } from '../core/config'
import type { ExperimentalChatSystemTransformInput, ExperimentalChatSystemTransformOutput } from '../core/types'

/**
 * Adds remote-machine instructions to the system prompt.
 */
export async function systemPromptTransform(ctx: PluginInput) {
  return async (input: ExperimentalChatSystemTransformInput, output: ExperimentalChatSystemTransformOutput) => {
    // Name the host when the config resolves; a missing config must never break the transform.
    let host: string
    try {
      host = resolveRemoteConfig(ctx.worktree).host
    } catch {
      host = 'your remote machine'
    }
    output.system.push(
      [
        '## Remote Machine Integration',
        `This session runs on your remote machine (${host}) over SSH.`,
        'Your project workspace is a numbered directory under REMOTE_PROJECT_PATH on that machine.',
        'Bash commands run in that workspace.',
        'File and search tools (bash, read, write, edit, multiedit, apply_patch, ls, glob, grep) operate on the remote machine; never edit files in the local checkout directly.',
        "When executing long-running commands, use the 'background' option to run them asynchronously.",
        "To reach a dev server running on the remote machine, use 'ssh -L' from your machine to forward the port.",
        "When the user asks to sync, hand off, or finalize changes, run the 'gitSync' tool and report its result.",
      ].join('\n'),
    )
  }
}
