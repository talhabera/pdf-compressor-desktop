import type { CompressFailure, FailureKind } from '@shared/types'
import { GsError } from './gs-run'

const MESSAGES: Record<FailureKind, string> = {
  'not-pdf': "This file isn't a readable PDF.",
  encrypted: 'This PDF is password-protected. Remove the password and try again.',
  'no-space': 'Ran out of disk space while compressing.',
  'gs-missing': "Something's wrong with this installation — please reinstall.",
  'input-unreadable': "Couldn't open that file. It may have been moved, renamed, or deleted.",
  cancelled: 'Cancelled.',
  unknown: 'Compression failed on this file.',
}

// Patterns observed from Ghostscript 10.07.1 itself, not guessed. The exact
// strings each one targets are recorded in Task 7 Step 1.
//
// Order matters: "Couldn't initialise file." appears in BOTH the encrypted and
// the corrupt cases, so the password check must come first or every locked PDF
// is reported as corrupt.
const STDERR_PATTERNS: ReadonlyArray<[RegExp, FailureKind]> = [
  // "**** This file requires a password for access."
  [/requires a password|invalid password|owner password/i, 'encrypted'],
  [/no space left|disk full/i, 'no-space'],
  // "Catalog dictionary not located in file, unable to proceed" (truncated),
  // "Error: /undefined in this" (not a PDF at all),
  // "Couldn't initialise file." (generic unreadable input).
  [
    /catalog dictionary not located|couldn't initialise file|syntaxerror|unrecoverable error|cannot recover|not a pdf|undefined in/i,
    'not-pdf',
  ],
]

function nodeErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err as { code: unknown }
    if (typeof code === 'string') return code
  }
  return null
}

export function classifyFailure(err: unknown): CompressFailure {
  const details = err instanceof Error ? (err.stack ?? err.message) : String(err)

  const build = (kind: FailureKind): CompressFailure => ({
    kind,
    message: MESSAGES[kind],
    details,
  })

  const code = nodeErrorCode(err)
  if (code === 'ENOSPC') return build('no-space')
  if (code === 'ENOENT' || code === 'EACCES') return build('gs-missing')

  if (err instanceof GsError) {
    for (const [pattern, kind] of STDERR_PATTERNS) {
      if (pattern.test(err.stderr)) return { ...build(kind), details: err.stderr }
    }
    // A null exit code means the process was killed rather than exiting on its own.
    if (err.exitCode === null) return { ...build('cancelled'), details: err.stderr }
    return { ...build('unknown'), details: `${err.message}\n${err.stderr}` }
  }

  return build('unknown')
}
