// read_attachment: the only file access in the chat preset. It reads a file
// the user attached to *this* chat and refuses every other path. Scope is
// enforced here in the Host, not by asking the model to behave.
//
// Self-contained: imports only Node built-ins (no @deepseek-ai packages), so it
// loads in any DSH engine that provides `tools` and `attachments` services —
// including the engine inside DSH-Go on a phone.
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute, sep } from 'node:path'

export const name = 'chatmode-read-attachment'
export const inject = ['tools', 'attachments']

const READ_LIMIT = 2000
const DENY_MESSAGE = 'read_attachment: path is not an attachment of this chat'

/** $DSH_HOME when set and non-blank, otherwise ~/.dsh. */
function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME?.trim()
  return configured ? configured : join(home, '.dsh')
}

/** Host paths of file blocks in the chat's user messages. */
function collectSessionAttachmentPaths(messages, hostPathOf) {
  const paths = new Set()
  for (const message of messages ?? []) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'file' || !block.attachment) continue
      try {
        const p = hostPathOf(block.attachment)
        if (p) paths.add(p)
      } catch {
        // An attachment whose host path cannot be resolved is simply unreadable.
      }
    }
  }
  return paths
}

async function realPaths(paths) {
  const out = new Set()
  for (const p of paths) {
    try {
      out.add(await realpath(p))
    } catch {
      // A missing stored object is not readable.
    }
  }
  return out
}

/** A path is allowed only inside the attachment store AND attached to this chat. */
async function resolveAllowedAttachment(requestedPath, objectsRoot, allowedRealPaths) {
  if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) return null
  let realPath, realRoot
  try {
    realPath = await realpath(requestedPath)
    realRoot = await realpath(objectsRoot)
  } catch {
    // Do not reveal whether an arbitrary path exists.
    return null
  }
  if (!realPath.startsWith(realRoot + sep)) return null
  if (!allowedRealPaths.has(realPath)) return null
  return realPath
}

/** Same envelope as dsh-tool-fs `read`, so the model knows the format. */
function renderWindow(text, realPath, offset = 1, limit = READ_LIMIT) {
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${READ_LIMIT}`)
  }
  const lines = text.split('\n')
  const total = lines.length
  if (offset > total) throw new Error(`offset ${offset} is past the end of the file (${total} lines)`)
  const end = Math.min(total, offset + limit - 1)
  const body = lines.slice(offset - 1, end).map((line, i) => `${offset + i}: ${line}`).join('\n')
  const footer =
    end < total
      ? `(Showing lines ${offset}-${end} of ${total}. Use offset=${end + 1} to continue.)`
      : `(Showing lines ${offset}-${end} of ${total}.)`
  return `<path>${realPath}</path>\n<type>file</type>\n<content>\n${body}\n\n${footer}\n</content>`
}

export function apply(ctx) {
  // DSH attachment root: images in objects/, other files in files/.
  const attachmentsRoot = join(resolveDshHome(), 'attachments', 'v1')
  const hostPathOf = (ref) => {
    try {
      return ctx.attachments.fileHostPath(ref)
    } catch {
      return undefined
    }
  }

  ctx.tools.register({
    name: 'read_attachment',
    description:
      "Read a file the user attached to this chat. Only paths given in the user's attachment lines are readable; every other path is refused. " +
      `Returns numbered lines, at most ${READ_LIMIT} per call; use offset to continue.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Absolute saved path from the attachment line.' },
        offset: { type: 'integer', minimum: 1, description: '1-based first line. Defaults to 1.' },
        limit: { type: 'integer', minimum: 1, maximum: READ_LIMIT, description: `Max lines. Defaults to ${READ_LIMIT}.` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args?.file_path !== 'string' || args.file_path.trim() === '') {
        throw new Error('file_path must be a non-empty string')
      }
      const session = exec?.agent?.session
      if (!session) throw new Error('read_attachment requires an owning chat session')
      const allowed = await realPaths(
        collectSessionAttachmentPaths(session.deriveMessages(), hostPathOf),
      )
      const realPath = await resolveAllowedAttachment(args.file_path, attachmentsRoot, allowed)
      if (!realPath) throw new Error(DENY_MESSAGE)
      const text = await readFile(realPath, 'utf8')
      return { text: renderWindow(text, realPath, args.offset ?? 1, args.limit ?? READ_LIMIT) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read attachment', kind: 'read', rawInput: args }),
  })
}

// Exported for tests.
export { resolveDshHome, collectSessionAttachmentPaths, resolveAllowedAttachment, renderWindow, READ_LIMIT }
