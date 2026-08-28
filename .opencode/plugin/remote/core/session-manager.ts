/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manages remote session workspaces over SSH and persists session→workspace mappings.
 * The machine is persistent and unprovisioned: a session maps to a numbered workspace
 * under REMOTE_PROJECT_PATH plus a bare repo for git sync; delete = final sync + local
 * cleanup only — nothing on the remote is ever deleted.
 * Stores data per-project in ~/.local/share/opencode/storage/remote/{projectId}.json
 */

import { basename, dirname } from 'path'
import { logger } from './logger'
import type { RemoteSession, SessionInfo } from './types'
import { SessionGitManager } from '../git/session-git-manager'
import { RemoteGitManager } from '../git/remote-git-manager'
import { HostGitManager } from '../git/host-git-manager'
import { ProjectDataStorage } from './project-data-storage'
import { resolveRemoteConfig, type RemoteConfig } from './config'
import { shellQuote, SshExecutor } from './ssh'
import type { PluginInput } from '@opencode-ai/plugin'
import { toast } from './toast'

export class RemoteSessionManager {
  private readonly dataStorage: ProjectDataStorage
  /** Resolved remote config + SSH executor for this OpenCode instance, created lazily. */
  private executorPair?: { config: RemoteConfig; ssh: SshExecutor }
  private readonly sessionWorkspaces = new Map<string, RemoteSession>()
  // Sessions whose teardown has begun; without this tombstone a sync queued behind a
  // deletion would re-resolve a workspace for a session that no longer exists.
  private readonly deletingSessions = new Set<string>()
  private readonly deletionPromises = new Map<string, Promise<boolean>>()
  private currentProjectId?: string

  constructor(storageDir: string) {
    this.dataStorage = new ProjectDataStorage(storageDir)
  }

  /**
   * Resolve the remote config for `worktree` and build the SSH executor, caching the
   * pair. A missing configuration fails hard, mirroring the old DAYTONA_API_KEY check.
   */
  private getExecutorPair(worktree: string): { config: RemoteConfig; ssh: SshExecutor } {
    if (!this.executorPair) {
      try {
        const config = resolveRemoteConfig(worktree)
        this.executorPair = { config, ssh: new SshExecutor(config) }
      } catch (err) {
        logger.error(`Remote configuration missing; cannot use a remote machine: ${err}`)
        toast.show({
          title: 'Remote error',
          message:
            'REMOTE_HOST and REMOTE_PROJECT_PATH must be set (in the environment or in a .env file in the project root) to use a remote machine.',
          variant: 'error',
        })
        throw err
      }
    }
    return this.executorPair
  }

  /**
   * The SSH executor for `worktree`, shared with tools and git managers so every caller
   * reuses the single lazily-resolved config/executor pair (and its fail-fast toast).
   */
  getSshExecutor(worktree: string): SshExecutor {
    return this.getExecutorPair(worktree).ssh
  }

  /** In-memory handle for a stored session, rebuilt from its stored workspacePath. */
  private buildHandle(sessionInfo: SessionInfo): RemoteSession {
    const workspacePath = sessionInfo.workspacePath
    return {
      id: basename(workspacePath),
      workspacePath,
      // The bare repo always sits next to the workspace it serves: <root>/.bare/<N>.git.
      bareRepoPath: `${dirname(workspacePath)}/.bare/${basename(workspacePath)}.git`,
      ...(sessionInfo.branchNumber !== undefined ? { branchNumber: sessionInfo.branchNumber } : {}),
    }
  }

  /** Load sessions for a specific project into memory */
  private loadProjectSessions(projectId: string): void {
    const projectData = this.dataStorage.load(projectId)
    if (projectData) {
      for (const [sessionId, sessionInfo] of Object.entries(projectData.sessions)) {
        this.sessionWorkspaces.set(sessionId, this.buildHandle(sessionInfo))
      }
      logger.info(`Loaded ${Object.keys(projectData.sessions).length} sessions for project ${projectId}`)
    }
  }

  /** Set the current project context */
  setProjectContext(projectId: string): void {
    if (this.currentProjectId !== projectId) {
      this.currentProjectId = projectId
      this.sessionWorkspaces.clear()
      this.loadProjectSessions(projectId)
    }
  }

  /** Create the workspace directory on the remote machine */
  private async ensureWorkspaceDirectory(ssh: SshExecutor, workspacePath: string): Promise<void> {
    const result = await ssh.exec(`mkdir -p ${shellQuote(workspacePath)}`)
    if (result.code !== 0) {
      throw new Error(`Failed to create remote workspace directory ${workspacePath}: ${result.stderr || result.stdout}`)
    }
  }

