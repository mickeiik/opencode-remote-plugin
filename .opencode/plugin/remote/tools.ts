/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool implementations for the remote machine integration
 */

import { bashTool } from './tools/bash'
import { readTool } from './tools/read'
import { writeTool } from './tools/write'
import { editTool } from './tools/edit'
import { multieditTool } from './tools/multiedit'
import { applyPatchTool } from './tools/apply-patch'
import { lsTool } from './tools/ls'
import { globTool } from './tools/glob'
import { grepTool } from './tools/grep'
import { gitSyncTool } from './tools/git-sync'

import type { RemoteSessionManager } from './core/session-manager'
import type { PluginInput } from '@opencode-ai/plugin'

export function createRemoteTools(
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) {
  return {
    bash: bashTool(sessionManager, projectId, worktree, pluginCtx),
    read: readTool(sessionManager, projectId, worktree, pluginCtx),
    write: writeTool(sessionManager, projectId, worktree, pluginCtx),
    edit: editTool(sessionManager, projectId, worktree, pluginCtx),
    multiedit: multieditTool(sessionManager, projectId, worktree, pluginCtx),
    apply_patch: applyPatchTool(sessionManager, projectId, worktree, pluginCtx),
    ls: lsTool(sessionManager, projectId, worktree, pluginCtx),
    glob: globTool(sessionManager, projectId, worktree, pluginCtx),
    grep: grepTool(sessionManager, projectId, worktree, pluginCtx),
    gitSync: gitSyncTool(sessionManager, projectId, worktree, pluginCtx),
  }
}
