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

// STATUS_DLL_NOT_FOUND (0xC0000135). Windows reports this as the child
// process's exit code when the loader can't resolve a dependency — e.g. the
// VC++ runtime gswin64c.exe/gsdll64.dll need, if resources/gs/win/
// vcredist_x64.exe was never run (see build/installer.nsh). CreateProcess
// itself succeeds, so this arrives as a normal `close` event with a non-zero
// exit code and empty stderr, not as a spawn error — `nodeErrorCode` above
// never sees it. Without this mapping it falls through to 'unknown' and a
// broken installation gets reported as "Compression failed on this file.",
// blaming the user's PDF for what is actually a missing runtime dependency.
//
// Both the unsigned DWORD value (3221225781) and its signed 32-bit
// reinterpretation (-1073741515) are checked: this project has never run on
// an actual Windows machine, so which form Node's `close` event surfaces is
// unconfirmed — see Task 4's report for what remains unverified.
const DLL_NOT_FOUND_EXIT_CODES: ReadonlySet<number> = new Set([3221225781, -1073741515])

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
    if (err.exitCode !== null && DLL_NOT_FOUND_EXIT_CODES.has(err.exitCode)) {
      return build('gs-missing')
    }
    for (const [pattern, kind] of STDERR_PATTERNS) {
      if (pattern.test(err.stderr)) return { ...build(kind), details: err.stderr }
    }
    // A null exit code means the process was killed rather than exiting on its own.
    if (err.exitCode === null) return { ...build('cancelled'), details: err.stderr }
    return { ...build('unknown'), details: `${err.message}\n${err.stderr}` }
  }

  return build('unknown')
}
