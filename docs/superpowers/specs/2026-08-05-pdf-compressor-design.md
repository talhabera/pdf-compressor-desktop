# PDF Compressor Desktop — Design

**Date:** 2026-08-05
**Status:** Approved, ready for implementation planning

## Purpose

A desktop app for macOS and Windows that compresses a PDF down to a user-specified
target size, defaulting to 1.75 MB. Built for two users: the author and one
non-technical friend. It must install and run with no setup steps, no bundled
instructions beyond "double-click", and no external dependencies to install.

## Users and constraints

Two people, one of whom does not write code. This drives three decisions:

- Ghostscript ships **inside** the app. The user never learns it exists.
- Distribution is private, so Ghostscript's AGPL license imposes no obligation.
- The app must fail in plain language. No stack traces, no exit codes.

## Scope

**In scope.** One PDF at a time. Drop a file, set a target size, compress, save
the result.

**Out of scope.** Batch queues, presets, page preview, page removal, merging,
OCR, drag-out-to-Finder, update checking. Any of these can be added later; none
are needed for the app to be useful on day one.

## Stack

**Electron + React + TypeScript + Vite** (scaffolded with `electron-vite`),
packaged with `electron-builder`, tested with `vitest`. Compression is performed
by a bundled **Ghostscript 10.07** binary.

### Why this stack

Three options were weighed:

| Option | Compression quality | Installed size | Windows build from macOS |
|---|---|---|---|
| **Electron + Ghostscript** | Best available | ~200 MB | Yes |
| Tauri + Ghostscript | Same | ~40 MB | No |
| Pure JS (pdf-lib + sharp) | Poor on scans | ~120 MB | Yes |

Tauri's size advantage is real but it cannot cross-compile a Windows installer
from macOS, which would mean standing up CI to hand one friend an `.exe`. That
cost is not justified for a two-person tool.

Pure JS avoids bundling a binary but cannot downsample images embedded inside PDF
content streams, which is where nearly all the bytes live in a scanned document —
precisely the case where hitting 1.75 MB matters most.

## The compression engine

### The ladder

Compression is expressed as a fixed, ordered ladder of quality **rungs**. Each
rung is a pair of Ghostscript settings: image resolution (DPI) and JPEG quality
(expressed to Ghostscript as a `QFactor`). Rungs are ordered from gentlest to
harshest.

| Rung | DPI | QFactor | Notes |
|---|---|---|---|
| 0 | — | — | Structural only. Zero quality loss — requires forcing `FlateEncode`, since `pdfwrite`'s `AutoFilter` default silently applies lossy JPEG. |
| 1–8 | 250 → 166 | 0.15 → 0.34 | high quality |
| 9–15 | 158 → 110 | 0.37 → 0.65 | reduced image quality |
| 16–22 | 102 → 72 | 0.72 → 2.00 | heavily compressed; **22 is the readability floor** |
| 23–26 | 60 → 30 | 2.40 → 4.00 | beyond the floor — "Squeeze harder" only |

The steps are deliberately fine, 12–19% apart in output size. Step size is
quality the user paid for and did not receive: the search returns the largest
result that still fits, so a coarse ladder overshoots downward. Measured on a
23.8 MB 300 DPI colour scan at a 1.75 MB target, a coarser table returned
1,363,051 bytes (78% of the budget, 150 DPI) where this one returns 1,645,323
(94%, 166 DPI) — the same file size, visibly sharper images.

JPEG chroma is subsampled 4:2:0 at every rung: colour at half resolution,
brightness untouched. Measured 5.5–10.5% smaller for −0.01 dB, which is noise.

Rung 22 is the **readability floor**: the harshest setting the app will apply
without the user explicitly asking for more. Rungs 23–26 are reachable only via
the "Squeeze harder" button.

Text and vector content is never rasterized at any rung. Ghostscript's `pdfwrite`
device re-encodes embedded raster images only; glyphs stay glyphs and remain
selectable and searchable in the output at every rung, including 26.

**Colour is preserved at every rung.** An earlier version of this design
converted rungs 11 and below to grayscale (in a coarser 16-rung table), which bought 37–52% but turned colour
documents black and white — a change to the document's *content*, not its
quality. The app never makes that decision on the user's behalf. If a target is
only reachable by discarding colour, the honest answer is to report the smallest
size achievable and let the user decide.

The `QFactor` values above are measured, not derived: the whole table was run
against a real 300 DPI colour scan and confirmed strictly monotonic with 12–19%
steps.

### Ghostscript invocation

Rung 0 (structural only):

```
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 \
   -dNOPAUSE -dBATCH -dSAFER -dQUIET \
   -dAutoRotatePages=/None \
   -dDetectDuplicateImages=true \
   -dCompressFonts=true -dSubsetFonts=true -dEmbedAllFonts=true \
   -dDownsampleColorImages=false \
   -dDownsampleGrayImages=false \
   -dDownsampleMonoImages=false \
   -sOutputFile=<out> -f <in>
```

Rungs 1–26:

