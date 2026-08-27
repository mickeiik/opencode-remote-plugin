/**
 * Copyright 2026 mickeiik
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'

export interface RemoteConfig {
  host: string
  user?: string
  port?: number
  projectPath: string
  knownHosts?: string
}

const ENV_FILE_NAME = '.env'

const configCache = new Map<string, RemoteConfig>()

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice('export '.length).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const quote = value[0]
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1)
      }
    }
    values[key] = value
  }
  return values
}

function loadDotEnv(worktree: string): Record<string, string> {
  const envPath = join(worktree, ENV_FILE_NAME)
  if (!existsSync(envPath)) return {}
  let contents: string
  try {
    contents = readFileSync(envPath, 'utf8')
  } catch (err) {
    logger.warn(`Failed to read ${envPath}: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
  return parseEnvFile(contents)
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`REMOTE_PORT must be an integer between 1 and 65535, got "${value}"`)
  }
  return port
}

export function resolveRemoteConfig(worktree: string): RemoteConfig {
  const cached = configCache.get(worktree)
  if (cached) return cached

  const env: NodeJS.ProcessEnv = { ...loadDotEnv(worktree), ...process.env }

  const hostRaw = env.REMOTE_HOST?.trim() ?? ''
  let host = hostRaw
  let embeddedUser: string | undefined
  const at = hostRaw.lastIndexOf('@')
  if (at >= 0) {
    embeddedUser = hostRaw.slice(0, at).trim() || undefined
    host = hostRaw.slice(at + 1).trim()
  }

  const user = env.REMOTE_USER?.trim() || embeddedUser

  const missing: string[] = []
  if (!host) missing.push('REMOTE_HOST')
  const projectPath = env.REMOTE_PROJECT_PATH?.trim() ?? ''
  if (!projectPath) missing.push('REMOTE_PROJECT_PATH')
  if (missing.length > 0) {
    throw new Error(
      `Missing required remote configuration: ${missing.join(', ')}. ` +
        `Set them in the environment or in a ${ENV_FILE_NAME} file in the project root (${worktree}).`
    )
  }

  const portRaw = env.REMOTE_PORT?.trim()
  const port = portRaw ? parsePort(portRaw) : undefined

  const knownHosts = env.REMOTE_SSH_KNOWN_HOSTS?.trim() || undefined
  if (knownHosts?.includes('"')) {
    throw new Error('REMOTE_SSH_KNOWN_HOSTS must not contain a double quote (") character')
  }

  const config: RemoteConfig = { host, user, port, projectPath, knownHosts }
  configCache.set(worktree, config)
  logger.info(
    `Remote config resolved: host=${host}` +
      (user ? ` user=${user}` : '') +
      (port !== undefined ? ` port=${port}` : '') +
      `, projectPath=${projectPath}` +
      (knownHosts ? `, knownHosts=${knownHosts}` : '')
  )
  return config
}
