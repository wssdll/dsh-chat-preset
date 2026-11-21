// A minimal clock for the chat preset.
//
// The shipped @deepseek-ai/dsh-time-context injects three lines per reading:
//
//   Time sampled while preparing turn 20, step 1: 2026-11-21T23:27:34+08:00[…]
//   Browser time zone for this request: Asia/Shanghai. Interpret unqualified […]
//   Elapsed since the preceding model-visible message: 1m 36s.
//
// That is a technical event report. Measured on a 20-turn chat, the model
// started treating the timestamp as something to act on. This row replaces it
// with one plain sentence, injected at most once per hour, so the model knows
// roughly when "now" is without being handed a stream of state updates.
//
// Injected as an extra user-role message in the durable history, exactly like
// the shipped row, so `includeRuntimeContext: false` does not affect it.
import { randomUUID } from 'node:crypto'

export const name = 'chatmode-clock'
export const inject = ['timer']

/** Inject at most once per hour; also the first step of a fresh session. */
const REFRESH_MS = 60 * 60 * 1000

/** Weekday names for the short suffix. */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * Render the reading. One line, no turn/step numbers, no policy text.
 * @param {Date} now
 * @param {string} [timeZone] IANA zone; falls back to the system zone
 * @returns {string}
 */
export function renderClock(now, timeZone) {
  let stamp
  try {
    stamp = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now)
  } catch {
    // An unusable zone must not break the step; fall back to the host's own.
    stamp = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now)
  }
  return `当前时间：${stamp}（${WEEKDAYS[now.getDay()]}）。`
}

/** Build the message the way @deepseek-ai/dsh-llm's createUserMessage does. */
function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: name },
  }
}

export function apply(ctx) {
  // sessionId -> last injection wall clock, kept per session.
  const lastInjected = new Map()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return decision

    const now = Date.now()
    const last = lastInjected.get(String(sessionId))
    if (last !== undefined && now - last < REFRESH_MS) return decision
    lastInjected.set(String(sessionId), now)

    // The open request already told us the browser's zone; use it when present
    // so "now" matches what the user sees, not the host's zone.
    const timeZone = payload?.messages
      ?.map((m) => m?.source?.clientTimeZone)
      .filter((z) => typeof z === 'string')
      .at(-1)

    return {
      ...decision,
      messages: [...(decision.messages ?? []), userMessage(renderClock(new Date(now), timeZone))],
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (sessionId !== undefined) lastInjected.delete(String(sessionId))
  })
}