```
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 \
   -dNOPAUSE -dBATCH -dSAFER -dQUIET \
   -dAutoRotatePages=/None \
   -dDetectDuplicateImages=true \
   -dCompressFonts=true -dSubsetFonts=true -dEmbedAllFonts=true \
   -dDownsampleColorImages=true -dColorImageDownsampleType=/Bicubic \
   -dColorImageResolution=<DPI> \
   -dDownsampleGrayImages=true  -dGrayImageDownsampleType=/Bicubic \
   -dGrayImageResolution=<DPI> \
   -dDownsampleMonoImages=true  -dMonoImageDownsampleType=/Subsample \
   -dMonoImageResolution=<max(DPI*2, 300)> \
   -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
   -dAutoFilterGrayImages=false  -dGrayImageFilter=/DCTEncode \
   -sOutputFile=<out> \
   -c "<</ColorACSImageDict <</QFactor <QF> /Blend 1 /HSamples [2 1 1 1] /VSamples [2 1 1 1]>>
        /ColorImageDict    <</QFactor <QF> /Blend 1 /HSamples [2 1 1 1] /VSamples [2 1 1 1]>>
        /GrayACSImageDict  <</QFactor <QF> /Blend 1 /HSamples [2 1 1 1] /VSamples [2 1 1 1]>>
        /GrayImageDict     <</QFactor <QF> /Blend 1 /HSamples [2 1 1 1] /VSamples [2 1 1 1]>>
       >> setdistillerparams" \
   -f <in>
```

Mono (1-bit) images are downsampled far less aggressively than color, since
scanned text is frequently stored as 1-bit and degrades badly below 300 DPI.

### The search

Given an input file and a target byte count:

1. **Already small enough.** If the input is at or under target, report that and
   do no work. The user is offered the original file unchanged.
2. **Try rung 0.** If the structural pass alone lands at or under target, return
   it — the target is met with zero quality loss.
3. **Try the floor (rung 22).** If even the floor exceeds target, the target is
   not safely reachable. Keep the floor output, report *"smallest I could get
   without wrecking it: X MB"*, and offer **Squeeze harder** (see below).
4. **Binary search rungs 1–21** for the highest-quality rung whose measured
   output is at or under target.

**Squeeze harder** runs the same procedure over the beyond-floor rungs: try rung
26 first, and if it lands at or under target, binary search rungs 23–26 for the
highest-quality rung that fits. If rung 26 still exceeds target, the file cannot
be compressed to that size by this tool at all — report the rung 26 size as the
best achievable and stop.

Worst case is about seven Ghostscript passes. On a 20 MB scan this is roughly
18–28 seconds, reported live.

### Correctness invariant

**The app only ever returns a file whose size it has measured.** This is the
safety property, and it does not depend on the ladder being monotonic.

Monotonicity is expected but not guaranteed — forcing `DCTEncode` on images that
were already losslessly compressed can occasionally make a harsher rung produce a
slightly larger file. On non-monotonic data, binary search may select a
lower-quality rung than the true optimum, but it can never select a rung that
misses the target, because acceptance is based on the measured size of that
rung's actual output. Suboptimality is a quality nit; missing the target would be
a bug.

Measured sizes are cached per rung within a run so no rung is ever executed
twice, and the best qualifying output produced so far is retained on disk rather
than regenerated at the end.

## Architecture

```
src/
  main/
    index.ts       Window lifecycle, IPC wiring, app-level temp cleanup
    gs-locate.ts   Resolve the bundled Ghostscript path (dev vs. packaged, per-platform)
    gs-run.ts      Spawn Ghostscript for one rung; return { path, bytes }; support cancellation
    ladder.ts      The rung table, the floor index, and rung -> argv construction
    compress.ts    The search algorithm
    errors.ts      Map Ghostscript failures to plain-language messages
  preload/
    index.ts       contextBridge surface
  renderer/
    App.tsx        The single screen
    components/    DropZone, TargetInput, ProgressPanel, ResultCard
```

`compress.ts` is a pure orchestrator. It receives a `runRung(rung, input) =>
Promise<{ path, bytes }>` function by injection, so the entire search algorithm is
unit-testable with a fake runner and no Ghostscript process.

### Data flow

```
renderer  --IPC compress:start { inputPath, targetBytes, allowSqueeze }-->  main
main      --IPC compress:progress { attempt, rung, bytes }             -->  renderer
main      --IPC compress:done { outputPath, bytes, rung, hitTarget,
                                floorReached }                          -->  renderer
renderer  --IPC compress:cancel                                        -->  main
renderer  --IPC file:save { tempPath }-->  main  (native save dialog, then copy)
```

Intermediate files are written to `os.tmpdir()/pdf-compressor-<uuid>/` and removed
when the run finishes, is cancelled, or the app quits.

## Error handling

Every failure surfaces as a plain sentence in the result area:

| Condition | Message |
|---|---|
| File is not a PDF, or is corrupt | "This file isn't a readable PDF." |
| PDF is password-protected | "This PDF is password-protected. Remove the password and try again." |
| Input already at or under target | "Already 0.9 MB — nothing to do." |
| Target not reachable above the floor | "Smallest I could get without wrecking it: 3.2 MB." + Squeeze harder |
| Ghostscript binary missing or not executable | "Something's wrong with this installation — please reinstall." |
| Disk full / cannot write temp or output | "Ran out of disk space while compressing." |
| Ghostscript crash or non-zero exit, unclassified | "Compression failed on this file." + a "Copy details" button for debugging |

