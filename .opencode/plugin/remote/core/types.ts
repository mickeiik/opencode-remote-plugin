/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions and constants for the remote OpenCode plugin
 */

// OpenCode Types

export type EventSessionDeleted = {
  type: 'session.deleted'
  properties: {
    info: { id: string }
  }
}

export type EventSessionIdle = {
  type: 'session.idle'
  properties: {
    sessionID: string
  }
}

export type ExperimentalChatSystemTransformInput = {
  sessionID?: string
  model: any
}

export type ExperimentalChatSystemTransformOutput = {
  system: string[]
}

// OpenCode constants

export const EVENT_TYPE_SESSION_DELETED = 'session.deleted'
export const EVENT_TYPE_SESSION_IDLE = 'session.idle'

// Remote plugin types

export type LogLevel = 'INFO' | 'ERROR' | 'WARN'

export type SessionInfo = {
  workspacePath: string
  /**
   * Only set when the local worktree is a git repo (used to create opencode/N branches/remotes).
   */
  branchNumber?: number
  created: number
  lastAccessed: number
}

export type ProjectSessionData = {
  projectId: string
  worktree: string
  sessions: Record<string, SessionInfo>
}

/**
 * In-memory per-session handle tools receive (replaces the remote workspace object).
 * `id` is the workspace key (e.g. the session number as a string).
 */
export type RemoteSession = {
  id: string
  workspacePath: string
  bareRepoPath: string
  branchNumber?: number
}

// Remote plugin constants

export const LOG_LEVEL_INFO: LogLevel = 'INFO'
export const LOG_LEVEL_ERROR: LogLevel = 'ERROR'
export const LOG_LEVEL_WARN: LogLevel = 'WARN'
