/**
 * Copyright Daytona Platforms Inc.
 * Copyright 2026 mickeiik (modifications)
 * SPDX-License-Identifier: Apache-2.0
 */

import { dirname } from 'path'
import { logger } from '../core/logger'
import { shellQuote, SshExecutor } from '../core/ssh'

/**
 * Git operations inside the remote workspace, executed over SSH. Transports commits
 * through a per-session bare repository on the remote machine: the host pushes to and
 * fetches from the bare repo (one stable URL), while this class checks out from and
 * pushes to it locally on the remote — avoiding "refusing to update checked-out
 * branch" errors entirely.
 */
export class RemoteGitManager {
  constructor(
    private readonly ssh: SshExecutor,
    private readonly workspacePath: string,
    private readonly bareRepoPath: string,
  ) {}

  /**
   * Runs a command on the remote machine and throws on non-zero exit with the combined
   * output. cwd defaults to the workspace; pass no cwd for commands that must work
   * before the workspace exists (mkdir/init of directories outside it).
   */
  private async runCommand(command: string, cwd?: string): Promise<string> {
    const result = await this.ssh.exec(command, cwd ? { cwd } : undefined)
    const output = `${result.stdout}\n${result.stderr}`.trim()

    if (result.code !== 0) {
      const installHint = output.includes('git: command not found')
        ? '\nHint: git is not installed on the remote machine. Install git and try again.'
        : ''
      throw new Error(`Git command failed: ${command}\nOutput: ${output || '(no output)'}${installHint}`)
    }

    return result.stdout
  }

  /** Runs a git command inside the remote workspace. */
  private async runGitCommand(command: string): Promise<string> {
    return this.runCommand(command, this.workspacePath)
  }

  async ensureDirectory(): Promise<void> {
    // Not a git command and must not cd into workspacePath (which may not exist yet),
    // so it goes through runCommand without a cwd.
    await this.runCommand(`mkdir -p ${shellQuote(this.workspacePath)}`)
  }

  async ensureRepo(): Promise<void> {
    await this.ensureDirectory()
    const isGit = await this.runGitCommand(
      'if [ -e .git ]; then git rev-parse --is-inside-work-tree; else echo false; fi',
    )
    if (isGit.trim() !== 'true') {
      await this.runGitCommand('git init')
      await this.runGitCommand('git config user.email "opencode@remote.local"')
      await this.runGitCommand('git config user.name "OpenCode Remote"')
      logger.info(`Initialized git repo on remote machine at ${this.workspacePath}`)
    }
  }

  async autoCommit(): Promise<boolean> {
    // Check if there are any changes to commit
    const status = await this.runGitCommand('git status --porcelain')
    if (!status.trim()) {
      logger.info(`No changes to commit in remote workspace at ${this.workspacePath}`)
      return false
    }
    await this.runGitCommand('git add .')
    await this.runGitCommand('git commit -am "Auto-commit from OpenCode remote plugin"')
    logger.info(`Auto-committed changes in remote workspace at ${this.workspacePath}`)
    return true
  }

  async getCurrentBranch(): Promise<string> {
    const branch = await this.runGitCommand('git rev-parse --abbrev-ref HEAD')
    return branch.trim()
  }

  /**
   * Commit OID of the workspace HEAD, or '' on an unborn branch (no commits yet).
   * Any other git failure throws: callers use '' as "nothing to pull", and the delete
   * path acts on it, so a masked error here could destroy unsynced commits.
   */
  async getHeadOid(): Promise<string> {
    const out = await this.runGitCommand(
      'if oid=$(git rev-parse --verify --quiet HEAD); then echo "$oid"; else git rev-parse --is-inside-work-tree > /dev/null && echo UNBORN; fi',
    )
    const trimmed = out.trim()
    return trimmed === 'UNBORN' ? '' : trimmed
  }

  /**
   * Initializes (or re-initializes) the workspace from the bare repository: creates the
   * repo if needed, then force-checks out `branch` at what the host last pushed. -B
   * (not -b) resets an already-existing branch to FETCH_HEAD, so a re-init over an
   * existing workspace recovers instead of failing with "branch already exists".
   * Local state that was never pushed to the bare repo is discarded by the checkout.
   */
  async initFromBare(branch = 'opencode'): Promise<void> {
    await this.runGitCommand('git init')
    await this.runGitCommand('git config user.name "OpenCode Remote"')
    await this.runGitCommand('git config user.email "opencode@remote.local"')
    await this.runGitCommand(`git fetch ${shellQuote(this.bareRepoPath)} ${branch}`)
    await this.runGitCommand(`git checkout -f -B ${branch} FETCH_HEAD`)
    logger.info(`Initialized workspace from bare repo at branch '${branch}'.`)
    const status = await this.runGitCommand('git status --porcelain')
    if (status.trim()) {
      logger.warn(`Remote workspace has uncommitted changes after init from bare repo:\n${status}`)
    }
  }

  /**
   * Creates the bare repository if it does not exist. Its parent directory is created
   * first; both steps run without a workspace cwd because the workspace may not exist
   * yet when this is called.
   */
  async ensureBareRepo(): Promise<void> {
    await this.runCommand(`mkdir -p ${shellQuote(dirname(this.bareRepoPath))}`)
    await this.runCommand(`git init --bare ${shellQuote(this.bareRepoPath)}`)
    logger.info(`Ensured bare repository on remote machine at ${this.bareRepoPath}`)
  }

  /**
   * Force-pushes the workspace HEAD to `branch` in the bare repository. --force covers
   * agent history rewrites; only this workspace ever pushes there.
   */
  async pushToBare(branch: string): Promise<void> {
    await this.runGitCommand(`git push --force ${shellQuote(this.bareRepoPath)} HEAD:${branch}`)
  }
}