  /**
   * Next workspace number when git is disabled: highest numeric entry in the project
   * root plus one (1 when there are none). The root is created first so a missing
   * directory (first session ever) can't be mistaken for an ls failure; a real ls
   * failure throws instead of silently reusing workspace 1.
   */
  private async allocateWorkspaceNumber(ssh: SshExecutor, projectPath: string): Promise<number> {
    const mkdir = await ssh.exec(`mkdir -p ${shellQuote(projectPath)}`)
    if (mkdir.code !== 0) {
      throw new Error(`Failed to create remote project root ${projectPath}: ${mkdir.stderr || mkdir.stdout}`)
    }
    const result = await ssh.exec(`ls -1 ${shellQuote(projectPath)}`)
    if (result.code !== 0) {
      throw new Error(`Failed to list remote project root ${projectPath}: ${result.stderr || result.stdout}`)
    }
    let max = 0
    for (const line of result.stdout.split('\n')) {
      const entry = line.trim()
      if (!/^\d+$/.test(entry)) continue
      max = Math.max(max, Number.parseInt(entry, 10))
    }
    return max + 1
  }

  /**
   * Get or create the remote workspace for the given session ID
   */
  async getRemoteSession(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<RemoteSession> {
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is deleted; not creating a new remote workspace for it.`)
    }
    if (pluginCtx?.client?.tui) {
      toast.initialize(pluginCtx.client.tui)
    }

    // Load project sessions if needed
    this.setProjectContext(projectId)

    // Fail fast on a missing configuration, like the old DAYTONA_API_KEY check, so a
    // broken setup surfaces as a config error toast instead of cryptic SSH failures.
    const { config, ssh } = this.getExecutorPair(worktree)

    const existing = this.sessionWorkspaces.get(sessionId)

    // Known session: refresh its storage entry (lastAccessed) and reuse the handle
    if (existing) {
      this.dataStorage.updateSession(projectId, worktree, sessionId, existing.workspacePath, existing.branchNumber)
      return existing
    }

    // Known from storage (possibly migrated from another project): reconnect to the
    // workspace recorded there.
    const stored = this.dataStorage.getSession(projectId, worktree, sessionId)
    if (stored?.workspacePath) {
      logger.info(`Reconnecting to existing remote workspace: ${stored.workspacePath}`)
      const handle = this.buildHandle(stored)
      const remoteGit = new RemoteGitManager(ssh, handle.workspacePath, handle.bareRepoPath)
      await this.ensureWorkspaceDirectory(ssh, handle.workspacePath)
      await remoteGit.ensureRepo()

      // A workspace whose .git was lost remotely has no commits to resume from; recover
      // it by re-running the init flow, restoring the session's last synced state from
      // the local opencode/N branch when that ref still exists. Best-effort: the
      // directory itself is already usable (e.g. a local repo with no commits cannot
      // seed it), so a failed recovery must not take the session down.
      if (handle.branchNumber !== undefined && (await remoteGit.getHeadOid()) === '') {
        try {
          logger.warn(`Remote workspace ${handle.workspacePath} lost its git repo; re-initializing from local branch.`)
          await remoteGit.ensureBareRepo()
          const hostGit = new HostGitManager(ssh.knownHosts)
          if (hostGit.getRefOid(worktree, `refs/heads/opencode/${handle.branchNumber}`) !== '') {
            await hostGit.pushLocalToSandboxRemote(
              `sandbox-${handle.branchNumber}`,
              ssh.sshUrl(handle.bareRepoPath),
              'opencode',
              worktree,
            )
          }
          await remoteGit.initFromBare('opencode')
        } catch (err: any) {
          logger.error(`Failed to recover git repo in remote workspace ${handle.workspacePath}: ${err}`)
          toast.show({
            title: 'Git error',
            message: err?.message || 'Failed to recover the remote workspace git repository.',
            variant: 'error',
          })
        }
      }

      // Deletion may have raced the reconnect awaits above.
      this.ensureNotDeleted(sessionId)
      this.sessionWorkspaces.set(sessionId, handle)
      this.dataStorage.updateSession(projectId, worktree, sessionId, handle.workspacePath, handle.branchNumber)
      toast.show({ title: 'Connected', message: 'Connected to remote workspace.', variant: 'info' })
      return handle
    }

    // Otherwise, create a new workspace
    logger.info(`Creating new remote workspace for session: ${sessionId} in project: ${projectId}`)
    let branchNumber: number | undefined
    try {
      branchNumber = SessionGitManager.allocateAndReserveBranchNumber(worktree)
    } catch (err) {
      logger.warn(`allocateAndReserveBranchNumber failed sessionId=${sessionId}: ${err}`)
      // No local git repo (or git unavailable) shouldn't block workspace usage.
      branchNumber = undefined
    }
    const workspaceNumber = branchNumber ?? (await this.allocateWorkspaceNumber(ssh, config.projectPath))
    const workspacePath = `${config.projectPath}/${workspaceNumber}`
    const bareRepoPath = `${config.projectPath}/.bare/${workspaceNumber}.git`

    await this.ensureWorkspaceDirectory(ssh, workspacePath)
    if (branchNumber !== undefined) {
      try {
        await new SessionGitManager(ssh, workspacePath, bareRepoPath, worktree, branchNumber).initializeAndSync(
          pluginCtx,
        )
      } catch (err: any) {
        logger.error(`Failed to initialize git repo or push local changes to the remote machine: ${err}`)
        toast.show({
          title: 'Git error',
          message: err?.message || 'Failed to initialize git repo on the remote machine.',
          variant: 'error',
        })
      }
    }

    // Deletion may have raced the initialization awaits above.
    this.ensureNotDeleted(sessionId)
    this.dataStorage.updateSession(projectId, worktree, sessionId, workspacePath, branchNumber)
    const handle: RemoteSession = {
      id: String(workspaceNumber),
      workspacePath,
      bareRepoPath,
      ...(branchNumber !== undefined ? { branchNumber } : {}),
    }
    this.sessionWorkspaces.set(sessionId, handle)
    toast.show({
      title: 'Session started',
      message: `Session started on ${config.host} (workspace ${workspacePath})`,
      variant: 'success',
    })
    return handle
  }

  /**
   * Delete the local mapping for the given session ID. Nothing on the remote machine is
   * removed: after one final best-effort sync, only the in-memory handle, the stored
   * mapping, and the session's local git remote are cleaned up.
   */
  async deleteSession(sessionId: string, projectId: string): Promise<boolean> {
    // Concurrent deletes share one promise: a second teardown racing the first would
    // observe the already-deleted session and wrongly clear the tombstone.
    const inFlight = this.deletionPromises.get(sessionId)
    if (inFlight) return inFlight

    // Tombstone first, removed again on failure; kept after success on purpose - any
    // late event for a gone session must no-op instead of resurrecting a workspace.
    this.deletingSessions.add(sessionId)
    const run = (async () => {
      try {
        return await this.deleteSessionInner(sessionId, projectId)
      } catch (err) {
        this.deletingSessions.delete(sessionId)
        throw err
      } finally {
        this.deletionPromises.delete(sessionId)
      }
    })()
    this.deletionPromises.set(sessionId, run)
    return run
  }

  private async deleteSessionInner(sessionId: string, projectId: string): Promise<boolean> {
    await SessionGitManager.waitForPendingSync(sessionId)

    const handle = this.sessionWorkspaces.get(sessionId)
    // Read-only lookup so deleting never migrates sessions or rewrites project metadata.
    const stored = this.dataStorage.findSession(sessionId)
    const existed = handle !== undefined || stored !== undefined

    // Final sync into the local opencode/N branch, as ONE queue entry so nothing can slot
    // in between draining pending syncs and pulling the last changes. Best-effort: unlike
    // upstream, a failed final sync must not block deletion — remote files are never at risk.
    const branchNumber = handle?.branchNumber ?? stored?.session.branchNumber
    const workspacePath = handle?.workspacePath ?? stored?.session.workspacePath
    if (branchNumber !== undefined && workspacePath && stored?.worktree) {
      try {
        const ssh = this.getSshExecutor(stored.worktree)
        const bareRepoPath = handle?.bareRepoPath ?? `${dirname(workspacePath)}/.bare/${basename(workspacePath)}.git`
        const sessionGit = new SessionGitManager(ssh, workspacePath, bareRepoPath, stored.worktree, branchNumber)
        await SessionGitManager.enqueueSessionSync(sessionId, () => sessionGit.autoCommitAndPull())
      } catch (err) {
        logger.warn(`Final sync before deletion failed for session ${sessionId}; continuing with cleanup: ${err}`)
      }
    }

    // Local-only cleanup; remote files are left untouched on purpose.
    this.sessionWorkspaces.delete(sessionId)
    const cleanupProjectId = stored?.projectId ?? projectId
    const cleanupWorktree = stored?.worktree ?? this.dataStorage.load(projectId)?.worktree ?? ''
    this.dataStorage.removeSession(cleanupProjectId, cleanupWorktree, sessionId)
    if (branchNumber !== undefined && stored?.worktree) {
      new HostGitManager().removeRemote(`sandbox-${branchNumber}`, stored.worktree)
    }

    return existed
  }

  /** Read-only check for a session→workspace mapping; never creates, migrates, or connects. */
  hasSession(sessionId: string, projectId: string): boolean {
    if (this.deletingSessions.has(sessionId)) return false
    this.setProjectContext(projectId)
    if (this.sessionWorkspaces.has(sessionId)) return true
    return this.dataStorage.findSession(sessionId) !== undefined
  }

  isSessionDeleting(sessionId: string): boolean {
    return this.deletingSessions.has(sessionId)
  }

  /**
   * Guard for registration points that follow an await: deletion may have started (and
   * finished) while a workspace was being prepared, and persisting the mapping afterwards
   * would resurrect state for a session that no longer exists.
   */
  private ensureNotDeleted(sessionId: string): void {
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} was deleted while its remote workspace was being prepared.`)
    }
  }
}
