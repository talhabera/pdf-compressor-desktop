// Generates test PDFs so no binary blobs live in git. Run: npm run fixtures
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')
mkdirSync(OUT, { recursive: true })

export const SENTINEL = 'GHOSTSCRIPT_FIXTURE_SENTINEL'

/** Minimal PNG encoder: 8-bit RGB, no dependencies. */
function encodePng(width, height, pixels) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 2    // colour type: truecolour
  // bytes 10-12 stay zero: deflate, no filter, no interlace

  // Each scanline is prefixed with filter byte 0.
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    pixels.copy(raw, row + 1, y * width * 3, (y + 1) * width * 3)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Deterministic page image resembling a scan: smooth tonal variation, a few
 * darker blotches, and light grain. This is what real scanned paper looks like
 * to a compressor — spatially correlated, so downsampling and JPEG both bite.
 *
 * `Math.imul` is required, not decoration. The obvious `s * 1103515245`
 * exceeds float64's safe integer range, and the resulting precision loss
 * collapses the sequence into a repeating pattern: measured deflate ratio
 * 0.0199 versus 1.0003 for this version. That bug made each page compress to
 * ~46 KB instead of ~4.6 MB, which is why an earlier fixture needed 190 pages
 * to reach 8 MB.
 */
function scanPageImage(width, height, seed) {
  const px = Buffer.alloc(width * height * 3)
  let s = seed | 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      s = (Math.imul(s, 1103515245) + 12345) | 0
      const grain = ((s >>> 16) & 0x1f) - 16
      const tone = 128 + 80 * Math.sin(x / 90) * Math.cos(y / 110) + 40 * Math.sin((x + y) / 50)
      const blotch = (x * x + y * y) % 9973 < 600 ? -70 : 0
      const v = Math.max(0, Math.min(255, Math.round(tone + grain + blotch)))
      const i = (y * width + x) * 3
      px[i] = v
      px[i + 1] = v
      px[i + 2] = v
    }
  }
  return encodePng(width, height, px)
}

async function makeTextHeavy() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let p = 0; p < 200; p++) {
    const page = doc.addPage([612, 792])
    if (p === 0) {
      page.drawText(SENTINEL, { x: 50, y: 740, size: 14, font, color: rgb(0, 0, 0) })
    }
    for (let line = 0; line < 40; line++) {
      page.drawText(
        `Page ${p + 1} line ${line + 1}: the quick brown fox jumps over the lazy dog.`,
        { x: 50, y: 710 - line * 17, size: 10, font, color: rgb(0.1, 0.1, 0.1) },
      )
    }
  }
  writeFileSync(join(OUT, 'text-heavy.pdf'), await doc.save())
}

async function makeScanHeavy() {
  const doc = await PDFDocument.create()
  // 1700x2200 into a US Letter page is ~200 DPI, a realistic scan resolution.
  // Three pages is enough to exceed 8 MB and keeps integration tests fast —
  // every Ghostscript pass in the search runs over this whole file.
  for (let p = 0; p < 3; p++) {
    const png = await doc.embedPng(scanPageImage(1700, 2200, 7919 + p * 104729))
    const page = doc.addPage([612, 792])
    page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 })
  }
  writeFileSync(join(OUT, 'scan-heavy.pdf'), await doc.save())
}

async function makeAlreadyTiny() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([612, 792]).drawText('Small file.', { x: 50, y: 700, size: 12, font })
  writeFileSync(join(OUT, 'already-tiny.pdf'), await doc.save())
}

await makeTextHeavy()
await makeScanHeavy()
await makeAlreadyTiny()

for (const name of ['text-heavy.pdf', 'scan-heavy.pdf', 'already-tiny.pdf']) {
  const bytes = statSync(join(OUT, name)).size
  console.log(`${name.padEnd(20)} ${(bytes / 1_000_000).toFixed(2)} MB`)
}
