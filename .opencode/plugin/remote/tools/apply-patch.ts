/**
 * Copyright 2026 mickeiik
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod'
import { posix } from 'path'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { RemoteSessionManager } from '../core/session-manager'
import { shellQuote } from '../core/ssh'

/**
 * Plugin replacement for OpenCode's built-in apply_patch tool: mirrors the upstream
 * parser, fuzzy matcher, and output format byte-for-byte, while every file operation
 * is executed over SSH in the remote session workspace instead of locally.
 */

export const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file`

interface UpdateChunk {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  isEndOfFile?: boolean
}

type Hunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateChunk[] }

function unwrapHeredoc(patch: string): string {
  const match = patch.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)
  return match ? match[2] : patch
}

function parseHeader(line: string): { filePath: string; movePath?: string } | null {
  if (line.startsWith('*** Add File:')) {
    const filePath = line.slice(13).trim()
    return filePath ? { filePath } : null
  }
  if (line.startsWith('*** Delete File:')) {
    const filePath = line.slice(16).trim()
    return filePath ? { filePath } : null
  }
  if (line.startsWith('*** Update File:')) {
    const filePath = line.slice(16).trim()
    return filePath ? { filePath } : null
  }
  return null
}

function parseAddContents(lines: string[], start: number): { content: string; next: number } {
  let content = ''
  let i = start
  while (i < lines.length && !lines[i].startsWith('***')) {
    if (lines[i].startsWith('+')) content += lines[i].substring(1) + '\n'
    i++
  }
  if (content.endsWith('\n')) content = content.slice(0, -1)
  return { content, next: i }
}

function parseUpdateChunks(lines: string[], start: number): { chunks: UpdateChunk[]; next: number } {
  const chunks: UpdateChunk[] = []
  let i = start
  while (i < lines.length && !lines[i].startsWith('***')) {
    if (lines[i].startsWith('@@')) {
      const changeContext = lines[i].substring(2).trim() || undefined
      i++
      const oldLines: string[] = []
      const newLines: string[] = []
      let isEndOfFile = false
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('***')) {
        const line = lines[i]
        if (line === '*** End of File') {
          isEndOfFile = true
          i++
          break
        }
        if (line.startsWith(' ')) {
          oldLines.push(line.substring(1))
          newLines.push(line.substring(1))
        } else if (line.startsWith('-')) {
          oldLines.push(line.substring(1))
        } else if (line.startsWith('+')) {
          newLines.push(line.substring(1))
        }
        i++
      }
      chunks.push({ oldLines, newLines, changeContext, isEndOfFile: isEndOfFile || undefined })
    } else {
      i++
    }
  }
  return { chunks, next: i }
}

export function parsePatch(patch: string): Hunk[] {
  const lines = unwrapHeredoc(patch.trim()).split('\n')
  const begin = lines.findIndex((line) => line.trim() === '*** Begin Patch')
  const end = lines.findIndex((line) => line.trim() === '*** End Patch')
  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error('Invalid patch format: missing Begin/End markers')
  }
  const hunks: Hunk[] = []
  let i = begin + 1
  while (i < end) {
    const header = parseHeader(lines[i])
    if (!header) {
      i++
      continue
    }
    if (lines[i].startsWith('*** Add File:')) {
      const { content, next } = parseAddContents(lines, i + 1)
      hunks.push({ type: 'add', path: header.filePath, contents: content })
      i = next
    } else if (lines[i].startsWith('*** Delete File:')) {
      hunks.push({ type: 'delete', path: header.filePath })
      i++
    } else if (lines[i].startsWith('*** Update File:')) {
      let movePath: string | undefined
      if (i + 1 <= end && lines[i + 1]?.startsWith('*** Move to:')) {
        movePath = lines[i + 1].slice(12).trim()
        i++
      }
      const { chunks, next } = parseUpdateChunks(lines, i + 1)
      hunks.push({ type: 'update', path: header.filePath, movePath, chunks })
      i = next
    } else {
      i++
    }
  }
  return hunks
}

function normalizePunctuation(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
}

function findSequence(
  lines: string[],
  target: string[],
  from: number,
  matches: (a: string, b: string) => boolean,
  endOfFile: boolean,
): number {
  if (target.length === 0) return -1
  if (endOfFile) {
    const start = lines.length - target.length
    if (start >= from && target.every((line, j) => matches(lines[start + j], line))) return start
  }
  for (let i = from; i <= lines.length - target.length; i++) {
    if (target.every((line, j) => matches(lines[i + j], line))) return i
  }
  return -1
}

function locate(
  lines: string[],
  target: string[],
  from: number,
  endOfFile: boolean,
): number {
  if (target.length === 0) return -1
  let index = findSequence(lines, target, from, (a, b) => a === b, endOfFile)
  if (index !== -1) return index
  index = findSequence(lines, target, from, (a, b) => a.trimEnd() === b.trimEnd(), endOfFile)
  if (index !== -1) return index
  index = findSequence(lines, target, from, (a, b) => a.trim() === b.trim(), endOfFile)
  if (index !== -1) return index
  return findSequence(
    lines,
    target,
    from,
    (a, b) => normalizePunctuation(a.trim()) === normalizePunctuation(b.trim()),
    endOfFile,
  )
}

function applyChunks(path: string, chunks: UpdateChunk[], lines: string[]): string[] {
  const replacements: Array<[number, number, string[]]> = []
  let cursor = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = locate(lines, [chunk.changeContext], cursor, false)
      if (contextIndex === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`)
      }
      cursor = contextIndex + 1
    }
    if (chunk.oldLines.length === 0) {
      const position = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      replacements.push([position, 0, chunk.newLines])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let index = locate(lines, oldLines, cursor, chunk.isEndOfFile === true)
    if (index === -1 && oldLines.length > 0 && oldLines[oldLines.length - 1] === '') {
      oldLines = oldLines.slice(0, -1)
      if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1)
      index = locate(lines, oldLines, cursor, chunk.isEndOfFile === true)
    }
    if (index !== -1) {
      replacements.push([index, oldLines.length, newLines])
      cursor = index + oldLines.length
    } else {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`)
    }
  }
  replacements.sort((a, b) => a[0] - b[0])
  const result = [...lines]
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, count, inserted] = replacements[i]
    result.splice(start, count)
    for (let j = 0; j < inserted.length; j++) result.splice(start + j, 0, inserted[j])
  }
  return result
}

function deriveNewContents(
  path: string,
  chunks: UpdateChunk[],
  fullText: string,
): { content: string; bom: boolean } {
  const sourceBom = fullText.startsWith('\uFEFF')
  const sourceText = sourceBom ? fullText.slice(1) : fullText
  const lines = sourceText.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const patched = applyChunks(path, chunks, lines)
  if (patched.length === 0 || patched[patched.length - 1] !== '') patched.push('')
  const content = patched.join('\n')
  return { content, bom: sourceBom }
}

interface PreparedOp {
  type: 'add' | 'update' | 'move' | 'delete'
  filePath: string
  movePath?: string
  content?: string
  bom?: boolean
}

export const applyPatchTool = (
  sessionManager: RemoteSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: APPLY_PATCH_DESCRIPTION,
  args: {
    patchText: z.string().describe('The full patch text that describes all changes to be made'),
  },
  async execute(args: { patchText: string }, ctx: ToolContext) {
    const session = await sessionManager.getRemoteSession(ctx.sessionID, projectId, worktree, pluginCtx)
    const ssh = sessionManager.getSshExecutor(worktree)
    const resolveRemote = (path: string) => posix.resolve(session.workspacePath, path)

    if (!args.patchText) {
      throw new Error('patchText is required')
    }
    let hunks: Hunk[]
    try {
      hunks = parsePatch(args.patchText)
    } catch (err) {
      throw new Error(`apply_patch verification failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (hunks.length === 0) {
      const normalized = args.patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
      if (normalized === '*** Begin Patch\n*** End Patch') {
        throw new Error('patch rejected: empty patch')
      }
      throw new Error('apply_patch verification failed: no hunks found')
    }

    const ops: PreparedOp[] = []
    for (const hunk of hunks) {
      const filePath = resolveRemote(hunk.path)
      if (hunk.type === 'add') {
        const content = hunk.contents.length === 0 || hunk.contents.endsWith('\n') ? hunk.contents : `${hunk.contents}\n`
        ops.push({ type: 'add', filePath, content })
        continue
      }
      if (hunk.type === 'delete') {
        const read = await ssh.exec(`cat -- ${shellQuote(filePath)}`, { cwd: session.workspacePath })
        if (read.code !== 0) {
          throw new Error(
            `apply_patch verification failed: ${read.stderr.trim() || read.stdout.trim() || `Failed to read file for deletion: ${filePath}`}`,
          )
        }
        ops.push({ type: 'delete', filePath })
        continue
      }
      const read = await ssh.exec(`cat -- ${shellQuote(filePath)}`, { cwd: session.workspacePath })
      if (read.code !== 0) {
        throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`)
      }
      const { content, bom } = deriveNewContents(hunk.path, hunk.chunks, read.stdout)
      if (hunk.movePath) {
        ops.push({ type: 'move', filePath, movePath: resolveRemote(hunk.movePath), content, bom })
      } else {
        ops.push({ type: 'update', filePath, content, bom })
      }
    }

    for (const op of ops) {
      if (op.type === 'delete') {
        const result = await ssh.exec(`rm -f -- ${shellQuote(op.filePath)}`, { cwd: session.workspacePath })
        if (result.code !== 0) {
          throw new Error(`Failed to delete ${op.filePath}: ${result.stderr || result.stdout}`)
        }
        continue
      }
      // Moves write the destination first and only then remove the source, so a failed
      // write can never destroy the file (same order as the builtin).
      const target = op.movePath ?? op.filePath
      const content = op.content === undefined ? '' : (op.bom ? `\uFEFF${op.content}` : op.content)
      const dir = posix.dirname(target)
      const write = await ssh.exec(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(target)}`, {
        cwd: session.workspacePath,
        input: content,
      })
      if (write.code !== 0) {
        throw new Error(`Failed to write ${target}: ${write.stderr || write.stdout}`)
      }
      if (op.movePath) {
        const remove = await ssh.exec(`rm -f -- ${shellQuote(op.filePath)}`, { cwd: session.workspacePath })
        if (remove.code !== 0) {
          throw new Error(`Failed to move ${op.filePath}: ${remove.stderr || remove.stdout}`)
        }
      }
    }

    const lines = ops.map((op) => {
      const label = op.type === 'add' ? 'A' : op.type === 'delete' ? 'D' : 'M'
      const shown = posix.relative(session.workspacePath, op.type === 'delete' ? op.filePath : (op.movePath ?? op.filePath))
      return `${label} ${shown.replaceAll('\\', '/')}`
    })
    return `Success. Updated the following files:\n${lines.join('\n')}`
  },
})
