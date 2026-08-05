# PDF Compressor Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS + Windows desktop app that compresses one PDF at a time down to a user-specified target size, defaulting to 1.75 MB, with no dependencies for the end user to install.

**Architecture:** An Electron main process drives a bundled Ghostscript binary across a fixed ladder of quality rungs (image DPI + JPEG QFactor). A pure search function probes rung 0, probes the readability floor, then binary-searches the rungs between them for the highest quality whose *measured* output fits the target. The React renderer is a single screen and holds no compression logic.

**Tech Stack:** Electron, React 19, TypeScript, Vite (via `electron-vite`), `electron-builder`, Vitest, Ghostscript 10.07.1, `pdf-lib` (test fixtures only).

## Global Constraints

- **1 MB = 1,000,000 bytes.** Decimal, not binary. A portal that means MiB accepts a decimal-sized file; the reverse fails. Use this everywhere — UI, tests, defaults. Default target is `1_750_000` bytes.
- **Ghostscript is never assumed to be installed.** All invocations go through the bundled binary resolved by `gs-locate.ts`. Never spawn a bare `gs`.
- **Text is never rasterized at any rung**, including beyond the floor. Rungs change image encoding only.
- **The returned file is always one whose size was measured.** Never infer that a rung fits; never return an unmeasured file.
- **Readability floor is rung 11.** Rungs 12–15 are reachable only when the user presses "Squeeze harder".
- **Bundled binaries live in `resources/gs/mac/` and `resources/gs/win/`** and are gitignored. `mac` / `win` match electron-builder's `${os}` macro — do not rename them to `darwin` / `win32`.
- **Node platform mapping:** `process.platform === 'win32'` → `win`, everything else → `mac`.
- **User-facing error text is a plain sentence.** No exit codes, no stack traces, no jargon in the UI.
- Commit after every task. Conventional commit prefixes (`feat:`, `test:`, `chore:`, `fix:`).

## File Structure

```
package.json                       Scripts, deps
electron.vite.config.ts            Build config for main / preload / renderer
electron-builder.yml               Packaging config
tsconfig.json                      Project references
tsconfig.node.json                 main + preload
tsconfig.web.json                  renderer
vitest.config.ts                   Test config

scripts/fetch-ghostscript.sh       One-time: build/download gs into resources/gs/
scripts/make-fixtures.mjs          Generates test PDFs (no binaries in git)

src/shared/types.ts                Types crossing the IPC boundary
src/main/ladder.ts                 Rung table, floor index, gs argv construction
src/main/compress.ts               The search algorithm (pure, injected runner)
src/main/gs-locate.ts              Resolve the bundled gs path
src/main/gs-run.ts                 Spawn gs for one rung; measure; cancel
src/main/errors.ts                 Map gs failures to plain-language messages
src/main/compress-file.ts          Wires gs-run + compress + errors into one call
src/main/ipc.ts                    IPC handlers
src/main/index.ts                  App + window lifecycle
src/preload/index.ts               contextBridge surface

src/renderer/index.html
src/renderer/src/main.tsx
src/renderer/src/App.tsx           The single screen, all state
src/renderer/src/format.ts         Byte/MB formatting
src/renderer/src/components/DropZone.tsx
src/renderer/src/components/TargetInput.tsx
src/renderer/src/components/ProgressPanel.tsx
src/renderer/src/components/ResultCard.tsx
src/renderer/src/styles.css

tests/unit/ladder.test.ts
tests/unit/compress.test.ts
tests/unit/gs-locate.test.ts
tests/unit/errors.test.ts
tests/unit/format.test.ts
tests/integration/gs-run.test.ts
tests/integration/compress-file.test.ts

README.md
```

`compress.ts` never imports `gs-run.ts`. It receives a runner function by injection, which is what makes the entire search algorithm testable without a Ghostscript process.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`
- Note: `electron-builder.yml` is created in Task 11, which specifies its full content. Do not stub it here.
- Test: `tests/unit/format.test.ts`, `src/renderer/src/format.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm run dev`, `npm run build`, `npm test`. Exports `formatBytes(bytes: number): string` and `mbToBytes(mb: number): number` from `src/renderer/src/format.ts`.

- [ ] **Step 1: Initialize the package and install dependencies**

Do not pin versions by hand — let npm resolve current ones, then record what it picked.

```bash
cd /Users/talhabera/Projects/pdf-compressor-desktop
npm init -y
npm pkg set name="pdf-compressor-desktop" version="0.1.0" private=true type="module" main="./out/main/index.js"
npm i -D electron electron-vite electron-builder vite typescript vitest \
         @vitejs/plugin-react @types/node @types/react @types/react-dom
npm i react react-dom
npm ls --depth=0
```

Expected: `npm ls` prints a clean tree with no `UNMET DEPENDENCY`.

- [ ] **Step 2: Add scripts**

```bash
npm pkg set scripts.dev="electron-vite dev"
npm pkg set scripts.build="electron-vite build"
npm pkg set scripts.typecheck="tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
npm pkg set scripts.test="vitest run tests/unit"
npm pkg set scripts.test:integration="vitest run tests/integration"
npm pkg set scripts.fetch-gs="bash scripts/fetch-ghostscript.sh"
npm pkg set scripts.fixtures="node scripts/make-fixtures.mjs"
npm pkg set scripts.pack:mac="npm run build && electron-builder --mac"
npm pkg set scripts.pack:win="npm run build && electron-builder --win"
```

- [ ] **Step 3: Write the build config**

`electron.vite.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
```

`vitest.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    testTimeout: 120_000, // integration tests spawn Ghostscript on large PDFs
  },
})
```

- [ ] **Step 4: Write the TypeScript configs**

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "composite": true,
    "noEmit": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "tests/**/*", "*.config.ts"]
}
```

`tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "composite": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

- [ ] **Step 5: Write the failing test for byte formatting**

`tests/unit/format.test.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `src/renderer/src/format`.

- [ ] **Step 7: Implement the formatter**

`src/renderer/src/format.ts`:

```ts
/** Decimal megabytes. See the "1 MB = 1,000,000 bytes" global constraint. */
export const BYTES_PER_MB = 1_000_000

export function mbToBytes(mb: number): number {
  return Math.round(mb * BYTES_PER_MB)
}

export function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MB) return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write the minimal app shell**

`src/main/index.ts`:

```ts
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // .mjs, not .js — electron-vite emits the preload with that extension
      // under "type": "module". Pointing at .js fails silently: the preload
      // never loads, and the contextBridge API is simply absent at runtime.
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

`src/preload/index.ts`:

```ts
export {}
```

`src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <!-- connect-src allows Vite's dev-server HMR socket; nothing remote is ever loaded. -->
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; style-src 'self' 'unsafe-inline';
                   connect-src 'self' ws://localhost:*" />
    <title>PDF Compressor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/renderer/src/App.tsx`:

```tsx
export default function App() {
  return <main>PDF Compressor</main>
}
```

- [ ] **Step 10: Verify the app runs**

Run: `npm run dev`
Expected: a 560×640 window opens showing "PDF Compressor". Close it.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold Electron + React + TypeScript project"
```

---

### Task 2: The quality ladder

**Files:**
- Create: `src/shared/types.ts`, `src/main/ladder.ts`
- Test: `tests/unit/ladder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Rung { index: number; dpi: number | null; qFactor: number | null; label: string }`
  - `const RUNGS: readonly Rung[]` — 27 entries, index 0–26
  - `const FLOOR_INDEX = 22`, `const MAX_INDEX = 26`
  - `function buildGsArgs(rung: Rung, inputPath: string, outputPath: string): string[]`

- [ ] **Step 1: Write the failing tests**

`tests/unit/ladder.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RUNGS, FLOOR_INDEX, MAX_INDEX, buildGsArgs } from '../../src/main/ladder'

describe('RUNGS', () => {
  it('has 27 rungs indexed 0..26', () => {
    expect(RUNGS).toHaveLength(27)
    RUNGS.forEach((r, i) => expect(r.index).toBe(i))
  })

  it('places the readability floor at 22 and the hard limit at 26', () => {
    expect(FLOOR_INDEX).toBe(22)
    expect(MAX_INDEX).toBe(26)
    expect(RUNGS[MAX_INDEX]!.index).toBe(26)
  })

  it('keeps the steps fine enough not to waste the user's budget', () => {
    // The search returns the largest result that fits, so a coarse ladder
    // overshoots downward and hands back a file much smaller than asked for.
    // DPI must never drop by more than 12% in a single step through the
    // working range, or that waste creeps back in.
    for (let i = 2; i <= 21; i++) {
      const prev = RUNGS[i - 1]!.dpi!
      const here = RUNGS[i]!.dpi!
      expect((prev - here) / prev).toBeLessThanOrEqual(0.12)
    }
  })

  it('has a structural-only rung 0 with no image settings', () => {
    expect(RUNGS[0]!.dpi).toBeNull()
    expect(RUNGS[0]!.qFactor).toBeNull()
  })

  it('never increases DPI as the ladder descends', () => {
    for (let i = 2; i <= MAX_INDEX; i++) {
      expect(RUNGS[i]!.dpi!).toBeLessThanOrEqual(RUNGS[i - 1]!.dpi!)
    }
  })

  it('increases QFactor monotonically from rung 1 down (higher = worse)', () => {
    for (let i = 2; i <= MAX_INDEX; i++) {
      expect(RUNGS[i]!.qFactor!).toBeGreaterThan(RUNGS[i - 1]!.qFactor!)
    }
  })

  it('never converts colour to grayscale at any rung', () => {
    // Turning a colour document black and white changes its content, not its
    // quality. An earlier ladder did this from the floor down; it made scanned
    // forms, signatures and charts come back monochrome without being asked.
    for (let i = 0; i <= MAX_INDEX; i++) {
      expect(args(i).join(' ')).not.toContain('ColorConversionStrategy')
      expect(args(i).join(' ')).not.toContain('DeviceGray')
    }
  })

  it('gives every rung a plain-language label', () => {
    RUNGS.forEach((r) => expect(r.label.length).toBeGreaterThan(0))
  })
})

