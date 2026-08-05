# PDF Compressor

A small desktop app that compresses a PDF down to a size you choose. Built for
macOS (Apple Silicon) and Windows.

## For users

Download the installer for your system, open it, and drag the app where it
wants to go.

**First launch on macOS** shows a warning: *"PDF Compressor cannot be opened
because Apple cannot check it for malicious software."* This is expected —
the app is not signed with a paid Apple developer certificate. To open it:

1. Click **Done** to dismiss the warning.
2. Find PDF Compressor in your Applications folder.
3. **Right-click** it (on a trackpad: click with two fingers, or hold
   **Control** and click) and choose **Open** from the menu that appears.
4. Click **Open** in the dialog that comes up.

You only need to do this once. After that, it opens normally by double-click,
like any other app.

**First launch on Windows** shows a blue screen: *"Windows protected your
PC."* Click **More info**, then click **Run anyway**. Also only needed once.

### Using it

Drop a PDF on the window, set the target size in MB, and press Compress. When
it finishes, press **Save As…**.

If the file can't reach your target without becoming unreadable, the app stops
early, tells you the smallest size it could safely manage, and offers a
**Squeeze harder** button that goes further at real cost to quality.

Sizes use decimal megabytes: 1 MB = 1,000,000 bytes. This is the stricter of
the two common definitions, so a file the app reports as, say, 1.75 MB is
accepted by upload limits that use either definition.

## For developers

### Setup

```bash
npm install
npm run fetch-gs    # builds/downloads the bundled Ghostscript. Takes a few minutes.
npm run fixtures    # generates test PDFs
npm run dev
```

`npm run fetch-gs` needs the Xcode command line tools and `sevenzip` — **not**
`p7zip`. `p7zip` (the formula last updated in 2017) cannot read Ghostscript's
Windows installer: it silently extracts only the installer's UI plugin DLLs
and reports success, so the failure looks like it worked until the app can't
find `gsdll64.dll` at runtime. Don't "simplify" this back to `p7zip`.

```bash
xcode-select --install
brew install sevenzip
```

Both `resources/gs/` (Ghostscript binaries) and `tests/fixtures/` (generated
PDFs) are gitignored. Run both commands above before your first build or test
run.

### Tests

```bash
npm test                  # unit tests, no Ghostscript needed
npm run test:integration  # runs real Ghostscript against generated fixtures
npm run typecheck
```

### Building installers

```bash
npm run pack:mac    # release/*.dmg  (arm64 only, see below)
npm run pack:win    # release/*.exe
```

Both build from macOS with no extra setup — electron-builder cross-packages
the Windows target directly, no Wine or CI needed.

The macOS build targets **arm64 only**, by design: both current users of this
app are on Apple Silicon or Windows, and `resources/gs/mac/gs` is a
single-architecture binary built for the native arch of whatever Mac ran
`fetch-gs`. Don't change the target to `universal` — it will fail on that
binary. If an Intel Mac ever needs support, run `fetch-gs` on one and `lipo
-create` the two `gs` binaries together.

### How compression works

Compression is a fixed ladder of 16 quality rungs, each a pair of image DPI
and JPEG QFactor settings, defined in `src/main/ladder.ts`. Rung 0 is
structural only and loses nothing. Rung 11 is the *readability floor* — the
harshest setting applied without the user explicitly asking. Rungs 12–15 are
reachable only via "Squeeze harder".

`src/main/compress.ts` probes rung 0, probes the floor, then binary-searches
between them for the highest-quality rung whose output actually fits. It only
ever returns a file whose size it measured, so a non-monotonic ladder can cost
quality but can never miss the target.

Two guarantees the app makes about your document, at every rung including the
harshest:

- **Text is never rasterized.** Ghostscript re-encodes embedded images only;
  text stays selectable and searchable in the output.
- **Colour is never discarded.** The app does not convert documents to
  grayscale. Compression lowers image resolution and JPEG quality; it does not
  change what the document *is*. If a target is only reachable by throwing away
  colour, the app reports the smallest size it can safely manage instead.

### About the Ghostscript build

`scripts/fetch-ghostscript.sh` builds Ghostscript from source for the native
architecture of whatever Mac runs it, and refuses to install the result unless
`otool -L` shows it linking nothing outside `/usr/lib` and `/System`.

That gate is not ceremony. It has already caught two real failures: Ghostscript's
`configure` autodetected Homebrew's `libidn` and `fontconfig` and linked them,
either of which would have produced a binary that ran perfectly on the build
machine and failed on every other computer — surfacing as an inscrutable
"library not loaded" error only after packaging and installation. The build now
runs with a sanitised `PATH` so Homebrew is not discoverable at all.

If the build fails, read the actual error rather than working around the gate.
Copying Homebrew's `gs` into place will not work: the gate rejects it, correctly.

## Licence

This app bundles Ghostscript, which is licensed under the AGPL. It is
distributed privately and is not published.
