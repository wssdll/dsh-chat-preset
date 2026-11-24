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
//     "names unknown global tools …". So every name handed to `restrict()` is
//     first intersected with the global view.
//
// A third concern shapes this revision: the mask used to be computed from the
// list of *visible* tools, so any failure to read that list turned into a silent
// full leak — the chat kept answering with all 27 tools, 8k tokens, no signal.
// The mask is now expressed as an `allow` list of the tools to keep, which does
// not depend on reading anything, and every degraded outcome is reported: to the
// log at `error`, and once per session as a short message the user can see.
import { randomUUID } from 'node:crypto'

export const name = 'chatmode-tool-guard'
export const inject = ['tools']

/**
 * Preset ids this guard applies to. Add an id here to cover another preset;
 * everything else in the profile is left untouched.
 */
export const PRESETS = ['chatmode']

/**
 * The tools a chat session keeps by default. Everything else visible at the
 * moment the mask is computed is masked away, so a newly installed plugin's
 * tools are excluded automatically without this list changing.
 *
 * To keep more, set `extraTools` on the `chatmode-tool-guard` row in the
 * profile patch; `allowSet` appends it. Do not edit this array for a local
 * preference — a package update replaces this file.
 */
export const ALLOWED = ['web_search', 'web_fetch', 'read', 'read_image']

/**
 * The built-in names plus the ones a mount opts into via `config.extraTools`.
 *
 * The row exports no Config schema on purpose: the package stays
 * dependency-free, so unset or malformed values fall back to the built-in
 * list instead of throwing. Names are trimmed; a name that is not a globally
 * registered tool is harmless — `narrow` intersects with the global view.
 * @param {unknown} config the raw plugin config
 * @returns {Set<string>}
 */
export function allowSet(config) {
  const extra = config?.extraTools
  const names = Array.isArray(extra)
    ? extra
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name) => name !== '')
    : []
  return new Set([...ALLOWED, ...names])
}

/**
 * Names `restrict()` will accept for this agent, or null when unreadable.
 *
 * This must be `definitions(agent)`, NOT the unscoped `definitions()`: the
 * latter only sees the global layer, while `restrict()` validates against
 * `view(scope).restrictableNames`, which is the global layer PLUS the agent's
 * ancestor layers — including the preset scope that mounts tool-web/tool-fs.
 * Using the unscoped view here silently drops `web_search`, `web_fetch`,
 * `read` and `read_image` from the allow list, leaving only `extraTools`.
 *
 * An agent's own scoped registrations are `visible` but not `restrictable`;
 * they are harmless here because neither ALLOWED nor extraTools names one.
 */
