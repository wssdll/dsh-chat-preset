// Package entry.
//
// A DSH bundle does not need a JavaScript entry: the loader reads
// `dsh.bundle.patch` and mounts `cordis.patch.yml`, and every plugin in this
// package is referenced there by its own subpath export. This module exists
// only so that `import '@wssdll/dsh-chat-preset'` resolves instead of failing:
// once `exports` is declared, a package with no "." entry is unreachable by its
// bare name.
//
// It carries no runtime behaviour and registers nothing.
export const name = '@wssdll/dsh-chat-preset'

/** The patch file this bundle mounts. Informational only. */
export const patch = './cordis.patch.yml'
