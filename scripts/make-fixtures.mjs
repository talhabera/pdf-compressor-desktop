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

/** Deterministic pseudo-random noise. Noise does not compress, so the PDF stays big. */
function noiseImage(width, height, seed) {
  const px = Buffer.alloc(width * height * 3)
  let s = seed
  for (let i = 0; i < px.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    px[i] = (s >> 16) & 0xff
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
  for (let p = 0; p < 190; p++) {
    const png = await doc.embedPng(noiseImage(1100, 1400, 7919 + p * 104729))
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
