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
 * - Environment (optional): REMOTE_PORT, REMOTE_USER, REMOTE_SSH_KNOWN_HOSTS, REMOTE_FALLBACK
 *   (set them in the environment or in a .env file in the project root)
 *
 * Unless REMOTE_FALLBACK disables it, a missing configuration or an unreachable
 * machine makes the plugin disable itself for this launch (toast + remote.log) and
 * opencode runs locally; the decision is made once at plugin init.
 */

import { join } from 'path'
import { homedir } from 'os'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { logger, setLogFilePath } from './core/logger'
import { isFallbackDisabled, resolveRemoteConfig, type RemoteConfig } from './core/config'
import { probeRemote } from './core/ssh'
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

/**
 * The hooks of an active (remote) launch: tools, events, system-prompt transform, and
 * the dispose drain. Shared by the REMOTE_FALLBACK=off path and the fallback path's
 * success case so neither can drift from the other.
 */
async function activeHooks(ctx: PluginInput) {
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

async function remotePlugin(ctx: PluginInput) {
  toast.initialize(ctx.client?.tui)

  // An invalid REMOTE_FALLBACK value is a visible config error, never a silent guess:
  // error toast + log, then local behavior.
  let fallbackDisabled: boolean
  try {
    fallbackDisabled = isFallbackDisabled(ctx.worktree)
  } catch (err: any) {
    logger.error(`Remote fallback configuration error; using local behavior: ${err?.message ?? err}`)
    toast.show({
      title: 'Remote config error',
      message: err?.message || 'REMOTE_FALLBACK is set to an unrecognized value.',
      variant: 'error',
    })
    return {}
  }

  // REMOTE_FALLBACK off: register exactly as before fallback existed. Configuration
  // and connectivity surface lazily per tool/event call with error toasts — never a
  // silent switch to local behavior, and no startup probe delay.
  if (fallbackDisabled) return activeHooks(ctx)

  // Fallback enabled: decide once per launch. Missing configuration → local with an
  // info toast; configuration that resolves but cannot be reached over SSH → local
  // with a warning toast naming the host. Both log the reason to remote.log; an empty
  // hooks object reverts opencode to its default local behavior (all Hooks fields are
  // optional). Mid-session SSH failures remain errors — restart opencode to re-probe.
  let config: RemoteConfig
  try {
    config = resolveRemoteConfig(ctx.worktree)
  } catch (err: any) {
    logger.warn(`Remote configuration missing; falling back to local behavior: ${err?.message ?? err}`)
    toast.show({
      title: 'Remote not configured',
      message:
        'REMOTE_HOST and REMOTE_PROJECT_PATH are not set; running locally. Set them (environment or .env in the project root) and restart opencode to use a remote machine.',
      variant: 'info',
    })
    return {}
  }

  try {
    await probeRemote(config)
  } catch (err: any) {
    logger.warn(`Cannot reach ${config.host} over SSH; falling back to local behavior: ${err?.message ?? err}`)
    toast.show({
      title: 'Remote unreachable',
      message: `Could not connect to ${config.host} over SSH; running locally. See remote.log for details. Restart opencode to retry.`,
      variant: 'warning',
    })
    return {}
  }

  return activeHooks(ctx)
}

export default remotePlugin
