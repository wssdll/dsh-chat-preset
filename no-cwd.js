// Suppress the working-directory line in chat sessions.
//
// `@deepseek-ai/dsh-working-directory` registers `working-directory:current`
// as `required: true`:
//
//   ctx.systemPrompt.context({ name: "working-directory:current", required: true, … })
//
// A required contribution survives `includeRuntimeContext: false` and
// `complete: true`, so the chat preset still received a system-reminder block
// on every first step:
//
//   <system-reminder>
//   The following information describes your current session:
//   Current working directory: "C:\Users\Administrator\Documents\插件项目".
//   </system-reminder>
//
// That path is meaningless in a chat and it is the one piece of runtime
// context a persona cannot turn off. Per dsh-system-prompt, an agent-scoped
// contribution shadows a same-named global default, so this row registers the
// same name inside the preset scope with empty text. The working-directory
// service keeps running elsewhere; only this scope stops rendering the line.
export const name = 'chatmode-no-cwd'
export const inject = ['systemPrompt']

/** Section name owned by dsh-working-directory. */
export const SECTION = 'working-directory:current'

export function apply(ctx) {
  // `systemPrompt` is required: the context registry lives there. A missing
  // service fails activation loudly instead of silently leaving the line in.
  ctx.systemPrompt.context({
    name: SECTION,
    // Any order works: the shadow replaces the global row by name, and an
    // empty text disappears at render.
    order: ctx.systemPrompt.getContextOrder?.('WORKING_DIRECTORY') ?? 0,
    required: true,
    interpolate: false,
    text: () => '',
  })
}
