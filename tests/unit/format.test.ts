import { describe, expect, it } from 'vitest'
import { formatBytes, mbToBytes } from '../../src/renderer/src/format'

describe('mbToBytes', () => {
  it('uses decimal megabytes so binary-MB portals also accept the file', () => {
    expect(mbToBytes(1.75)).toBe(1_750_000)
    expect(mbToBytes(10)).toBe(10_000_000)
  })

  it('rounds to a whole number of bytes', () => {
    expect(Number.isInteger(mbToBytes(0.333))).toBe(true)
  })
})

describe('formatBytes', () => {
  it('formats megabytes to two decimals', () => {
    expect(formatBytes(1_750_000)).toBe('1.75 MB')
    expect(formatBytes(20_400_000)).toBe('20.40 MB')
  })

  it('uses kilobytes below one megabyte', () => {
    expect(formatBytes(45_000)).toBe('45 KB')
  })

  it('never reports zero MB for a non-empty file', () => {
    expect(formatBytes(1)).toBe('1 KB')
  })
})
