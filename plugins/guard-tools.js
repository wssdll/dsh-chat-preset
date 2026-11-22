// Narrow a 「聊天模式」 session down to the tools a chat actually needs.
//
// Why this exists: a preset only *mounts* tools; it cannot unmount the ones the
// profile's other plugins register globally (computer use, dsh-ops, the shell,
// todo, goals, subagents…). Every global tool reaches every agent with its full
// schema in the request, and the catalogue — not the persona — ends up shaping
// the replies. Measured from `request/header` in real chat sessions: before this
// guard, 27 tools and 30 357 bytes of schema (~7 589 tokens at bytes/4), against
// an 860-character persona. After: 4 tools, 1 400 bytes (~350 tokens) — roughly
// a 22× reduction.
//
// Keep this list in step with the preset's own `plugins:` rows. The two live in
// different files, and a name that leaks in here without being mounted (or the
// reverse) fails silently: the tool vanishes from the request with no error.
//
// Two constraints decide the shape of this file, both established by
// measurement rather than by reading the docs alone:
//
//  1. The mask must be installed before the step's tool set is resolved.
//     `agent/pre-step` looks like the obvious hook and is too late:
//         turn/start .209 → agent/pre-step .221 (27 → 6, restrict DID work)
//         → request/header .248 (tools=27, already fixed)
//     `agent-preset/selected` arrives seconds earlier and is the only hook that
//     provably precedes resolution, so the mask is installed from there.
//
//  2. `restrict()` only masks *global* tools. Scoped registrations stay visible
//     by design ("scoped registrations remain visible"), and naming one in a
//     filter makes the registry reject the whole filter with
//     "names unknown global tools …". So the deny set is intersected with the
//     global view, and a tool registered in an agent-owned scope cannot be
//     removed from here — that needs the providing plugin disabled.
export const name = 'chatmode-tool-guard'
export const inject = ['tools']

/**
 * Preset ids this guard applies to. Add an id here to cover another preset;
 * everything else in the profile is left untouched.
 */
export const PRESETS = ['chatmode']

/**
 * The only tools a chat session keeps. Everything else visible at the moment
 * the mask is computed is denied, so a newly installed plugin's tools are
 * excluded automatically without this list changing.
 */
export const ALLOWED = ['web_search', 'web_fetch', 'read', 'read_image']

/** Visible tool names for one agent, or a diagnostic string on failure. */
function visible(ctx, agent) {
  try {
    return ctx.tools.definitions(agent).map((tool) => tool.name)
  } catch (error) {
    return `ERR:${error?.message ?? error}`
  }
}

/** Names in the unscoped/global view, or null when it cannot be read. */
function globalView(ctx) {
  try {
    return new Set(ctx.tools.definitions().map((tool) => tool.name))
  } catch {
    return null
  }
}

/**
 * Read the preset a live agent runs.
 *
 * The session header is not reliable: a real session carried
 * `agentPreset: "standard"` in its header while the user had picked
 * 「聊天模式」. The committed choice lives in the `agent-preset/selected` event.
 * @param {any} agent
 * @param {any} [agentPresets]
 * @returns {string | undefined}
 */
export function presetOf(agent, agentPresets) {
  try {
    const events = agent?.session?.ownEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === 'agent-preset/selected') {
        const id = events[i]?.data?.agentPreset
        if (typeof id === 'string' && id !== '') return id
      }
    }
  } catch {
    // Fall through to the other readers.
  }
  try {
    const composed = agentPresets?.composedPreset?.(agent.ctx)
    if (typeof composed === 'string' && composed !== '') return composed
  } catch {
    // Fall through to the header.
  }
  const recorded = agent?.session?.header?.agentPreset
  return typeof recorded === 'string' && recorded !== '' ? recorded : undefined
}

/**
 * Apply the mask. Idempotent, so calling it from several hooks is harmless.
 * @param {any} ctx registry context used to read tool definitions
 * @param {any} agent
 * @param {any} [writer] context whose `tools.restrict` installs the mask;
 *   defaults to `agent.ctx`.
 */
function narrow(ctx, agent, writer) {
  const scope = writer?.tools ? writer : agent?.ctx
  if (!scope?.tools) return
  const before = visible(ctx, agent)
  if (typeof before === 'string') {
    ctx.logger?.warn?.(`[chat] cannot read tools: ${before}`)
    return
  }
  const deny = before.filter((name) => !ALLOWED.includes(name))
  if (deny.length === 0) return
  // Scoped tools are invisible to `restrict()` and poison the whole filter.
  const globalNames = globalView(ctx)
  const denyGlobal = globalNames ? deny.filter((name) => globalNames.has(name)) : deny
  if (denyGlobal.length === 0) return
  try {
    scope.tools.restrict({ deny: denyGlobal })
  } catch (error) {
    // Never fail a chat over this: one extra visible tool is bad, a session
    // that will not start is worse.
    ctx.logger?.warn?.('[chat] could not restrict tools', error)
  }
}

export function apply(ctx) {
  // sessionId -> agent, so a selection that reports only a session id can find
  // the agent it applies to.
  const bySession = new Map()
  // Sessions whose preset was committed before their agent appeared.
  const pending = new Set()
  // Agents currently under the mask, for re-application when tools change.
  const guarded = new Set()

  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (!PRESETS.includes(agentPreset ?? '')) return
    const agent = bySession.get(String(sessionId))
    if (agent) narrow(ctx, agent)
    else pending.add(String(sessionId))
  })

  ctx.on('agent/created', function created({ agent }) {
    const sessionId = agent?.session?.id
    const preset = presetOf(agent, ctx.get?.('agentPresets'))
    if (sessionId !== undefined) {
      bySession.set(String(sessionId), agent)
      if (pending.delete(String(sessionId))) narrow(ctx, agent)
    }
    if (PRESETS.includes(preset ?? '')) {
      narrow(ctx, agent)
      guarded.add(agent)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (sessionId !== undefined) bySession.delete(String(sessionId))
    guarded.delete(agent)
  })

  // A plugin installed or hot-loaded after the session started registers its
  // tools now, not at session creation. Re-applying the mask on every tool
  // change covers that case: `restrict()` intersects, so repeated masks are
  // harmless and a newly appeared tool is denied in the same tick.
  ctx.on('tools/change', () => {
    if (guarded.size === 0) return
    for (const agent of guarded) {
      // A disposed agent leaves the set through its own handler; skip if the
      // context is already gone rather than throwing inside the loop.
      if (!agent?.ctx?.tools) {
        guarded.delete(agent)
        continue
      }
      narrow(ctx, agent)
    }
  })

  // Safety net for later turns, and for a selection that arrived without an
  // agent. The Scoped<Agent> `this` is the context that can install the mask.
  ctx.on('agent/pre-step', function preStep(payload, next) {
    const agent = payload?.agent
    if (PRESETS.includes(presetOf(agent, ctx.get?.('agentPresets')) ?? '')) {
      narrow(ctx, agent, this)
      guarded.add(agent)
    }
    return next()
  })
}