function restrictableView(ctx, agent) {
  try {
    return new Set(ctx.tools.definitions(agent).map((tool) => tool.name))
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
 * Record how the mask settled for one agent, logging only on a transition so a
 * session that stays degraded does not flood the log every step.
 *
 * `state` is a WeakMap so a disposed agent stops being an entry by itself.
 *
 * @param {any} ctx
 * @param {any} agent
 * @param {WeakMap<object, {state: string, detail?: string}>} state
 * @param {{state: string, detail?: string}} info
 */
function mark(ctx, agent, state, info) {
  if (!agent || typeof agent !== 'object') return
  const previous = state.get(agent)
  state.set(agent, info)
  if (previous?.state === info.state) return
  const session = agent?.session?.id ?? agent?.id ?? 'agent'
  if (info.state === 'ok') return
  ctx.logger?.error?.(
    `[chat] tool whitelist degraded (${info.state}) for ${session}: ${info.detail ?? 'unknown cause'}`,
  )
}

/**
 * Apply the mask. Safe to call from several hooks and from `tools/change`.
 *
 * The mask is an `allow` list, not a `deny` list: it no longer depends on
 * reading the agent's visible tools, so a failed read cannot silently leave
 * every tool in place. Every early exit records why, and the caller surfaces a
 * degraded outcome to the user.
 *
 * Re-entrancy is the subtle part. `restrict()` installs its restriction through
 * `ctx.effect`, which synchronously emits `tools/change`; this plugin listens to
 * that event, so an unguarded re-application would recurse without bound and
 * freeze the client. Two mechanisms stop it:
 *
 *  1. `inside` marks an agent while its mask is being installed, so the nested
 *     event is ignored.
 *  2. `applied` remembers the exact name set already installed, so a re-entry
 *     from any other path is a no-op instead of stacking another restriction.
 *
 * (A `deny` mask avoided the recursion by accident: once the denied tools were
 * gone, the computed deny set became empty and the next pass returned early.
 * An `allow` set is stable by nature and would never empty out, which is why
 * the signature check is required here.)
 *
 * @param {any} ctx registry context used to read the global view
 * @param {any} agent
 * @param {any} [writer] context whose `tools.restrict` installs the mask;
 *   defaults to `agent.ctx`.
 * @param {Set<string>} allowed tool names this agent keeps
 * @param {{state: WeakMap, applied: WeakMap, inside: WeakSet}} bookkeeping
 */
function narrow(ctx, agent, writer, allowed, bookkeeping) {
  const { state, applied, inside } = bookkeeping
  if (!agent || typeof agent !== 'object') return
  // Our own `restrict()` below emits `tools/change`, which lands back here.
  if (inside.has(agent)) return
  inside.add(agent)
  try {
    const scope = writer?.tools ? writer : agent?.ctx
    if (!scope?.tools) {
      mark(ctx, agent, state, { state: 'unavailable', detail: 'no tool scope on this agent' })
      return
    }

    // `restrict()` validates names against the agent's restrictable view
    // (global + ancestor/preset layers). Intersect with that — NOT with the
    // unscoped global view, which omits the preset's own tool-web/tool-fs rows.
    // If the view cannot be read, fall back to the built-in names.
    const known = restrictableView(ctx, agent)
    const names = known
      ? [...allowed].filter((name) => known.has(name))
      : [...ALLOWED]

    if (names.length === 0) {
      // An empty allow list would hide every tool, which is worse than leaking:
      // the session would answer with nothing callable at all. Leave the mask off
      // and say so instead.
      mark(ctx, agent, state, {
        state: 'failed',
        detail: known ? 'none of the whitelisted tools is restrictable for this agent' : 'unknown',
      })
      return
    }

    // Same mask as last time: nothing to do. This is the normal path once the
    // restriction is installed, since every later `tools/change` re-enters.
    const signature = names.join('\u0000')
    const previous = applied.get(agent)
    if (previous !== undefined && previous.signature === signature) {
      mark(ctx, agent, state, { state: 'ok' })
      return
    }

    try {
      const dispose = scope.tools.restrict({ allow: names })
      // Install the new mask before lifting the old one: restrictions
      // intersect, so the overlap hides nothing the new mask keeps.
      previous?.dispose?.()
      applied.set(agent, { signature, dispose })
      mark(ctx, agent, state, { state: 'ok' })
    } catch (error) {
      // Never fail a chat over this: extra visible tools are bad, a session that
      // will not start is worse. Report loudly instead of swallowing it.
      //
      // No per-name retry here on purpose: restrictions *intersect*, so two
      // separate `allow` calls keep only the tools in both — retrying name by
      // name would hide everything.
      mark(ctx, agent, state, {
        state: 'failed',
        detail: `restrict() refused ${names.join(', ')}: ${error?.message ?? error}`,
      })
    }
  } finally {
    inside.delete(agent)
  }
}

/** The one-line explanation injected into a session whose mask is degraded. */
function noticeText(info) {
  const why = info.detail ? `（${info.detail}）` : ''
  const english = info.detail ? ` (${info.detail})` : ''
  return [
    '⚠️ 聊天模式的工具白名单这一轮没能完全生效，会话里可能带着额外工具在跑，token 消耗会高于正常水平。',
    `原因${why}。检查 profile 的 cordis.patch.yml，或重启 DSH 后再试。`,
    `The chat preset's tool whitelist could not be fully applied${english}; extra tools may be in context.`,
  ].join('\n\n')
}

/** Build the injected message the way @deepseek-ai/dsh-llm does. */
function noticeMessage(info) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: noticeText(info) }],
    source: { kind: name },
  }
}