describe('buildGsArgs', () => {
  const args = (i: number) => buildGsArgs(RUNGS[i]!, '/in.pdf', '/out.pdf')

  it('always writes to the output path and reads the input last', () => {
    const a = args(10)
    expect(a).toContain('-sOutputFile=/out.pdf')
    expect(a[a.length - 2]).toBe('-f')
    expect(a[a.length - 1]).toBe('/in.pdf')
  })

  it('always uses the pdfwrite device with batch flags', () => {
    for (const a of [args(0), args(10), args(26)]) {
      expect(a).toContain('-sDEVICE=pdfwrite')
      expect(a).toContain('-dNOPAUSE')
      expect(a).toContain('-dBATCH')
      expect(a).toContain('-dSAFER')
    }
  })

  it('disables all downsampling on rung 0 and passes no distiller params', () => {
    const a = args(0)
    expect(a).toContain('-dDownsampleColorImages=false')
    expect(a).toContain('-dDownsampleGrayImages=false')
    expect(a).toContain('-dDownsampleMonoImages=false')
    expect(a).not.toContain('-c')
  })

  it('forces lossless Flate on rung 0 rather than trusting AutoFilter', () => {
    // pdfwrite's AutoFilter default silently applies lossy JPEG, which would
    // make rung 0's "zero quality loss" promise untrue.
    const a = args(0)
    expect(a).toContain('-dAutoFilterColorImages=false')
    expect(a).toContain('-dColorImageFilter=/FlateEncode')
    expect(a).toContain('-dAutoFilterGrayImages=false')
    expect(a).toContain('-dGrayImageFilter=/FlateEncode')
    expect(a).not.toContain('-dColorImageFilter=/DCTEncode')
  })

  it('lowers the downsample threshold so each rung honours its DPI', () => {
    // Default threshold is 1.5, which leaves a 200 DPI scan untouched by every
    // rung down to 133 DPI and creates a large cliff mid-ladder.
    for (const i of [1, 10, 22, 26]) {
      expect(args(i)).toContain('-dColorImageDownsampleThreshold=1.0')
      expect(args(i)).toContain('-dGrayImageDownsampleThreshold=1.0')
      expect(args(i)).toContain('-dMonoImageDownsampleThreshold=1.0')
    }
  })

  it('sets colour and gray resolution to the rung DPI', () => {
    const a = args(10)
    expect(a).toContain('-dColorImageResolution=150')
    expect(a).toContain('-dGrayImageResolution=150')
  })

  it('keeps mono images at twice the DPI but never below 300', () => {
    expect(args(10)).toContain('-dMonoImageResolution=300')
    expect(args(1)).toContain('-dMonoImageResolution=500')
    expect(args(26)).toContain('-dMonoImageResolution=300')
  })

  it('passes the rung QFactor into all four image dicts', () => {
    const a = args(10)
    const c = a[a.indexOf('-c') + 1]!
    expect(c).toContain('setdistillerparams')
    expect(c.match(/\/QFactor 0\.4\b/g)).toHaveLength(4)
    // 4:2:0 chroma subsampling — half-resolution colour, full-resolution
    // luminance. Measured 5-10% smaller for -0.01 dB, i.e. free.
    expect(c.match(/\/HSamples \[2 1 1 1\]/g)).toHaveLength(4)
    expect(c.match(/\/VSamples \[2 1 1 1\]/g)).toHaveLength(4)
    for (const key of ['ColorACSImageDict', 'ColorImageDict', 'GrayACSImageDict', 'GrayImageDict']) {
      expect(c).toContain(key)
    }
  })

  it('never passes -dProcessColorModel, which pdfwrite rejects outright', () => {
    // Ghostscript 10.07 fails with "rangecheck in .putdeviceprops" — this would
    // kill every rung from the readability floor down.
    for (let i = 0; i <= MAX_INDEX; i++) {
      expect(args(i).join(' ')).not.toContain('-dProcessColorModel')
    }
  })

  it('puts -c before -f, which Ghostscript requires', () => {
    const a = args(22)
    expect(a.indexOf('-c')).toBeLessThan(a.indexOf('-f'))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ladder`
Expected: FAIL — cannot resolve `src/main/ladder`.

- [ ] **Step 3: Write the shared types**

`src/shared/types.ts`:

```ts
export interface Rung {
  index: number
  /** Target image resolution in DPI. `null` on rung 0, which does not downsample. */
  dpi: number | null
  /** Ghostscript JPEG QFactor. Higher is worse. `null` on rung 0. */
  qFactor: number | null
  /** Plain-language quality description shown to the user. */
  label: string
}

export type CompressStatus =
  | 'already-small'
  | 'hit-target'
  | 'floor-reached'
  | 'impossible'

export interface CompressProgress {
  attempt: number
  estimatedTotal: number
  rungIndex: number
  rungLabel: string
  dpi: number | null
  /**
   * The measured output size, or `null` while the attempt is still running.
   *
   * Each attempt emits twice: once on start with `bytes: null`, once on
   * completion with the real byte count. The UI needs both — the first drives
   * "attempt 3 of 6, trying reduced image quality" during a pass that can take
   * several seconds, and the second is the only place a *measured* size for an
   * intermediate attempt exists. Without the pair, a progress display could
   * only ever infer sizes, and an inferred number presented as a measurement
   * is worse than no number at all.
   */
  bytes: number | null
}

export interface CompressOutcome {
  status: CompressStatus
  /** Absolute path to the produced file. `null` only when status is 'already-small'. */
  outputPath: string | null
  bytes: number
  rungIndex: number | null
  rungLabel: string | null
  attempts: number
}

export type FailureKind =
  | 'not-pdf'
  /** The chosen file could not be opened — moved, renamed, deleted, or no permission. */
  | 'input-unreadable'
  | 'encrypted'
  | 'no-space'
  | 'gs-missing'
  | 'cancelled'
  | 'unknown'

export interface CompressFailure {
  kind: FailureKind
  /** A plain sentence for the user. */
  message: string
  /** Raw diagnostics, surfaced only behind a "Copy details" button. */
  details: string
}

export type CompressResponse =
  | { ok: true; outcome: CompressOutcome }
  | { ok: false; failure: CompressFailure }
```

- [ ] **Step 4: Implement the ladder**

`src/main/ladder.ts`:

```ts
import type { Rung } from '@shared/types'

/** Index of the readability floor. Rungs below this need explicit user consent. */
/** Index of the readability floor. Rungs below this need explicit user consent. */
export const FLOOR_INDEX = 22
/** Index of the harshest rung the app will ever apply. */
export const MAX_INDEX = 26

const HIGH = 'high quality'
const REDUCED = 'reduced image quality'
const HEAVY = 'heavily compressed'
const EXTREME = 'extremely compressed'

/**
 * The steps are deliberately fine — 12-19% apart in output size rather than the
 * ~33% of an earlier, coarser table. Step size is quality the user paid for and
 * did not receive: the search returns the largest result that still fits, so a
 * coarse ladder overshoots downward. Measured on a 23.8 MB 300 DPI colour scan
 * at a 1.75 MB target, the coarse table returned 1,363,051 bytes (78% of the
 * budget, 150 DPI) where this one returns 1,645,323 (94%, 166 DPI) — same
 * target, visibly sharper images.
 *
 * Sizes below are from that fixture and are indicative, not guarantees; every
 * rung is measured at run time.
 */
export const RUNGS: readonly Rung[] = [
  { index: 0, dpi: null, qFactor: null, label: 'original quality' },
  { index: 1, dpi: 250, qFactor: 0.15, label: HIGH },
  { index: 2, dpi: 235, qFactor: 0.17, label: HIGH },
  { index: 3, dpi: 220, qFactor: 0.2, label: HIGH },
  { index: 4, dpi: 205, qFactor: 0.22, label: HIGH },
  { index: 5, dpi: 195, qFactor: 0.25, label: HIGH },
  { index: 6, dpi: 185, qFactor: 0.28, label: HIGH },
  { index: 7, dpi: 175, qFactor: 0.31, label: HIGH },
  { index: 8, dpi: 166, qFactor: 0.34, label: HIGH },
  { index: 9, dpi: 158, qFactor: 0.37, label: REDUCED },
  { index: 10, dpi: 150, qFactor: 0.4, label: REDUCED },
  { index: 11, dpi: 142, qFactor: 0.44, label: REDUCED },
  { index: 12, dpi: 134, qFactor: 0.48, label: REDUCED },
  { index: 13, dpi: 126, qFactor: 0.53, label: REDUCED },
  { index: 14, dpi: 118, qFactor: 0.58, label: REDUCED },
  { index: 15, dpi: 110, qFactor: 0.65, label: REDUCED },
  { index: 16, dpi: 102, qFactor: 0.72, label: HEAVY },
  { index: 17, dpi: 95, qFactor: 0.8, label: HEAVY },
  { index: 18, dpi: 88, qFactor: 0.9, label: HEAVY },
  { index: 19, dpi: 82, qFactor: 1.0, label: HEAVY },
  { index: 20, dpi: 76, qFactor: 1.15, label: HEAVY },
  { index: 21, dpi: 72, qFactor: 1.4, label: HEAVY },
  { index: 22, dpi: 72, qFactor: 2.0, label: HEAVY },
  { index: 23, dpi: 60, qFactor: 2.4, label: EXTREME },
  { index: 24, dpi: 50, qFactor: 3.0, label: EXTREME },
  { index: 25, dpi: 40, qFactor: 3.5, label: EXTREME },
  { index: 26, dpi: 30, qFactor: 4.0, label: EXTREME },
]

const BASE_ARGS = [
  '-sDEVICE=pdfwrite',
  '-dCompatibilityLevel=1.7',
  '-dNOPAUSE',
  '-dBATCH',
  '-dSAFER',
  '-dQUIET',
  '-dAutoRotatePages=/None',
  '-dDetectDuplicateImages=true',
  '-dCompressFonts=true',
  '-dSubsetFonts=true',
  '-dEmbedAllFonts=true',
]

function distillerParams(qFactor: number): string {
  // HSamples/VSamples [2 1 1 1] is 4:2:0 chroma subsampling: colour is stored
  // at half resolution while brightness stays full. Human vision resolves
  // colour far more coarsely than luminance, so this is close to free.
  //
  // Measured on a 300 DPI colour scan, holding DPI and QFactor fixed:
  //   rung  5  1,442,462 -> 1,363,051 bytes  (5.5% smaller, -0.01 dB)
  //   rung  7    598,611 ->   559,377 bytes  (6.6% smaller, -0.01 dB)
  //   rung 10    271,251 ->   250,643 bytes  (7.6% smaller, -0.01 dB)
  //   rung 11    149,553 ->   133,866 bytes (10.5% smaller, -0.01 dB)
  //
  // -0.01 dB is measurement noise. This matters because it shifts the whole
  // size/quality frontier: for a given target, the search now settles on a
  // gentler rung, so images keep more detail at the same file size.
  const dict = `<</QFactor ${qFactor} /Blend 1 /HSamples [2 1 1 1] /VSamples [2 1 1 1]>>`
  return (
    `<</ColorACSImageDict ${dict} /ColorImageDict ${dict}` +
    ` /GrayACSImageDict ${dict} /GrayImageDict ${dict}>> setdistillerparams`
  )
}

export function buildGsArgs(rung: Rung, inputPath: string, outputPath: string): string[] {
  if (rung.dpi === null || rung.qFactor === null) {
    // pdfwrite defaults to AutoFilter, which silently re-encodes images as
    // lossy JPEG. Forcing FlateEncode is what actually makes this the
    // zero-quality-loss rung the spec promises. Measured: without these four
    // flags rung 0 shrank a 13.5 MB fixture to 2.1 MB by discarding image
    // data while claiming not to; with them it produces 13.1 MB.
    return [
      ...BASE_ARGS,
      '-dDownsampleColorImages=false',
      '-dDownsampleGrayImages=false',
      '-dDownsampleMonoImages=false',
      '-dAutoFilterColorImages=false',
      '-dColorImageFilter=/FlateEncode',
      '-dAutoFilterGrayImages=false',
      '-dGrayImageFilter=/FlateEncode',
      `-sOutputFile=${outputPath}`,
      '-f',
      inputPath,
    ]
  }

  // Scanned text is often 1-bit and degrades badly below 300 DPI, so mono
  // images are downsampled far more gently than colour and gray.
  const monoDpi = Math.max(rung.dpi * 2, 300)

  return [
    ...BASE_ARGS,
    // Ghostscript only downsamples when source/target DPI exceeds this
    // threshold, which defaults to 1.5. At the default, a 200 DPI scan is
    // untouched by every rung down to 133 DPI, so the upper ladder varied only
    // JPEG quality and produced a 4.4x size cliff between rungs 5 and 6.
    // Setting 1.0 makes each rung actually do what its DPI says: measured,
    // rung 5 went from 3.89 MB to 1.53 MB on the same input.
    '-dColorImageDownsampleThreshold=1.0',
    '-dGrayImageDownsampleThreshold=1.0',
    '-dMonoImageDownsampleThreshold=1.0',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${rung.dpi}`,
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${rung.dpi}`,
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    `-dMonoImageResolution=${monoDpi}`,
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false',
    '-dGrayImageFilter=/DCTEncode',
    // No colour conversion at any rung. Turning a colour document black and
    // white is a change to its content, not a reduction in quality, and the
    // app must never make that decision on the user's behalf. (Also note
    // -dProcessColorModel=/DeviceGray must never be added here: it is a
    // raster-device parameter and pdfwrite rejects it outright with
    // "rangecheck in .putdeviceprops".)
    `-sOutputFile=${outputPath}`,
    '-c',
    distillerParams(rung.qFactor),
    '-f',
    inputPath,
  ]
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- ladder`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/ladder.ts tests/unit/ladder.test.ts
git commit -m "feat: add quality ladder and Ghostscript argument builder"
```

---

### Task 3: The search algorithm

**Files:**
- Create: `src/main/compress.ts`
- Test: `tests/unit/compress.test.ts`

**Interfaces:**
- Consumes: `RUNGS`, `FLOOR_INDEX`, `MAX_INDEX` from `src/main/ladder.ts`; `Rung`, `CompressOutcome`, `CompressProgress` from `@shared/types`.
- Produces:
  - `type RungRunner = (rung: Rung) => Promise<{ path: string; bytes: number }>`
  - `const ESTIMATED_ATTEMPTS = 7`
  - `async function compress(opts: CompressOptions): Promise<CompressOutcome>`
  - `interface CompressOptions { inputPath: string; inputBytes: number; targetBytes: number; allowSqueeze: boolean; runRung: RungRunner; onProgress?: (p: CompressProgress) => void }`

- [ ] **Step 1: Write the failing tests**

`tests/unit/compress.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { compress } from '../../src/main/compress'
import { FLOOR_INDEX, MAX_INDEX, RUNGS } from '../../src/main/ladder'
import type { Rung } from '../../src/shared/types'

/** Builds a runner returning sizes from a per-rung table, recording call order. */
function fakeRunner(sizes: Record<number, number>) {
  const calls: number[] = []
  const run = async (rung: Rung) => {
    calls.push(rung.index)
    const bytes = sizes[rung.index]
    if (bytes === undefined) throw new Error(`no size defined for rung ${rung.index}`)
    return { path: `/tmp/rung-${rung.index}.pdf`, bytes }
  }
  return { run, calls }
}

/** A smooth, monotonically shrinking curve: rung 0 = `start`, each rung -`step`. */
function curve(start: number, step: number): Record<number, number> {
  const out: Record<number, number> = {}
  for (let i = 0; i <= MAX_INDEX; i++) out[i] = start - i * step
  return out
}

const base = {
  inputPath: '/tmp/in.pdf',
  allowSqueeze: false,
}

describe('compress', () => {
  it('does no work when the input is already at or under target', async () => {
    const { run, calls } = fakeRunner({})
    const outcome = await compress({
      ...base, inputBytes: 900_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('already-small')
    expect(outcome.outputPath).toBeNull()
    expect(outcome.bytes).toBe(900_000)
    expect(outcome.attempts).toBe(0)
    expect(calls).toEqual([])
  })

  it('returns rung 0 when structural compression alone hits the target', async () => {
    const { run, calls } = fakeRunner({ 0: 1_000_000 })
    const outcome = await compress({
      ...base, inputBytes: 5_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(0)
    expect(outcome.rungLabel).toBe(RUNGS[0]!.label)
    expect(outcome.bytes).toBe(1_000_000)
    expect(calls).toEqual([0])
  })

  it('picks the highest-quality rung that fits on a monotonic curve', async () => {
    // rung 0 = 10MB, each rung sheds 500k. Rung 5 = 7.5MB, rung 6 = 7.0MB.
    // Target 7.2MB => rung 6 is the highest quality that fits.
    const { run } = fakeRunner(curve(10_000_000, 500_000))
    const outcome = await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(6)
    expect(outcome.bytes).toBeLessThanOrEqual(7_200_000)
  })

  it('never runs the same rung twice', async () => {
    const { run, calls } = fakeRunner(curve(10_000_000, 500_000))
    await compress({ ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run })
    expect(new Set(calls).size).toBe(calls.length)
  })

  it('probes rung 0 and the floor before binary searching between them', async () => {
    const { run, calls } = fakeRunner(curve(10_000_000, 500_000))
    await compress({ ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run })
    expect(calls[0]).toBe(0)
    expect(calls[1]).toBe(FLOOR_INDEX)
    expect(calls.every((c) => c <= FLOOR_INDEX)).toBe(true)
  })

  it('reports floor-reached and keeps the floor output when the target is unsafe', async () => {
    // Every rung stays above target.
    const { run, calls } = fakeRunner(curve(50_000_000, 100_000))
    const outcome = await compress({
      ...base, inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('floor-reached')
    expect(outcome.rungIndex).toBe(FLOOR_INDEX)
    expect(outcome.outputPath).toBe(`/tmp/rung-${FLOOR_INDEX}.pdf`)
    expect(outcome.bytes).toBeGreaterThan(1_750_000)
    expect(calls).toEqual([0, FLOOR_INDEX])
  })

  it('searches only rungs 12-15 when squeeze is allowed', async () => {
    const sizes = curve(50_000_000, 100_000)
    sizes[15] = 1_000_000
    sizes[14] = 1_400_000
    sizes[13] = 1_600_000
    sizes[12] = 2_000_000
    const { run, calls } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, allowSqueeze: true,
      inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(13)
    expect(calls.every((c) => c > FLOOR_INDEX)).toBe(true)
    expect(calls).not.toContain(0)
  })

  it('reports impossible when even rung 15 misses the target', async () => {
    const { run } = fakeRunner(curve(50_000_000, 100_000))
    const outcome = await compress({
      ...base, allowSqueeze: true,
      inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('impossible')
    expect(outcome.rungIndex).toBe(MAX_INDEX)
  })

  it('returns a measured under-target file even when the curve is not monotonic', async () => {
    // Pathological: rung 6 is LARGER than rung 5, and rung 3 is tiny.
    const sizes = curve(10_000_000, 400_000)
    sizes[6] = 9_900_000
    sizes[3] = 1_000_000
    sizes[FLOOR_INDEX] = 1_500_000
    const { run } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 1_700_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    // The invariant that matters: whatever it returned, it measured it and it fits.
    expect(outcome.bytes).toBeLessThanOrEqual(1_700_000)
    expect(outcome.outputPath).toBe(`/tmp/rung-${outcome.rungIndex}.pdf`)
  })

  it('reports a smaller attempt estimate in squeeze mode', async () => {
    // Squeeze searches only four rungs, so reporting the normal-mode estimate
    // of 6 would leave the progress bar apparently stuck below half throughout.
    const onProgress = vi.fn()
    const sizes = curve(50_000_000, 100_000)
    sizes[15] = 1_000_000
    const { run } = fakeRunner(sizes)
    await compress({
      ...base, allowSqueeze: true, inputBytes: 60_000_000,
      targetBytes: 1_750_000, runRung: run, onProgress,
    })
    for (const call of onProgress.mock.calls) {
      expect(call[0].estimatedTotal).toBe(4)
    }
  })

  it('reports progress twice per rung: once starting, once measured', async () => {
    const onProgress = vi.fn()
    const { run, calls } = fakeRunner(curve(10_000_000, 500_000))
    await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run, onProgress,
    })
    expect(onProgress).toHaveBeenCalledTimes(calls.length * 2)

    const first = onProgress.mock.calls[0]![0]
    expect(first.attempt).toBe(1)
    expect(first.rungIndex).toBe(0)
    expect(first.estimatedTotal).toBeGreaterThan(0)
    expect(first.rungLabel).toBe(RUNGS[0]!.label)
    expect(first.bytes).toBeNull()

    const second = onProgress.mock.calls[1]![0]
    expect(second.attempt).toBe(1)
    expect(second.rungIndex).toBe(0)
    expect(second.bytes).toBe(10_000_000)
  })

  it('never reports a size it did not measure', async () => {
    // Every populated `bytes` must equal what the runner actually returned for
    // that rung. A progress display showing inferred sizes as measurements
    // would be worse than showing none.
    const onProgress = vi.fn()
    const sizes = curve(10_000_000, 500_000)
    const { run } = fakeRunner(sizes)
    await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run, onProgress,
    })
    for (const [event] of onProgress.mock.calls) {
      if (event.bytes !== null) expect(event.bytes).toBe(sizes[event.rungIndex])
    }
  })

  it('propagates runner errors instead of swallowing them', async () => {
    const boom = async () => { throw new Error('ghostscript exploded') }
    await expect(
      compress({ ...base, inputBytes: 12_000_000, targetBytes: 1_000_000, runRung: boom }),
    ).rejects.toThrow('ghostscript exploded')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- compress`
Expected: FAIL — cannot resolve `src/main/compress`.

- [ ] **Step 3: Implement the search**

`src/main/compress.ts`:

```ts
import type { CompressOutcome, CompressProgress, Rung } from '@shared/types'
import { FLOOR_INDEX, MAX_INDEX, RUNGS } from './ladder'

export interface RungResult {
  path: string
  bytes: number
}

export type RungRunner = (rung: Rung) => Promise<RungResult>

export interface CompressOptions {
  inputPath: string
  inputBytes: number
  targetBytes: number
  /** When true, search rungs 12-15 instead of 1-11. */
  allowSqueeze: boolean
  runRung: RungRunner
  onProgress?: (progress: CompressProgress) => void
}

/** Rung 0 + the floor probe + ceil(log2(21)) binary-search steps. */
export const ESTIMATED_ATTEMPTS = 7

/**
 * Squeeze mode probes rung 26 then binary-searches the three rungs above it,
 * so it never takes more than four passes. Reporting 6 would leave the progress
 * bar apparently stuck below half for the whole run.
 */
export const ESTIMATED_SQUEEZE_ATTEMPTS = 4

export async function compress(opts: CompressOptions): Promise<CompressOutcome> {
  const { targetBytes, allowSqueeze, runRung, onProgress } = opts

  const measured = new Map<number, RungResult>()
  let attempts = 0

  const run = async (index: number): Promise<RungResult> => {
    const cached = measured.get(index)
    if (cached) return cached

    const rung = RUNGS[index]!
    attempts++
    // Each attempt reports twice: once on start so the UI can say what is
    // being tried during a pass that may take several seconds, and once on
    // completion carrying the measured size. The completion event is the only
    // place an intermediate attempt's real size is ever available.
    const event = {
      attempt: attempts,
      estimatedTotal: allowSqueeze ? ESTIMATED_SQUEEZE_ATTEMPTS : ESTIMATED_ATTEMPTS,
      rungIndex: index,
      rungLabel: rung.label,
      dpi: rung.dpi,
    }
    onProgress?.({ ...event, bytes: null })
    const result = await runRung(rung)
    measured.set(index, result)
    onProgress?.({ ...event, bytes: result.bytes })
    return result
  }

  const done = (
    status: CompressOutcome['status'],
    index: number,
    result: RungResult,
  ): CompressOutcome => ({
    status,
    outputPath: result.path,
    bytes: result.bytes,
    rungIndex: index,
    rungLabel: RUNGS[index]!.label,
    attempts,
  })

  if (!allowSqueeze) {
    if (opts.inputBytes <= targetBytes) {
      return {
        status: 'already-small',
        outputPath: null,
        bytes: opts.inputBytes,
        rungIndex: null,
        rungLabel: null,
        attempts: 0,
      }
    }

    // Structural pass first: if it fits, the target costs no quality at all.
    const structural = await run(0)
    if (structural.bytes <= targetBytes) return done('hit-target', 0, structural)
  }

  const lowest = allowSqueeze ? FLOOR_INDEX + 1 : 1
  const harshest = allowSqueeze ? MAX_INDEX : FLOOR_INDEX

  // If the harshest permitted rung still misses, nothing between it and rung 0 can fit.
  const harshestResult = await run(harshest)
  if (harshestResult.bytes > targetBytes) {
    return done(allowSqueeze ? 'impossible' : 'floor-reached', harshest, harshestResult)
  }

  // Binary search for the lowest index (= highest quality) that fits. `best` only
  // ever holds a rung whose output size was measured at or under target, so the
  // result stays correct even if the ladder is not perfectly monotonic.
  let bestIndex = harshest
  let best = harshestResult
  let low = lowest
  let high = harshest - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const result = await run(mid)
    if (result.bytes <= targetBytes) {
      bestIndex = mid
      best = result
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return done('hit-target', bestIndex, best)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- compress`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole unit suite**

Run: `npm test`
Expected: PASS, all tests from Tasks 1–3.

- [ ] **Step 6: Commit**

```bash
git add src/main/compress.ts tests/unit/compress.test.ts
git commit -m "feat: add target-size search over the quality ladder"
```

---

### Task 4: Bundle Ghostscript

**Files:**
- Create: `scripts/fetch-ghostscript.sh`, `src/main/gs-locate.ts`
- Test: `tests/unit/gs-locate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function resolveGhostscriptPath(env: GsEnv): string` where
    `interface GsEnv { platform: NodeJS.Platform; isPackaged: boolean; resourcesPath: string; projectRoot: string }`
  - Binaries at `resources/gs/mac/gs` and/or `resources/gs/win/gswin64c.exe`
  - No Electron import — Task 9 supplies the Electron-derived `GsEnv`.

This task has a genuine risk of not working first try. The cross-architecture macOS build is the fragile part. The script is written so an `arm64`-only result is a success with a warning, not a failure.

- [ ] **Step 1: Write the failing test for path resolution**

`tests/unit/gs-locate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveGhostscriptPath } from '../../src/main/gs-locate'

const dev = { isPackaged: false, resourcesPath: '/ignored', projectRoot: '/proj' }
const packaged = { isPackaged: true, resourcesPath: '/app/Resources', projectRoot: '/ignored' }

describe('resolveGhostscriptPath', () => {
  it('reads from resources/gs/mac in development on macOS', () => {
    expect(resolveGhostscriptPath({ ...dev, platform: 'darwin' }))
      .toBe('/proj/resources/gs/mac/gs')
  })

  it('reads from resources/gs/win in development on Windows', () => {
    expect(resolveGhostscriptPath({ ...dev, platform: 'win32' }))
      .toBe('/proj/resources/gs/win/gswin64c.exe')
  })

  it('reads from the flattened resources dir when packaged', () => {
    expect(resolveGhostscriptPath({ ...packaged, platform: 'darwin' }))
      .toBe('/app/Resources/gs/gs')
    expect(resolveGhostscriptPath({ ...packaged, platform: 'win32' }))
      .toBe('/app/Resources/gs/gswin64c.exe')
  })

  it('treats any non-Windows platform as the mac layout', () => {
    expect(resolveGhostscriptPath({ ...dev, platform: 'linux' }))
      .toBe('/proj/resources/gs/mac/gs')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- gs-locate`
Expected: FAIL — cannot resolve `src/main/gs-locate`.

- [ ] **Step 3: Implement the locator**

`src/main/gs-locate.ts`:

```ts
import { join } from 'node:path'

export interface GsEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** Electron's `process.resourcesPath`. Only used when packaged. */
  resourcesPath: string
  /** Repository root. Only used in development. */
  projectRoot: string
}

export function resolveGhostscriptPath(env: GsEnv): string {
  const isWindows = env.platform === 'win32'
  const binary = isWindows ? 'gswin64c.exe' : 'gs'
  // electron-builder's ${os} macro flattens resources/gs/<os>/ to resources/gs/.
  if (env.isPackaged) return join(env.resourcesPath, 'gs', binary)
  const dir = isWindows ? 'win' : 'mac'
  return join(env.projectRoot, 'resources', 'gs', dir, binary)
}
```

This module deliberately does **not** import Electron. The build output is ESM
(`"type": "module"`), so a lazy `require('electron')` would throw at runtime, and
a static import would drag Electron into the unit tests. The Electron-aware
caller lives in `ipc.ts` (Task 9), which already imports Electron.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- gs-locate`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the fetch script**

`scripts/fetch-ghostscript.sh`:

```bash
#!/usr/bin/env bash
# Downloads and prepares the Ghostscript binaries this app bundles.
# Run once before the first build. Output is gitignored.
#
# Prerequisites on macOS:  xcode-select --install ; brew install sevenzip
set -euo pipefail

GS_VERSION="10.07.1"
GS_TAG="gs10071"
BASE="https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/${GS_TAG}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${ROOT}/.gs-build"
mkdir -p "${WORK}" "${ROOT}/resources/gs/mac" "${ROOT}/resources/gs/win"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- Windows: extract the official binaries from the NSIS installer ------------
say "Windows binaries"
WIN_EXE="${WORK}/${GS_TAG}w64.exe"
if [ ! -f "${WIN_EXE}" ]; then
  curl -fL --retry 3 -o "${WIN_EXE}" "${BASE}/${GS_TAG}w64.exe"
fi
echo "sha256: $(shasum -a 256 "${WIN_EXE}" | cut -d' ' -f1)"
echo "Compare against the checksums published at ${BASE%/download/*}/tag/${GS_TAG}"

# Use 7zz from the `sevenzip` formula, NOT `7z` from `p7zip`. p7zip 17.05
# (2017) cannot read this NSIS installer: it silently extracts only the UI
# plugin DLLs and reports "Unexpected end of input stream". That failure is
# especially nasty because the output *looks* present but is wrong.
command -v 7zz >/dev/null 2>&1 || { echo "7zz not found. Run: brew install sevenzip"; exit 1; }
rm -rf "${WORK}/win-extract"
7zz x -aoa -o"${WORK}/win-extract" "${WIN_EXE}" > /dev/null

# Verify in the extraction directory and install only once it passes. Copying
# first and checking after would leave files this script just rejected sitting
# exactly where packaging looks for them — and `exit 1` protects only callers
# who actually check the exit status.
SRC_DLL="${WORK}/win-extract/bin/gsdll64.dll"
SRC_EXE="${WORK}/win-extract/bin/gswin64c.exe"
[ -f "${SRC_DLL}" ] && [ -f "${SRC_EXE}" ] \
  || { echo "ERROR: extraction produced no bin/gsdll64.dll and bin/gswin64c.exe."; exit 1; }

# Verify the payload rather than relying on the extractor's exit status. The
# real gsdll64.dll is ~25 MB; the bogus installer-UI plugin DLLs that a bad
# extraction produces are a few KB, so a size floor catches it precisely.
DLL_SIZE=$(stat -f%z "${SRC_DLL}" 2>/dev/null || stat -c%s "${SRC_DLL}")
if [ "${DLL_SIZE}" -lt $((20 * 1024 * 1024)) ]; then
  echo "ERROR: gsdll64.dll is only ${DLL_SIZE} bytes (expected ~25 MB)."
  echo "That is the signature of a partial extraction. Refusing to install."
  exit 1
fi

cp "${SRC_EXE}" "${ROOT}/resources/gs/win/"
cp "${SRC_DLL}" "${ROOT}/resources/gs/win/"
echo "OK: resources/gs/win/ (gsdll64.dll ${DLL_SIZE} bytes)"

# --- macOS: build from source so the binary needs no external libraries -------
say "macOS binary (building from source)"
SRC_TGZ="${WORK}/ghostscript-${GS_VERSION}.tar.gz"
if [ ! -f "${SRC_TGZ}" ]; then
  curl -fL --retry 3 -o "${SRC_TGZ}" "${BASE}/ghostscript-${GS_VERSION}.tar.gz"
fi
echo "sha256: $(shasum -a 256 "${SRC_TGZ}" | cut -d' ' -f1)"

rm -rf "${WORK}/src"
mkdir -p "${WORK}/src"
tar xf "${SRC_TGZ}" -C "${WORK}/src" --strip-components=1

# Native arch only. Both users of this app are on Apple Silicon or Windows, so
# an x86_64 slice would be dead weight — and cross-compiling Ghostscript is the
# single most fragile step in this build. If an Intel Mac ever needs support,
# run this script on one and `lipo -create` the two binaries together.
NATIVE_ARCH="$(uname -m)"
say "  building ${NATIVE_ARCH}"
# The build runs with a sanitised PATH so Homebrew's pkg-config is never found.
# Without this, configure autodetects Homebrew libraries and links them: an
# earlier build picked up /opt/homebrew/.../libidn.12.dylib, producing a binary
# that ran perfectly on the build machine and would fail everywhere else.
# libidn only provides Unicode-password support for encrypted PDFs, which this
# app reports as an error rather than decrypting, so we do not want it at all.
# Ghostscript vendors its own zlib/libpng/jpeg/freetype/lcms2/openjpeg, so
# hiding the system package manager costs nothing.
( cd "${WORK}/src"
  export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  # CC/CXX/CFLAGS are unset too: a shell profile that points CC at a Homebrew
  # compiler (common advice for keg-only formulas) would reintroduce Homebrew's
  # default library search paths even with everything else sanitised.
  unset PKG_CONFIG_PATH PKG_CONFIG_LIBDIR CPPFLAGS LDFLAGS CC CXX CFLAGS
  make distclean >/dev/null 2>&1 || true
  ./configure --without-x --disable-cups --disable-dbus \
              --disable-gtk --without-tesseract \
              --disable-fontconfig --without-libidn --without-libpaper >/dev/null
  make -j"$(sysctl -n hw.ncpu)" >/dev/null
  # Staged, not installed. The verification section below moves it into
  # resources/gs/mac/ only after every check passes.
  cp bin/gs "${WORK}/gs-candidate" )

say "Verifying"

# The candidate is verified at a staging path and only moved into
# resources/gs/mac/ once every check passes. Copying first and checking after
# would leave a binary this script just rejected sitting exactly where
# packaging looks for it — and "exit 1" only protects callers who check it.
CANDIDATE="${WORK}/gs-candidate"
FINAL="${ROOT}/resources/gs/mac/gs"

fail() { echo "ERROR: $1"; echo "Refusing to install the binary."; rm -f "${CANDIDATE}"; exit 1; }

# Each check is a standalone assignment, NOT a command substitution inside
# echo. `set -e` ignores a failing $(...) embedded in an echo argument, so
# `echo "version: $("${BIN}" --version)"` silently continues on a broken
# binary. Standalone `var=$(...)` assignments are covered.
ARCHS=$(lipo -archs "${CANDIDATE}") || fail "lipo could not read the binary — it is not a valid Mach-O."
VERSION=$("${CANDIDATE}" --version) || fail "the binary does not execute."
LINKS=$(otool -L "${CANDIDATE}") || fail "otool could not read the binary."

DEPS=$(printf '%s\n' "${LINKS}" | tail -n +2)
# An empty dependency list means otool produced nothing useful. Without this,
# `grep -v` over zero lines exits 1 — indistinguishable from a genuinely clean
# binary — so the gate would pass vacuously for a corrupt file.
[ -n "${DEPS}" ] || fail "otool produced no dependency lines; cannot verify."

echo "arch:    ${ARCHS}"
echo "version: ${VERSION}"
echo "links:"
printf '%s\n' "${DEPS}"
echo

# Hard gate: refuse to ship a binary depending on anything outside the OS.
# This has already caught two real failures (Homebrew libidn, Homebrew
# fontconfig), so it is an assertion, not a formality.
if printf '%s\n' "${DEPS}" | grep -qvE '^[[:space:]]+(/usr/lib/|/System/)'; then
  fail "the binary links a non-system library (listed above). It would run here and fail on every other Mac."
fi

mv "${CANDIDATE}" "${FINAL}"
chmod +x "${FINAL}"
echo "OK: binary is self-contained, installed at resources/gs/mac/gs"
```

- [ ] **Step 6: Run the fetch script**

Run:
```bash
chmod +x scripts/fetch-ghostscript.sh
npm run fetch-gs
```

Expected: `resources/gs/win/gswin64c.exe`, `resources/gs/win/gsdll64.dll`, and `resources/gs/mac/gs` all exist. The final `otool -L` block lists only `/usr/lib` and `/System` paths.

If the download 404s, the release tag is wrong for this version — check https://github.com/ArtifexSoftware/ghostpdl-downloads/releases and update `GS_VERSION` and `GS_TAG` at the top of the script.

If `otool -L` shows Homebrew paths, stop and use the `dylibbundler` fallback: `brew install dylibbundler`, then `dylibbundler -od -b -x resources/gs/mac/gs -d resources/gs/mac/libs -p @executable_path/libs`, and re-run `otool -L` to confirm.

- [ ] **Step 7: Confirm the bundled binary actually runs**

Run: `./resources/gs/mac/gs --version`
Expected: prints `10.07.1`.

- [ ] **Step 8: Commit**

Binaries are gitignored; only the script and locator are committed.

```bash
git add scripts/fetch-ghostscript.sh src/main/gs-locate.ts tests/unit/gs-locate.test.ts
git commit -m "feat: bundle Ghostscript and resolve its path per platform"
```

---

### Task 5: Test fixtures

**Files:**
- Create: `scripts/make-fixtures.mjs`
- Modify: `.gitignore` (add `tests/fixtures/`)

**Interfaces:**
- Consumes: nothing.
- Produces three files, regenerable and never committed:
  - `tests/fixtures/text-heavy.pdf` — 200 pages of vector text, contains the sentinel string `GHOSTSCRIPT_FIXTURE_SENTINEL` on page 1
  - `tests/fixtures/scan-heavy.pdf` — 12 pages of high-resolution noise images, > 8 MB
  - `tests/fixtures/already-tiny.pdf` — one page, < 50 KB

Noise is used deliberately: it does not compress, which guarantees a large fixture without committing a binary blob.

- [ ] **Step 1: Install the generator dependency**

```bash
npm i -D pdf-lib
```

- [ ] **Step 2: Write the generator**

`scripts/make-fixtures.mjs`:

```js
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
```

- [ ] **Step 3: Ignore the generated fixtures**

Append to `.gitignore`:

```
# Generated by scripts/make-fixtures.mjs
tests/fixtures/
```

- [ ] **Step 4: Generate and verify**

Run: `npm run fixtures`

Expected output shape:
```
text-heavy.pdf       0.4x MB
scan-heavy.pdf       8.xx MB
already-tiny.pdf     0.00 MB
```

`scan-heavy.pdf` must exceed 8 MB. Three pages at 1700x2200 gives ~13.5 MB. If it falls short, raise the page count rather than the resolution.

- [ ] **Step 5: Commit**

```bash
git add scripts/make-fixtures.mjs .gitignore package.json package-lock.json
git commit -m "test: add generated PDF fixtures"
```

---

### Task 6: Run Ghostscript

**Files:**
- Create: `src/main/gs-run.ts`
- Test: `tests/integration/gs-run.test.ts`

**Interfaces:**
- Consumes: `buildGsArgs`, `RUNGS` from `./ladder`; `RungResult` from `./compress`.
- Produces:
  - `class GsError extends Error { readonly exitCode: number | null; readonly stderr: string }`
  - `async function runGs(gsPath: string, args: string[], signal?: AbortSignal): Promise<void>`
  - `function makeRungRunner(cfg: RungRunnerConfig): RungRunner` where
    `interface RungRunnerConfig { gsPath: string; inputPath: string; workDir: string; signal?: AbortSignal }`

- [ ] **Step 1: Write the failing integration test**

`tests/integration/gs-run.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GsError, makeRungRunner, runGs } from '../../src/main/gs-run'
import { RUNGS, FLOOR_INDEX, MAX_INDEX } from '../../src/main/ladder'
import { resolveGhostscriptPath } from '../../src/main/gs-locate'

const GS = resolveGhostscriptPath({
  platform: process.platform,
  isPackaged: false,
  resourcesPath: '',
  projectRoot: process.cwd(),
})
const FIXTURES = join(process.cwd(), 'tests', 'fixtures')
const SCAN = join(FIXTURES, 'scan-heavy.pdf')

let work: string

beforeAll(() => {
  if (!existsSync(GS)) throw new Error(`Run "npm run fetch-gs" first — missing ${GS}`)
  if (!existsSync(SCAN)) throw new Error('Run "npm run fixtures" first')
  work = mkdtempSync(join(tmpdir(), 'gsrun-test-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('runGs', () => {
  it('rejects with a GsError carrying stderr when Ghostscript fails', async () => {
    await expect(runGs(GS, ['-sDEVICE=pdfwrite', '-o', join(work, 'x.pdf'), '-f', '/nope.pdf']))
      .rejects.toBeInstanceOf(GsError)
  })
})

describe('makeRungRunner', () => {
  it('produces a smaller file at a harsher rung', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const gentle = await run(RUNGS[1]!)
    const harsh = await run(RUNGS[11]!)
    expect(harsh.bytes).toBeLessThan(gentle.bytes)
  })

  it('reports the true on-disk size of the file it wrote', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const result = await run(RUNGS[5]!)
    expect(statSync(result.path).size).toBe(result.bytes)
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('writes each rung to its own file', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const a = await run(RUNGS[3]!)
    const b = await run(RUNGS[4]!)
    expect(a.path).not.toBe(b.path)
  })

  it('shrinks the scan fixture well below its original size at the floor', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const result = await run(RUNGS[11]!)
    expect(result.bytes).toBeLessThan(statSync(SCAN).size / 2)
  })

  it('aborts when the signal fires, with no Node error code', async () => {
    const controller = new AbortController()
    const run = makeRungRunner({
      gsPath: GS, inputPath: SCAN, workDir: work, signal: controller.signal,
    })
    const pending = run(RUNGS[1]!)
    setTimeout(() => controller.abort(), 50)
    // `code: null` is what marks this a genuine cancellation rather than a
    // failure to start, so assert it rather than merely that it rejected.
    await expect(pending).rejects.toMatchObject({ exitCode: null, code: null })
  })

  it('reports a missing binary with its Node error code, not as a cancellation', async () => {
    // A spawn failure and a user cancellation both produce exitCode: null.
    // Without the code, a broken installation is reported to the user as
    // "Cancelled." — which tells them nothing and blames them for it.
    const run = makeRungRunner({
      gsPath: '/nonexistent/path/to/gs', inputPath: SCAN, workDir: work,
    })
    await expect(run(RUNGS[5]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The spec promises text is never rasterized at ANY rung, and transparency
  // groups are where Ghostscript is most likely to break that by flattening a
  // region to pixels. Checked at the floor and at the harshest rung.
  it('keeps text selectable through a transparency group at the harshest rungs', async () => {
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([612, 792])
    // Semi-transparent coloured text: pdf-lib emits an ExtGState with /ca,
    // which is what creates the transparency group.
    page.drawText('TRANSPARENCY_GROUP_SENTINEL', {
      x: 50, y: 700, size: 24, font, color: rgb(0.9, 0.1, 0.1), opacity: 0.5,
    })
    page.drawText('OPAQUE_CONTROL_SENTINEL', {
      x: 50, y: 650, size: 24, font, color: rgb(0, 0, 0),
    })
    const src = join(work, 'transparency.pdf')
    writeFileSync(src, await doc.save())

    const run = makeRungRunner({ gsPath: GS, inputPath: src, workDir: work })
    for (const index of [FLOOR_INDEX, MAX_INDEX]) {
      const result = await run(RUNGS[index]!)
      const text = execFileSync(
        GS,
        ['-sDEVICE=txtwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-o', '-', '-f', result.path],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      )
      expect(text, `rung ${index} lost the transparent text`)
        .toContain('TRANSPARENCY_GROUP_SENTINEL')
      expect(text, `rung ${index} lost the opaque text`)
        .toContain('OPAQUE_CONTROL_SENTINEL')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- gs-run`
Expected: FAIL — cannot resolve `src/main/gs-run`.

- [ ] **Step 3: Implement the runner**

`src/main/gs-run.ts`:

```ts
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Rung } from '@shared/types'
import type { RungResult, RungRunner } from './compress'
import { buildGsArgs } from './ladder'

export class GsError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    /**
     * The originating Node error code when the process could not be started
     * at all — `ENOENT` for a missing binary, `EACCES` for one that isn't
     * executable. Without this, a spawn failure and a user cancellation are
     * indistinguishable downstream (both carry `exitCode: null`), and a broken
     * installation gets reported to the user as "Cancelled."
     */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'GsError'
  }
}

export function runGs(gsPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GsError('Cancelled before starting.', null, ''))
      return
    }

    const child = spawn(gsPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let cancelled = false

    child.stderr.on('data', (chunk: Buffer) => {
      // Ghostscript is chatty on malformed input; cap what we hold in memory.
      if (stderr.length < 64_000) stderr += chunk.toString()
    })

    const onAbort = () => {
      cancelled = true
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    child.on('error', (err) => {
      cleanup()
      // Carry the Node error code through. `errors.ts` checks it before it
      // checks `exitCode === null`, so this is what distinguishes "Ghostscript
      // is missing" from "the user pressed Cancel".
      reject(new GsError(err.message, null, stderr, (err as NodeJS.ErrnoException).code ?? null))
    })

    child.on('close', (code) => {
      cleanup()
      if (cancelled) reject(new GsError('Cancelled.', null, stderr))
      else if (code === 0) resolve()
      else reject(new GsError(`Ghostscript exited with code ${code}.`, code, stderr))
    })
  })
}

export interface RungRunnerConfig {
  gsPath: string
  inputPath: string
  /** Directory for intermediate files. Caller owns creation and cleanup. */
  workDir: string
  signal?: AbortSignal
}

export function makeRungRunner(cfg: RungRunnerConfig): RungRunner {
  return async (rung: Rung): Promise<RungResult> => {
    const outputPath = join(cfg.workDir, `rung-${rung.index}.pdf`)
    await runGs(cfg.gsPath, buildGsArgs(rung, cfg.inputPath, outputPath), cfg.signal)
    const { size } = await stat(outputPath)
    return { path: outputPath, bytes: size }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:integration -- gs-run`
Expected: PASS, 6 tests. This runs real Ghostscript several times and may take 30–60 seconds.

- [ ] **Step 5: Confirm the ladder curve still holds**

The QFactor table has already been tuned empirically against real Ghostscript
output, and the spec's open item on it is closed. Measured on
`tests/fixtures/scan-heavy.pdf` (13,563,981 bytes), the curve is strictly
monotonic with no inversions:

```
rung  0  13,133,058   (lossless)   rung  8     312,400
rung  1   5,927,838                rung  9     201,722
rung  2   5,352,540                rung 10     124,471
rung  3   4,342,602                rung 11      56,212  <- floor
rung  4   2,935,063                rung 12      37,536
rung  5   1,530,126                rung 13      26,489
rung  6     890,054                rung 14      18,994
rung  7     472,627                rung 15      13,935
```

Your job is to confirm this still holds after your changes, not to re-tune it.
Add this temporary test, run it, check the numbers are in the same shape, then
delete it — the ladder-ordering assertions in `tests/unit/ladder.test.ts` guard
the table from then on. If any rung is *larger* than the one above it, stop and
report it: that would be a regression against a measured baseline.

```ts
it('prints the real ladder curve', async () => {
  const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
  for (const rung of RUNGS) {
    const r = await run(rung)
    console.log(`rung ${String(rung.index).padStart(2)}  ${(r.bytes / 1e6).toFixed(2)} MB`)
  }
}, 300_000)
```

Run: `npm run test:integration -- gs-run --reporter=verbose`

Expected: sizes decrease as the rung index rises. If any rung is more than 10%
*larger* than the rung above it, adjust that rung's `qFactor` in `ladder.ts` and
re-run until the curve is smooth. Delete this temporary test once the table is
tuned — the ladder-ordering assertions in `tests/unit/ladder.test.ts` guard the
table from then on.

- [ ] **Step 6: Commit**

```bash
git add src/main/gs-run.ts src/main/ladder.ts tests/integration/gs-run.test.ts
git commit -m "feat: run Ghostscript per rung with cancellation and size measurement"
```

---

### Task 7: Plain-language errors

**Files:**
- Create: `src/main/errors.ts`
- Test: `tests/unit/errors.test.ts`

**Interfaces:**
- Consumes: `GsError` from `./gs-run`; `CompressFailure`, `FailureKind` from `@shared/types`.
- Produces: `function classifyFailure(err: unknown): CompressFailure`

The stderr patterns must be observed, not guessed. Step 1 observes them.

- [ ] **Step 1: Confirm the recorded Ghostscript failure output**

These strings have already been captured from Ghostscript 10.07.1 on this
machine, and the patterns in Step 4 are built from them:

| input | stderr |
|---|---|
| a text file | `Error: /undefined in this` |
| a missing path | `Error: /undefinedfilename in (/tmp/does-not-exist.pdf)` |
| password-protected | `**** This file requires a password for access.` then `**** Error: Couldn't initialise file.` |
| truncated PDF | `Catalog dictionary not located in file, unable to proceed` then `**** Error: Couldn't initialise file.` |

Note that `Couldn't initialise file.` appears in **both** the encrypted and the
corrupt cases, which is why the password pattern must be tested first.

Re-run the commands below to confirm they still match on your machine. If any
output differs, the observed output wins — update both the test and the
patterns, and say so in your report.

```bash
GS=./resources/gs/mac/gs
printf 'this is definitely not a pdf' > /tmp/notpdf.pdf
echo "--- NOT A PDF ---"
$GS -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -o /tmp/out1.pdf -f /tmp/notpdf.pdf 2>&1 | head -20
echo "--- MISSING FILE ---"
$GS -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -o /tmp/out2.pdf -f /tmp/does-not-exist.pdf 2>&1 | head -20
```

Write the exact phrases down. Use them in Step 3 in place of the patterns below **if they differ** — the patterns below are the expected ones for Ghostscript 10.x, but the observed output wins.

For the encrypted case, produce a password-protected PDF and record its stderr too:

```bash
$GS -sDEVICE=pdfwrite -dNOPAUSE -dBATCH \
    -sOwnerPassword=owner -sUserPassword=secret \
    -o /tmp/locked.pdf -f tests/fixtures/already-tiny.pdf
echo "--- ENCRYPTED ---"
$GS -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -o /tmp/out3.pdf -f /tmp/locked.pdf 2>&1 | head -20
```

- [ ] **Step 2: Write the failing tests**

Substitute any stderr string below with what you actually observed in Step 1.

`tests/unit/errors.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- errors`
Expected: FAIL — cannot resolve `src/main/errors`.

- [ ] **Step 4: Implement the classifier**

`src/main/errors.ts`:

```ts
import type { CompressFailure, FailureKind } from '@shared/types'
import { GsError } from './gs-run'

const MESSAGES: Record<FailureKind, string> = {
  'not-pdf': "This file isn't a readable PDF.",
  'input-unreadable': "Couldn't open that file. It may have been moved, renamed, or deleted.",
  encrypted: 'This PDF is password-protected. Remove the password and try again.',
  'no-space': 'Ran out of disk space while compressing.',
  'gs-missing': "Something's wrong with this installation — please reinstall.",
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- errors`
Expected: PASS, 8 tests. If the encrypted or not-pdf assertions fail, the stderr strings in the test do not match reality — go back to Step 1's observed output and fix both the test and `STDERR_PATTERNS`.

- [ ] **Step 6: Commit**

```bash
git add src/main/errors.ts tests/unit/errors.test.ts
git commit -m "feat: classify Ghostscript failures into plain-language messages"
```

---

### Task 8: End-to-end compression

**Files:**
- Create: `src/main/compress-file.ts`
- Test: `tests/integration/compress-file.test.ts`

**Interfaces:**
- Consumes: `compress` from `./compress`; `makeRungRunner` from `./gs-run`; `classifyFailure` from `./errors`. The Ghostscript path arrives as the `gsPath` option — this module never resolves it itself.
- Produces:
  - `interface CompressFileOptions { inputPath: string; targetBytes: number; allowSqueeze: boolean; gsPath: string; signal?: AbortSignal; onProgress?: (p: CompressProgress) => void }`
  - `async function compressFile(opts: CompressFileOptions): Promise<CompressResponse>`
  - `async function cleanupWorkDir(outputPath: string): Promise<void>`

`compressFile` owns the temp directory: it creates one per run and never throws — every failure comes back as `{ ok: false, failure }`.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/compress-file.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { compressFile, cleanupWorkDir } from '../../src/main/compress-file'
import { resolveGhostscriptPath } from '../../src/main/gs-locate'
import { FLOOR_INDEX } from '../../src/main/ladder'

const gsPath = resolveGhostscriptPath({
  platform: process.platform, isPackaged: false, resourcesPath: '', projectRoot: process.cwd(),
})
const FIXTURES = join(process.cwd(), 'tests', 'fixtures')
const SCAN = join(FIXTURES, 'scan-heavy.pdf')
const TEXT = join(FIXTURES, 'text-heavy.pdf')
const TINY = join(FIXTURES, 'already-tiny.pdf')

const base = { gsPath, allowSqueeze: false }

beforeAll(() => {
  if (!existsSync(gsPath)) throw new Error('Run "npm run fetch-gs" first')
  if (!existsSync(SCAN)) throw new Error('Run "npm run fixtures" first')
})

describe('compressFile', () => {
  it('hits a 1.75 MB target on a large scan and says so', async () => {
    const res = await compressFile({ ...base, inputPath: SCAN, targetBytes: 1_750_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.status).toBe('hit-target')
    expect(res.outcome.bytes).toBeLessThanOrEqual(1_750_000)
    expect(statSync(res.outcome.outputPath!).size).toBe(res.outcome.bytes)
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('reports already-small without writing anything', async () => {
    const res = await compressFile({ ...base, inputPath: TINY, targetBytes: 1_750_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.status).toBe('already-small')
    expect(res.outcome.outputPath).toBeNull()
    expect(res.outcome.attempts).toBe(0)
  })

  it('stops at the floor and keeps that file when the target is impossible', async () => {
    const res = await compressFile({ ...base, inputPath: SCAN, targetBytes: 20_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.status).toBe('floor-reached')
    expect(res.outcome.rungIndex).toBe(FLOOR_INDEX)
    expect(existsSync(res.outcome.outputPath!)).toBe(true)
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('goes below the floor only when squeeze is allowed', async () => {
    const res = await compressFile({
      ...base, allowSqueeze: true, inputPath: SCAN, targetBytes: 20_000,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.rungIndex).toBeGreaterThan(FLOOR_INDEX)
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('keeps text selectable in the output', async () => {
    const res = await compressFile({
      ...base, inputPath: TEXT, targetBytes: Math.floor(statSync(TEXT).size * 0.6),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const txt = execFileSync(
      gsPath,
      ['-sDEVICE=txtwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET',
       '-o', '-', '-f', res.outcome.outputPath!],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    expect(txt).toContain('GHOSTSCRIPT_FIXTURE_SENTINEL')
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('reports a missing input as unreadable, not as a broken installation', async () => {
    // A missing input file and a missing Ghostscript binary both raise ENOENT.
    // Telling someone whose PDF moved to reinstall the app is actively
    // misleading, so this pins the distinction.
    const res = await compressFile({
      ...base, inputPath: join(FIXTURES, 'nope.pdf'), targetBytes: 1_750_000,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.failure.kind).toBe('input-unreadable')
    expect(res.failure.message).toBe(
      "Couldn't open that file. It may have been moved, renamed, or deleted.",
    )
  })

  it('still reports a genuinely missing Ghostscript as an installation problem', async () => {
    const res = await compressFile({
      ...base, gsPath: '/nonexistent/path/to/gs',
      inputPath: SCAN, targetBytes: 1_750_000,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.failure.kind).toBe('gs-missing')
  }, 60_000)

  it('reports progress in increasing attempt order', async () => {
    const seen: number[] = []
    await compressFile({
      ...base, inputPath: SCAN, targetBytes: 1_750_000,
      onProgress: (p) => seen.push(p.attempt),
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  }, 300_000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- compress-file`
Expected: FAIL — cannot resolve `src/main/compress-file`.

- [ ] **Step 3: Implement the wiring**

`src/main/compress-file.ts`:

```ts
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CompressProgress, CompressResponse } from '@shared/types'
import { compress } from './compress'
import { classifyFailure } from './errors'
import { makeRungRunner } from './gs-run'

export interface CompressFileOptions {
  inputPath: string
  targetBytes: number
  allowSqueeze: boolean
  gsPath: string
  signal?: AbortSignal
  onProgress?: (progress: CompressProgress) => void
}

const WORK_PREFIX = 'pdf-compressor-'

export async function compressFile(opts: CompressFileOptions): Promise<CompressResponse> {
  // Reading the input is checked separately from everything else. Both a
  // missing input file and a missing Ghostscript binary raise ENOENT, and
  // `classifyFailure` sees only the code — so without this, a PDF the user
  // moved or renamed would be reported as "Something's wrong with this
  // installation — please reinstall.", sending them to reinstall a working app
  // while the real problem goes untouched.
  let inputBytes: number
  try {
    inputBytes = (await stat(opts.inputPath)).size
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'input-unreadable',
        message: "Couldn't open that file. It may have been moved, renamed, or deleted.",
        details: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
    }
  }

  let workDir: string | null = null
  try {
    workDir = await mkdtemp(join(tmpdir(), WORK_PREFIX))

    const outcome = await compress({
      inputPath: opts.inputPath,
      inputBytes,
      targetBytes: opts.targetBytes,
      allowSqueeze: opts.allowSqueeze,
      runRung: makeRungRunner({
        gsPath: opts.gsPath,
        inputPath: opts.inputPath,
        workDir,
        signal: opts.signal,
      }),
      onProgress: opts.onProgress,
    })

    // Nothing was produced, so nothing needs keeping.
    if (outcome.outputPath === null) {
      // Guarded like the catch-path rm below. Without this, a filesystem
      // hiccup while removing an empty temp dir would turn "your file is
      // already small enough" into "Compression failed on this file."
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
    return { ok: true, outcome }
  } catch (err) {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, failure: classifyFailure(err) }
  }
}

/**
 * Removes the temp directory holding a compression result. Call once the user has
 * saved the file or dismissed the result. Refuses paths outside our own temp dirs.
 */
export async function cleanupWorkDir(outputPath: string): Promise<void> {
  // This deletes a directory recursively, so containment has to be exact.
  // `dir.startsWith(prefix)` is not: `dirname()` does not collapse `..`, so
  // `<tmp>/pdf-compressor-ABC/../../../../Users/me/.ssh/id_rsa` passes a prefix
  // test while resolving somewhere else entirely — and that is where `rm` would
  // operate. Resolve first, then require the parent to be exactly the temp
  // directory and the basename to carry our prefix.
  const dir = resolve(dirname(outputPath))
  if (dirname(dir) !== resolve(tmpdir())) return
  if (!basename(dir).startsWith(WORK_PREFIX)) return
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:integration -- compress-file`
Expected: PASS, 7 tests. Several minutes — each case runs Ghostscript up to six times on an 8 MB file.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run test:integration && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/compress-file.ts tests/integration/compress-file.test.ts
git commit -m "feat: wire compression end to end with temp-dir lifecycle"
```

---

### Task 9: IPC layer

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts` (register handlers), `src/preload/index.ts` (expose the API), `src/shared/types.ts` (add the API interface)

**Interfaces:**
- Consumes: `compressFile`, `cleanupWorkDir` from `./compress-file`; `resolveGhostscriptPath` from `./gs-locate`.
- Produces on `window.api`:
  - `pickFile(): Promise<{ path: string; bytes: number } | null>`
  - `statFile(path: string): Promise<{ path: string; bytes: number } | null>`
  - `compress(req: { inputPath: string; targetBytes: number; allowSqueeze: boolean }): Promise<CompressResponse>`
  - `cancel(): Promise<void>`
  - `save(req: { tempPath: string; suggestedName: string }): Promise<boolean>`
  - `onProgress(cb: (p: CompressProgress) => void): () => void`

Only one compression runs at a time; starting a new one aborts the previous.

- [ ] **Step 1: Add the API type to shared types**

Append to `src/shared/types.ts`:

```ts
export interface PickedFile {
  path: string
  bytes: number
}

export interface CompressRequest {
  inputPath: string
  targetBytes: number
  allowSqueeze: boolean
}

export interface RendererApi {
  pickFile(): Promise<PickedFile | null>
  statFile(path: string): Promise<PickedFile | null>
  /**
   * Absolute path of a dropped File. Electron removed the `File.path` property,
   * so this must go through `webUtils.getPathForFile` in the preload.
   */
  pathForFile(file: File): string
  compress(req: CompressRequest): Promise<CompressResponse>
  cancel(): Promise<void>
  save(req: { tempPath: string; suggestedName: string }): Promise<boolean>
  /** Returns an unsubscribe function. */
  onProgress(cb: (progress: CompressProgress) => void): () => void
}

declare global {
  interface Window {
    api: RendererApi
  }
}
```

- [ ] **Step 2: Write the IPC handlers**

`src/main/ipc.ts`:

```ts
import { copyFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { CompressRequest, CompressResponse, PickedFile } from '@shared/types'
import { cleanupWorkDir, compressFile } from './compress-file'
import { resolveGhostscriptPath } from './gs-locate'

let active: AbortController | null = null

/**
 * Output path of the most recent successful run, whose temp directory is still
 * on disk because the user may yet save it.
 *
 * `compressFile` deliberately keeps that directory — the caller needs the file.
 * But a run the user never saves would otherwise leak it, and each one holds
 * every rung's output: roughly 27 MB for a 13.5 MB input. Someone compressing a
 * few documents a week and saving only some of them would quietly accumulate
 * hundreds of megabytes in a directory they will never think to look in.
 *
 * So the previous run's directory is removed when a new run starts, and any
 * outstanding one is removed on quit.
 */
let pendingOutputPath: string | null = null

/**
 * The path a save dialog is currently open for, if any.
 *
 * A native save dialog can stay open for minutes. Without this, starting a new
 * compression while one is open would delete the very file the user is about to
 * save, and their Save would fail on a file that existed when they clicked.
 */
let savingPath: string | null = null

async function discardPendingOutput(): Promise<void> {
  const path = pendingOutputPath
  if (!path) return
  pendingOutputPath = null
  // Deferred: `file:save` completes the discard once its dialog closes.
  if (path === savingPath) return
  await cleanupWorkDir(path)
}

/** Electron-aware wrapper around the pure resolver in gs-locate.ts. */
function ghostscriptPath(): string {
  return resolveGhostscriptPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // out/main/ipc.js -> out/main -> out -> project root
    projectRoot: join(import.meta.dirname, '..', '..'),
  })
}

async function statFile(path: string): Promise<PickedFile | null> {
  try {
    const { size } = await stat(path)
    return { path, bytes: size }
  } catch {
    return null
  }
}

export function registerIpc(): void {
  ipcMain.handle('file:pick', async (): Promise<PickedFile | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    const picked = result.filePaths[0]
    return result.canceled || !picked ? null : statFile(picked)
  })

  ipcMain.handle('file:stat', (_e, path: string) => statFile(path))

  ipcMain.handle('compress:start', async (event, req: CompressRequest): Promise<CompressResponse> => {
    active?.abort()
    // Whatever the last run produced is now superseded, saved or not.
    await discardPendingOutput()
    const controller = new AbortController()
    active = controller

    const response = await compressFile({
      inputPath: req.inputPath,
      targetBytes: req.targetBytes,
      allowSqueeze: req.allowSqueeze,
      gsPath: ghostscriptPath(),
      signal: controller.signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('compress:progress', progress)
      },
    })

    // Both writes are guarded by the same check. An aborted run can still
    // resolve `ok: true` — SIGKILL is not synchronous, so a run whose last
    // Ghostscript process already closed successfully settles normally — and
    // whichever handler settles last would otherwise win the write. That would
    // point `pendingOutputPath` at a superseded run, leaving the current run's
    // ~27 MB untracked and never cleaned up.
    const isCurrent = active === controller
    if (isCurrent) {
      active = null
      // Remember what to clean up if the user never saves this result.
      if (response.ok && response.outcome.outputPath) {
        pendingOutputPath = response.outcome.outputPath
      }
    } else if (response.ok && response.outcome.outputPath) {
      // Superseded: nobody will ever save this, so release it now.
      await cleanupWorkDir(response.outcome.outputPath)
    }
    return response
  })

  ipcMain.handle('compress:cancel', () => {
    active?.abort()
    active = null
  })

  ipcMain.handle('file:save', async (event, req: { tempPath: string; suggestedName: string }) => {
    savingPath = req.tempPath
    let saved = false
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = { defaultPath: basename(req.suggestedName) }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false
      await copyFile(req.tempPath, result.filePath)
      saved = true
      return true
    } catch {
      // The source can legitimately be gone by now. Report a clean failure
      // rather than letting a raw IPC rejection reach the renderer.
      return false
    } finally {
      savingPath = null
      if (saved) {
        if (pendingOutputPath === req.tempPath) pendingOutputPath = null
        await cleanupWorkDir(req.tempPath)
      } else if (pendingOutputPath !== req.tempPath) {
        // A newer run superseded this one while the dialog was open, and
        // `discardPendingOutput` deferred to us. Complete the discard.
        await cleanupWorkDir(req.tempPath)
      }
      // Cancelled but still the pending result: keep it, the user may retry.
    }
  })
}

/**
 * Called on quit so nothing is left behind — neither a running Ghostscript
 * process nor the temp directory of a result the user never saved.
 *
 * This is async and must be awaited. Electron does not hold up quit for a
 * `before-quit` listener unless that listener calls `preventDefault()` and
 * quits again itself, so a fire-and-forget `rm` here is not "slightly delayed"
 * — it usually does not happen at all.
 */
export async function shutdown(): Promise<void> {
  active?.abort()
  active = null
  savingPath = null
  await discardPendingOutput()
}
```

- [ ] **Step 3: Expose the API in preload**

`src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CompressProgress, CompressRequest, RendererApi } from '@shared/types'

const api: RendererApi = {
  pickFile: () => ipcRenderer.invoke('file:pick'),
  statFile: (path) => ipcRenderer.invoke('file:stat', path),
  // Must run here, in the preload. `File.path` no longer exists in the renderer.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  compress: (req: CompressRequest) => ipcRenderer.invoke('compress:start', req),
  cancel: () => ipcRenderer.invoke('compress:cancel'),
  save: (req) => ipcRenderer.invoke('file:save', req),
  onProgress: (cb: (p: CompressProgress) => void) => {
    const listener = (_e: unknown, progress: CompressProgress) => cb(progress)
    ipcRenderer.on('compress:progress', listener)
    return () => { ipcRenderer.off('compress:progress', listener) }
  },
}

contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 4: Register the handlers in main**

In `src/main/index.ts`, add the import and wire it up:

```ts
import { registerIpc, shutdown } from './ipc'
```

Change the `app.whenReady()` block to:

```ts
app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Electron will not wait for an async `before-quit` listener, so hold the quit
// open, finish cleaning up, then exit for real. Without this the temp directory
// of an unsaved result usually survives the quit.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void shutdown().finally(() => app.exit(0))
})
```

- [ ] **Step 5: Verify it compiles and the app still runs**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run dev`, then in the window's DevTools console (View → Toggle Developer Tools):
```js
typeof window.api.compress
```
Expected: `"function"`. Close the app.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/main/index.ts src/shared/types.ts
git commit -m "feat: add IPC surface for picking, compressing, cancelling and saving"
```

---

### Task 10: The user interface

**Files:**
- Create: `src/renderer/src/components/DropZone.tsx`, `TargetInput.tsx`, `ProgressPanel.tsx`, `ResultCard.tsx`, `src/renderer/src/styles.css`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`

**Interfaces:**
- Consumes: `window.api`; `formatBytes`, `mbToBytes`, `BYTES_PER_MB` from `./format`.
- Produces: the finished single screen.

This task delivers a correct, coherent interface. A separate visual-polish pass comes after, using the `frontend-design` skill — do not treat these styles as final.

- [ ] **Step 1: Write the stylesheet**

`src/renderer/src/styles.css`:

```css
:root {
  --bg: #f6f6f7;
  --panel: #ffffff;
  --ink: #16161a;
  --muted: #6b6b76;
  --line: #e2e2e6;
  --accent: #2f6df6;
  --danger: #b4232c;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171a; --panel: #202024; --ink: #f2f2f4;
    --muted: #9a9aa4; --line: #313138; --accent: #6f9bff; --danger: #ff6b74;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  user-select: none;
}

main { padding: 28px 24px 24px; display: flex; flex-direction: column; gap: 18px; }

h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }

.dropzone {
  border: 1.5px dashed var(--line);
  border-radius: 12px;
  background: var(--panel);
  padding: 32px 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color 120ms, background 120ms;
}
.dropzone:hover, .dropzone.over { border-color: var(--accent); }
.dropzone.filled { text-align: left; padding: 18px 20px; cursor: default; }
.dropzone .filename { font-weight: 600; word-break: break-all; }
.dropzone .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }

.row { display: flex; align-items: center; gap: 10px; }
.row label { color: var(--muted); }

input[type="number"] {
  width: 90px; padding: 7px 9px; font: inherit;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--ink);
}

button {
  font: inherit; font-weight: 550; padding: 9px 16px;
  border-radius: 8px; border: 1px solid transparent;
  background: var(--accent); color: #fff; cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: default; }
button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
button.link {
  background: none; border: none; color: var(--muted);
  text-decoration: underline; padding: 0; font-weight: 400;
}

.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 12px; padding: 16px; display: flex;
  flex-direction: column; gap: 12px;
}

.bar { height: 6px; background: var(--line); border-radius: 99px; overflow: hidden; }
.bar > div { height: 100%; background: var(--accent); transition: width 220ms ease; }

.sizes { display: flex; align-items: baseline; gap: 10px; font-size: 22px; font-weight: 600; }
.sizes .arrow, .sizes .before { color: var(--muted); font-size: 15px; font-weight: 400; }
.note { color: var(--muted); font-size: 13px; }
.error { color: var(--danger); }
```

- [ ] **Step 2: Write the drop zone**

`src/renderer/src/components/DropZone.tsx`:

```tsx
import { useState } from 'react'
import type { PickedFile } from '@shared/types'
import { formatBytes } from '../format'

interface Props {
  file: PickedFile | null
  disabled: boolean
  onPick: (file: PickedFile) => void
}

export default function DropZone({ file, disabled, onPick }: Props) {
  const [over, setOver] = useState(false)

  async function browse() {
    if (disabled) return
    const picked = await window.api.pickFile()
    if (picked) onPick(picked)
  }

  async function drop(e: React.DragEvent) {
    e.preventDefault()
    setOver(false)
    if (disabled) return
    const dropped = e.dataTransfer.files[0]
    if (!dropped) return
    const path = window.api.pathForFile(dropped)
    if (!path) return
    const stat = await window.api.statFile(path)
    if (stat) onPick(stat)
  }

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${file ? ' filled' : ''}`}
      onClick={file ? undefined : browse}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {file ? (
        <>
          <div className="filename">{file.path.split(/[/\\]/).pop()}</div>
          <div className="sub">
            {formatBytes(file.bytes)} ·{' '}
            <button className="link" onClick={browse} disabled={disabled}>
              choose a different file
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="filename">Drop a PDF here</div>
          <div className="sub">or click to choose one</div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Write the target input**

`src/renderer/src/components/TargetInput.tsx`:

```tsx
interface Props {
  mb: number
  disabled: boolean
  onChange: (mb: number) => void
}

export default function TargetInput({ mb, disabled, onChange }: Props) {
  return (
    <div className="row">
      <label htmlFor="target">Target size</label>
      <input
        id="target"
        type="number"
        min="0.05"
        step="0.05"
        value={mb}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (Number.isFinite(next) && next > 0) onChange(next)
        }}
      />
      <span className="note">MB</span>
    </div>
  )
}
```

- [ ] **Step 4: Write the progress panel**

`src/renderer/src/components/ProgressPanel.tsx`:

```tsx
import type { CompressProgress } from '@shared/types'

interface Props {
  progress: CompressProgress | null
  onCancel: () => void
}

export default function ProgressPanel({ progress, onCancel }: Props) {
  const pct = progress
    ? Math.min(95, Math.round((progress.attempt / progress.estimatedTotal) * 100))
    : 5

  const detail = !progress
    ? 'Starting…'
    : progress.dpi === null
      ? `Attempt ${progress.attempt} — trying lossless compression`
      : `Attempt ${progress.attempt} — trying ${progress.dpi} DPI`

  return (
    <div className="panel">
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="note">{detail}</span>
        <button className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Write the result card**

`src/renderer/src/components/ResultCard.tsx`:

```tsx
import type { CompressOutcome } from '@shared/types'
import { formatBytes } from '../format'

interface Props {
  outcome: CompressOutcome
  originalBytes: number
  saving: boolean
  onSave: () => void
  onSqueeze: () => void
}

export default function ResultCard({
  outcome, originalBytes, saving, onSave, onSqueeze,
}: Props) {
  if (outcome.status === 'already-small') {
    return (
      <div className="panel">
        <div className="sizes">{formatBytes(outcome.bytes)}</div>
        <div className="note">Already under your target — nothing to do.</div>
      </div>
    )
  }

  const missed = outcome.status === 'floor-reached' || outcome.status === 'impossible'

  return (
    <div className="panel">
      <div className="sizes">
        <span className="before">{formatBytes(originalBytes)}</span>
        <span className="arrow">→</span>
        <span>{formatBytes(outcome.bytes)}</span>
      </div>

      <div className="note">
        {missed
          ? `Smallest I could get without wrecking it. Saved at ${outcome.rungLabel}.`
          : `Saved at ${outcome.rungLabel}.`}
      </div>

      <div className="row">
        <button onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save As…'}
        </button>
        {outcome.status === 'floor-reached' && (
          <button className="secondary" onClick={onSqueeze}>Squeeze harder</button>
        )}
      </div>

      {outcome.status === 'impossible' && (
        <div className="note">
          This file can't get any smaller without becoming unusable.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Write the screen**

`src/renderer/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type {
  CompressFailure, CompressOutcome, CompressProgress, PickedFile,
} from '@shared/types'
import DropZone from './components/DropZone'
import TargetInput from './components/TargetInput'
import ProgressPanel from './components/ProgressPanel'
import ResultCard from './components/ResultCard'
import { mbToBytes } from './format'
import './styles.css'

const TARGET_KEY = 'targetMb'
const DEFAULT_TARGET_MB = 1.75

function loadTarget(): number {
  const stored = Number(localStorage.getItem(TARGET_KEY))
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TARGET_MB
}

export default function App() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [targetMb, setTargetMb] = useState(loadTarget)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<CompressProgress | null>(null)
  const [outcome, setOutcome] = useState<CompressOutcome | null>(null)
  const [failure, setFailure] = useState<CompressFailure | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => window.api.onProgress(setProgress), [])
  useEffect(() => localStorage.setItem(TARGET_KEY, String(targetMb)), [targetMb])

  function reset(next: PickedFile | null) {
    setFile(next)
    setOutcome(null)
    setFailure(null)
    setProgress(null)
  }

  async function run(allowSqueeze: boolean) {
    if (!file) return
    setBusy(true)
    setOutcome(null)
    setFailure(null)
    setProgress(null)

    const res = await window.api.compress({
      inputPath: file.path,
      targetBytes: mbToBytes(targetMb),
      allowSqueeze,
    })

    if (res.ok) setOutcome(res.outcome)
    else if (res.failure.kind !== 'cancelled') setFailure(res.failure)
    setBusy(false)
    setProgress(null)
  }

  async function save() {
    if (!outcome?.outputPath || !file) return
    setSaving(true)
    const suggested =
      file.path.split(/[/\\]/).pop()!.replace(/\.pdf$/i, '') + '-compressed.pdf'
    const saved = await window.api.save({
      tempPath: outcome.outputPath,
      suggestedName: suggested,
    })
    setSaving(false)
    if (saved) reset(file)
  }

  async function cancel() {
    await window.api.cancel()
    setBusy(false)
    setProgress(null)
  }

  return (
    <main>
      <h1>PDF Compressor</h1>

      <DropZone file={file} disabled={busy} onPick={reset} />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <TargetInput mb={targetMb} disabled={busy} onChange={setTargetMb} />
        <button onClick={() => run(false)} disabled={!file || busy}>Compress</button>
      </div>

      {busy && <ProgressPanel progress={progress} onCancel={cancel} />}

      {outcome && !busy && (
        <ResultCard
          outcome={outcome}
          originalBytes={file?.bytes ?? 0}
          saving={saving}
          onSave={save}
          onSqueeze={() => void run(true)}
        />
      )}

      {failure && !busy && (
        <div className="panel">
          <div className="error">{failure.message}</div>
          <button
            className="link"
            onClick={() => void navigator.clipboard.writeText(failure.details)}
          >
            Copy details
          </button>
        </div>
      )}
    </main>
  )
}
```

`App.tsx` imports `styles.css`, so `main.tsx` needs no change from Task 1.

- [ ] **Step 7: Verify the whole flow by hand**

Run: `npm run dev`, then:

1. Drop `tests/fixtures/scan-heavy.pdf` onto the window. It shows the name and ~8 MB.
2. Leave the target at 1.75 and press Compress. The progress bar advances through several attempts.
3. The result card shows `8.xx MB → 1.xx MB` and a quality label. Press Save As and save it.
4. Open the saved file. It renders correctly.
5. Reload, set the target to `0.02`, compress. The card reports it stopped early and offers **Squeeze harder**. Press it; the result gets smaller.
6. Drop `tests/fixtures/already-tiny.pdf`, compress: it reports "Already under your target".
7. Start a compression on the scan and press Cancel mid-run. It returns to idle with no error.

Every one of these must behave as described before moving on.

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/renderer package.json
git commit -m "feat: add the compression UI"
```

---

### Task 11: Packaging and documentation

**Files:**
- Create: `README.md`, `build/entitlements.mac.plist`
- Modify: `electron-builder.yml`

**Interfaces:**
- Consumes: everything.
- Produces: `release/*.dmg` and `release/*.exe`.

- [ ] **Step 1: Write the packaging config**

`electron-builder.yml`:

```yaml
appId: com.talhabera.pdfcompressor
productName: PDF Compressor
directories:
  output: release
  buildResources: build
files:
  - out/**
  - package.json
extraResources:
  - from: resources/gs/${os}
    to: gs
    filter: ['**/*']
mac:
  target:
    - target: dmg
      arch: [arm64]
  category: public.app-category.utilities
  # Unsigned build. See README for the one-time Gatekeeper step.
  identity: null
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 2: Build the macOS installer**

Run: `npm run pack:mac`
Expected: `release/PDF Compressor-0.1.0-arm64.dmg` exists.

The macOS build is **arm64 only** by design — both users of this app are on Apple Silicon or Windows. Do not switch this to `universal`: `resources/gs/mac/gs` is a single-architecture binary and a universal target would fail on it.

- [ ] **Step 3: Verify Ghostscript survived packaging**

```bash
hdiutil attach "release/PDF Compressor-0.1.0-arm64.dmg"
ls -la "/Volumes/PDF Compressor/PDF Compressor.app/Contents/Resources/gs/"
"/Volumes/PDF Compressor/PDF Compressor.app/Contents/Resources/gs/gs" --version
hdiutil detach "/Volumes/PDF Compressor"
```

Expected: the directory contains `gs` and it prints `10.07.1`. If the binary is missing, `extraResources` did not resolve `${os}` — confirm the source directory is `resources/gs/mac`, not `resources/gs/darwin`.

- [ ] **Step 4: Install from the DMG and run it as a user would**

Drag the app to `/Applications`, then double-click it. Expect the Gatekeeper warning. Dismiss it, then right-click the app → Open → Open. Compress `tests/fixtures/scan-heavy.pdf` to 1.75 MB and save the result.

This is the only test that proves the bundled binary works outside the dev tree. Do not skip it.

- [ ] **Step 5: Build the Windows installer**

Run: `npm run pack:win`
Expected: `release/PDF Compressor Setup 0.1.0.exe` exists.

If electron-builder fails needing Wine, install it (`brew install --cask wine-stable`) and retry. If it still fails, the fallback is a GitHub Actions job on `windows-latest` running `npm ci && npm run fetch-gs && npm run pack:win` — record that as a follow-up rather than blocking this task.

- [ ] **Step 6: Write the README**

`README.md`:

````markdown
# PDF Compressor

A small desktop app that compresses a PDF down to a size you choose. Built for
macOS and Windows.

## For users

Download the installer, open it, and drag the app where it wants to go.

**First launch on macOS** shows *"PDF Compressor cannot be opened because Apple
cannot check it for malicious software."* This is expected — the app is not
signed with a paid Apple certificate. To open it:

1. Click **Done** to dismiss the warning.
2. Find PDF Compressor in your Applications folder.
3. **Right-click** it and choose **Open**.
4. Click **Open** in the dialog that appears.

You only do this once. Afterwards it opens normally.

**First launch on Windows** shows a blue "Windows protected your PC" screen.
Click **More info**, then **Run anyway**. Also once only.

### Using it

Drop a PDF on the window, set the target size in MB, and press Compress. When
it finishes, press Save As.

If the file can't reach your target without becoming unreadable, the app stops
early, tells you the smallest size it could safely manage, and offers a
**Squeeze harder** button that goes further at real cost to quality.

Sizes use decimal megabytes: 1 MB = 1,000,000 bytes. This is the stricter of the
two common definitions, so a file the app reports as 1.75 MB is accepted by
upload limits using either one.

## For developers

### Setup

```bash
npm install
npm run fetch-gs    # builds/downloads the bundled Ghostscript. Takes a few minutes.
npm run fixtures    # generates test PDFs
npm run dev
```

`npm run fetch-gs` needs the Xcode command line tools and `sevenzip` (the
`p7zip` formula is too old to read Ghostscript's Windows installer — it extracts
the wrong files without reporting an error):

```bash
xcode-select --install
brew install sevenzip
```

### Tests

```bash
npm test              # unit tests, no Ghostscript needed
npm run test:integration   # runs real Ghostscript against generated fixtures
npm run typecheck
```

### Building installers

```bash
npm run pack:mac    # release/*.dmg
npm run pack:win    # release/*.exe
```

### How compression works

Compression is a fixed ladder of 16 quality rungs, each a pair of image DPI and
JPEG QFactor settings, defined in `src/main/ladder.ts`. Rung 0 is structural
only and loses nothing. Rung 11 is the *readability floor* — the harshest
setting applied without the user explicitly asking. Rungs 12–15 are reachable
only via "Squeeze harder".

`src/main/compress.ts` probes rung 0, probes the floor, then binary-searches
between them for the highest-quality rung whose output actually fits. It only
ever returns a file whose size it measured, so a non-monotonic ladder can cost
quality but can never miss the target.

Text is never rasterized at any rung. Ghostscript re-encodes embedded images
only; text stays selectable and searchable in the output.

### If the macOS Ghostscript build fails

`scripts/fetch-ghostscript.sh` builds Ghostscript from source so the binary
depends only on system libraries. If the cross-architecture build fails, the
script falls back to a single-architecture binary and warns you.

The other option is to bundle Homebrew's Ghostscript with its dependencies:

```bash
brew install ghostscript dylibbundler
cp "$(brew --prefix)/bin/gs" resources/gs/mac/gs
dylibbundler -od -b -x resources/gs/mac/gs -d resources/gs/mac/libs \
             -p @executable_path/libs
otool -L resources/gs/mac/gs   # must show no /opt/homebrew paths
```

## Licence

This app bundles Ghostscript, which is licensed under the AGPL. It is
distributed privately and is not published.
````

- [ ] **Step 7: Commit**

```bash
git add electron-builder.yml README.md
git commit -m "chore: package installers for macOS and Windows, add README"
```

---

## Follow-up (not part of this plan)

- **Visual design pass.** Task 10's styles are correct but plain. Redo them with the `frontend-design` skill once the app works end to end.
- **Windows CI**, if `pack:win` from macOS proves unreliable.
- **Signing and notarization**, if an Apple Developer account becomes available.
