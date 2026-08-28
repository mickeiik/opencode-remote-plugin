/**
 * Copyright 2026 mickeiik
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RemoteConfig } from './config'

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function sshCommonArgs(): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${join(tmpdir(), 'opencode-remote-%r@%h-%p.sock')}`,
    '-o',
    'ControlPersist=600',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ]
}

export class SshExecutor {
  constructor(private readonly config: RemoteConfig) {}

  target(): string {
    return this.config.user ? `${this.config.user}@${this.config.host}` : this.config.host
  }

  baseArgs(): string[] {
    const args = sshCommonArgs()
    if (this.config.knownHosts) {
      args.push(
        '-o',
        `UserKnownHostsFile="${this.config.knownHosts}"`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'StrictHostKeyChecking=yes',
      )
    }
    if (this.config.port !== undefined) {
      args.push('-p', String(this.config.port))
    }
    return args
  }

  sshUrl(remoteAbsPath: string): string {
    const user = this.config.user ? `${this.config.user}@` : ''
    const port = this.config.port !== undefined ? `:${this.config.port}` : ''
    return `ssh://${user}${this.config.host}${port}${remoteAbsPath}`
  }

  exec(
    command: string,
    opts?: { cwd?: string; input?: string | Buffer; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const cwd = opts?.cwd
    const remoteCommand = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command
    const args = [...this.baseArgs(), this.target(), remoteCommand]

    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args)
      let stdout = ''
      let stderr = ''
      let settled = false

      const timer =
        opts?.timeoutMs !== undefined
          ? setTimeout(
              () => {
                if (settled) return
                settled = true
                child.kill()
                reject(new Error(`SSH command timed out after ${opts.timeoutMs}ms: ${command}`))
              },
              opts.timeoutMs,
            )
          : undefined

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.stdin.on('error', () => {})
      if (opts?.input !== undefined) {
        child.stdin.write(opts.input)
      }
      child.stdin.end()

      child.on('error', (err) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(err)
      })

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (signal) {
          stderr += `\n[ssh] terminated by signal ${signal}`
        }
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }
}
