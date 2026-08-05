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
# -aoa: auto-overwrite. The installer's NSIS payload contains duplicate paths
# (once for the installer UI, once for the actual program files); without
# this flag 7zz stops to prompt interactively.
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