Cancellation kills the Ghostscript child process, removes the temp directory, and
returns the UI to its initial state.

## User interface

A single window, single screen, in this vertical order:

1. **Drop zone.** Accepts a dragged PDF or click-to-browse. After a file is
   chosen, shows the filename and current size.
2. **Target size.** A number input defaulting to `1.75` with a MB unit label. The
   last-used value is persisted and restored on next launch.
3. **Compress** button.
4. **Progress**, during a run: a bar plus the current attempt ("Attempt 3 of ~6 —
   trying 150 DPI"), and a Cancel button.
5. **Result card**: before and after sizes, the quality rung used in plain words
   ("high quality", "reduced image quality", "heavily compressed"), a **Save As**
   button, and — when the floor was hit — **Squeeze harder**.

Visual design is deliberately unspecified here and will be developed during
implementation.

## Bundling Ghostscript

Binaries live in `resources/gs/<platform>/` and are excluded from git. A checked-in
script, `scripts/fetch-ghostscript.sh`, produces them, and the README documents
running it once before the first build.

**Windows.** Extract `gswin64c.exe` and `gsdll64.dll` from the official Ghostscript
10.07 Windows release. These are **not** self-contained: both dynamically link the
Visual C++ 2015-2022 runtime (VCRUNTIME140.dll, VCRUNTIME140_1.dll, MSVCP140.dll),
which Windows does not ship. `resources/gs/win/` also bundles the redistributable
installer (`vcredist_x64.exe`, extracted from the same NSIS package) and
`build/installer.nsh` runs it silently during setup. Without this, every
compression fails with an opaque loader error (`STATUS_DLL_NOT_FOUND`) that
produces no stderr at all — see Task 4's report for the full failure mode and
`scripts/check-pe-imports.mjs` for the build-time dependency gate that catches it.

**macOS.** Build from the official source tarball so the result depends only on
system libraries. Ghostscript vendors its own libjpeg, libpng, zlib, freetype,
lcms2, and openjpeg, so a default build links nothing external:

```
./configure --without-x --disable-cups --disable-dbus \
            --disable-gtk --without-tesseract
make
```

Build for the **native architecture only** (`arm64`), and verify with `otool -L`
that only system libraries are referenced. The two users of this app are on
Apple Silicon and Windows respectively, so an x86_64 slice would be dead weight —
and cross-compiling Ghostscript is the most fragile step in the whole build. If
an Intel Mac ever needs support, run the script on one and `lipo -create` the two
binaries together.

**Contingency.** If the source build proves troublesome, fall back to bundling
the Homebrew binary together with its dependencies via `dylibbundler`, which
rewrites the install names into the app bundle. This is well-trodden but adds
~15 MB and more moving parts, so it is the second choice.

`gs-locate.ts` resolves `resources/gs/...` in development and
`process.resourcesPath/gs/...` in a packaged build, and marks the binary
executable on first run if needed.

## Packaging and installation

`electron-builder` produces an arm64 `.dmg` for macOS and an NSIS `.exe`
installer for Windows, both built from macOS.

The Windows installer is the **primary deliverable**: one of the two users runs
Windows, so a broken `.exe` means the app is unusable for half its audience,
whereas the macOS build only ever has to satisfy the developer's own machine.

Builds are **unsigned**. On first launch macOS will report that it "cannot check"
the app; the README will document the one-time right-click → Open workaround with
exact steps written for a non-technical reader. Windows SmartScreen will show a
similar one-time "More info → Run anyway" prompt. If an Apple Developer account
becomes available later, signing and notarization can be added to make the macOS
install seamless; this is not planned for the first version.

## Testing

**Unit tests** (`vitest`, no Ghostscript) cover the search algorithm in
`compress.ts` against a fake runner driven by synthetic size curves:

- A steep curve where rung 0 already fits.
- A shallow curve where the optimum sits mid-ladder — asserts the search picks
  the *highest-quality* qualifying rung, not merely a qualifying one.
- A curve where even the floor misses — asserts floor-reached reporting and that
  "Squeeze harder" then extends into rungs 23–26.
- A deliberately **non-monotonic** curve — asserts the returned file is still
  measured at or under target.
- Asserts no rung is executed twice within a run.

**Integration tests** run real Ghostscript against three generated fixtures: a
text-heavy vector document, a large image-heavy scan, and a file already under
target. A script generates the fixtures so no binary blobs are committed. These
assert the target is met, the floor behaves correctly, and — for the vector
fixture — that text is still extractable from the output.

**Manual verification** before release: build both installers, install on a clean
macOS user account and a Windows machine, and compress a real document end to end.

## Open items for implementation

- Validate and tune the `QFactor` table against the fixtures.
- Confirm the arm64 macOS Ghostscript source build; fall back to `dylibbundler` if needed.
- Confirm `electron-builder` produces a working NSIS installer from macOS.