export function apply(ctx, config) {
  const allowed = allowSet(config)
  // One closure so every hook reinstalls the same mask over the same maps.
  const bookkeeping = {
    // agent -> {state, detail} for the degraded notice.
    state: new WeakMap(),
    // agent -> {signature, dispose} for the mask currently installed.
    applied: new WeakMap(),
    // agents whose mask is being installed right now (re-entrancy guard).
    inside: new WeakSet(),
  }
  const narrowOne = (agent, writer) => narrow(ctx, agent, writer, allowed, bookkeeping)

  // sessionId -> agent, so a selection that reports only a session id can find
  // the agent it applies to.
  const bySession = new Map()
  // Sessions whose preset was committed before their agent appeared.
  const pending = new Set()
  // Agents currently under the mask, for re-application when tools change.
  const guarded = new Set()
  // Sessions already told that their mask is degraded; one notice per session.
  const told = new Set()

  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (!PRESETS.includes(agentPreset ?? '')) return
    const agent = bySession.get(String(sessionId))
    if (agent) narrowOne(agent)
    else pending.add(String(sessionId))
  })

  ctx.on('agent/created', function created({ agent }) {
    const sessionId = agent?.session?.id
    const preset = presetOf(agent, ctx.get?.('agentPresets'))
    if (sessionId !== undefined) {
      bySession.set(String(sessionId), agent)
      if (pending.delete(String(sessionId))) narrowOne(agent)
    }
    if (PRESETS.includes(preset ?? '')) {
      narrowOne(agent)
      guarded.add(agent)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (sessionId !== undefined) {
      bySession.delete(String(sessionId))
      told.delete(String(sessionId))
    }
    guarded.delete(agent)
  })

  // A plugin installed or hot-loaded after the session started registers its
  // tools now, not at session creation. Re-applying the mask on every tool
  // change covers that case. `narrow` is re-entrancy safe and skips an
  // unchanged mask, so this cannot loop with the `tools/change` that
  // `restrict()` itself emits.
  ctx.on('tools/change', () => {
    if (guarded.size === 0) return
    for (const agent of guarded) {
      // A disposed agent leaves the set through its own handler; skip if the
      // context is already gone rather than throwing inside the loop.
      if (!agent?.ctx?.tools) {
        guarded.delete(agent)
        continue
      }
      narrowOne(agent)
    }
  })

  // Safety net for later turns, and for a selection that arrived without an
  // agent. The Scoped<Agent> `this` is the context that can install the mask.
  //
  // This hook also carries the user-visible half of the degraded report: a
  // mask that silently fails is the exact failure this preset exists to avoid,
  // so the session gets one short notice and no more.
  ctx.on('agent/pre-step', async function preStep(payload, next) {
    const agent = payload?.agent
    const chat = PRESETS.includes(presetOf(agent, ctx.get?.('agentPresets')) ?? '')
    if (chat) {
      narrowOne(agent, this)
      guarded.add(agent)
    }
    const decision = await next()
    if (!chat || decision?.kind === 'reject') return decision

    const sessionId = agent?.session?.id
    const info = agent && typeof agent === 'object' ? bookkeeping.state.get(agent) : undefined
    if (sessionId === undefined || info === undefined || info.state === 'ok') return decision
    const key = String(sessionId)
    if (told.has(key)) return decision
    told.add(key)
    return {
      ...decision,
      messages: [...(decision.messages ?? []), noticeMessage(info)],
    }
  })
}
