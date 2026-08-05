import { describe, expect, it } from 'vitest'
import { classifyFailure } from '../../src/main/errors'
import { GsError } from '../../src/main/gs-run'

const gsErr = (stderr: string, code: number | null = 1) =>
  new GsError('failed', code, stderr)

describe('classifyFailure', () => {
  it('recognises a password-protected PDF', () => {
    const f = classifyFailure(gsErr('This file requires a password for access.'))
    expect(f.kind).toBe('encrypted')
    expect(f.message).toBe(
      'This PDF is password-protected. Remove the password and try again.',
    )
  })

  it('recognises a file that is not a readable PDF', () => {
    // Every string here is real Ghostscript 10.07.1 output, captured by
    // feeding it a text file, a truncated PDF, and a missing path.
    for (const stderr of [
      'Error: /undefined in this',
      'Catalog dictionary not located in file, unable to proceed\n   **** Error: Couldn\'t initialise file.',
      'Error: /syntaxerror in --file--',
      'Unrecoverable error, exit code 1',
    ]) {
      expect(classifyFailure(gsErr(stderr)).kind).toBe('not-pdf')
    }
  })

  it('reports a password-protected PDF as encrypted, not as corrupt', () => {
    // Ghostscript prints BOTH "requires a password" and "Couldn't initialise
    // file." for a locked PDF. If the corrupt pattern were checked first,
    // every encrypted file would get the wrong message.
    const real =
      'GPL Ghostscript 10.07.1: \n   **** This file requires a password for access.\n' +
      "   **** Error: Couldn't initialise file.\n               Output may be incorrect."
    expect(classifyFailure(gsErr(real)).kind).toBe('encrypted')
  })

  it('recognises a full disk from either Ghostscript or Node', () => {
    expect(classifyFailure(gsErr('No space left on device')).kind).toBe('no-space')
    expect(classifyFailure(Object.assign(new Error('write'), { code: 'ENOSPC' })).kind)
      .toBe('no-space')
  })

  it('recognises a missing Ghostscript binary', () => {
    expect(classifyFailure(Object.assign(new Error('spawn'), { code: 'ENOENT' })).kind)
      .toBe('gs-missing')
    expect(classifyFailure(Object.assign(new Error('perm'), { code: 'EACCES' })).kind)
      .toBe('gs-missing')
  })

  it('recognises the Windows loader failure from a missing VC++ runtime', () => {
    // STATUS_DLL_NOT_FOUND (0xC0000135): CreateProcess succeeds, the loader
    // then fails to resolve VCRUNTIME140.dll et al. This is a clean exit
    // with empty stderr, not a spawn error, so it must be caught by exit
    // code rather than by `code` (ENOENT/EACCES) or any stderr pattern.
    expect(classifyFailure(gsErr('', 3221225781)).kind).toBe('gs-missing')
    // Node on Windows may surface the same DWORD as a signed 32-bit value.
    expect(classifyFailure(gsErr('', -1073741515)).kind).toBe('gs-missing')
  })

  it('recognises cancellation', () => {
    expect(classifyFailure(gsErr('', null)).kind).toBe('cancelled')
  })

  it('falls back to a generic message but keeps the diagnostics', () => {
    const f = classifyFailure(gsErr('something nobody has ever seen before'))
    expect(f.kind).toBe('unknown')
    expect(f.message).toBe('Compression failed on this file.')
    expect(f.details).toContain('something nobody has ever seen before')
  })

  it('handles a non-Error being thrown', () => {
    const f = classifyFailure('a bare string')
    expect(f.kind).toBe('unknown')
    expect(f.details).toContain('a bare string')
  })

  it('never puts an exit code or a stack trace in the user-facing message', () => {
    for (const input of [
      gsErr('Error: /syntaxerror in --file--'),
      gsErr('exit code 1'),
      'boom',
    ]) {
      const f = classifyFailure(input)
      expect(f.message).not.toMatch(/exit code|stack|Error:|\/tmp/i)
      expect(f.message.endsWith('.')).toBe(true)
    }
  })
})
