/** Decimal megabytes. See the "1 MB = 1,000,000 bytes" global constraint. */
export const BYTES_PER_MB = 1_000_000

export function mbToBytes(mb: number): number {
  return Math.round(mb * BYTES_PER_MB)
}

export function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MB) return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}
