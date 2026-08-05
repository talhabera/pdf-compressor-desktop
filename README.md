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
