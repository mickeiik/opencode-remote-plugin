/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenCode Plugin: Remote Machine Integration
 *
 * OpenCode plugins extend the AI coding assistant by adding custom tools, handling events,
 * and modifying behavior. Plugins are TypeScript/JavaScript modules that export functions
 * which return hooks for various lifecycle events.
 *
 * This plugin runs every OpenCode session on a remote machine reached over SSH. It adds
 * custom tools for file operations, command execution, and search on that machine, keeps
 * each session's changes synchronized to a local `opencode/N` git branch, and cleans up
 * local state when sessions end. Nothing on the remote machine is ever deleted.
 *
 * Learn more: https://opencode.ai/docs/plugins/
 *
 * Requires:
 * - Environment: REMOTE_HOST, REMOTE_PROJECT_PATH
 * - Environment (optional): REMOTE_PORT, REMOTE_USER, REMOTE_SSH_KNOWN_HOSTS
 *   (set them in the environment or in a .env file in the project root)
 */

import { join } from 'path'
import { homedir } from 'os'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { logger, setLogFilePath } from './core/logger'
import { RemoteSessionManager } from './core/session-manager'
import { SessionGitManager } from './git/session-git-manager'
import { toast } from './core/toast'
import { customTools } from './plugins/custom-tools'
import { eventHandlers } from './plugins/session-events'
import { systemPromptTransform } from './plugins/system-transform'

export type {
  EventSessionDeleted,
  EventSessionIdle,
  ExperimentalChatSystemTransformInput,
  ExperimentalChatSystemTransformOutput,
  LogLevel,
  ProjectSessionData,
  RemoteSession,
  SessionInfo,
} from './core/types'

const xdgDataDir = xdgData ?? join(homedir(), '.local', 'share')
const LOG_FILE = join(xdgDataDir, 'opencode', 'log', 'remote.log')
const STORAGE_DIR = join(xdgDataDir, 'opencode', 'storage', 'remote')

setLogFilePath(LOG_FILE)
const sessionManager = new RemoteSessionManager(STORAGE_DIR)

async function remotePlugin(ctx: PluginInput) {
  toast.initialize(ctx.client?.tui)
  return {
    tool: await customTools(ctx, sessionManager),
    event: await eventHandlers(ctx, sessionManager),
    'experimental.chat.system.transform': await systemPromptTransform(ctx),
    // Awaited by OpenCode when the plugin scope closes (newer than the published Hooks
    // type, ignored by older versions). Draining here keeps a graceful shutdown from
    // abandoning a git sync that the unawaited `event` hook started on session.idle.
    // Bounded so a sync stalled on an unreachable sandbox cannot wedge process exit.
    dispose: async () => {
      const drained = await SessionGitManager.waitForAllPendingSyncs(60_000)
      if (!drained) {
        logger.warn('[dispose] exiting with git syncs still pending after 60s; a sync may be stalled')
      }
    },
  }
}

export default remotePlugin
