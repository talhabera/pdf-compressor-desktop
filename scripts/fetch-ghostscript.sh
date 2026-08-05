#!/usr/bin/env bash
# Downloads and prepares the Ghostscript binaries this app bundles.
# Run once before the first build. Output is gitignored.
#
# Prerequisites on macOS:  xcode-select --install ; brew install sevenzip
#
# Note: this uses the `sevenzip` formula (binary `7zz`), not `p7zip` (`7z`).
# p7zip 17.05 (last released 2017) chokes on this installer's multi-block
# NSIS layout with "Unexpected end of input stream" and silently extracts
# only the installer-UI plugin DLLs, not the payload. `sevenzip` is the
# actively maintained build of the official 7-Zip source and extracts it
# correctly.
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

command -v 7zz >/dev/null 2>&1 || { echo "7zz not found. Run: brew install sevenzip"; exit 1; }
rm -rf "${WORK}/win-extract"
# -aoa: auto-overwrite. The installer's NSIS payload contains duplicate
# paths (once for the installer UI, once for the actual program files);
# without this flag 7zz stops to prompt interactively.
7zz x -aoa -o"${WORK}/win-extract" "${WIN_EXE}" > /dev/null
cp "${WORK}/win-extract/bin/gswin64c.exe" "${ROOT}/resources/gs/win/"
cp "${WORK}/win-extract/bin/gsdll64.dll"  "${ROOT}/resources/gs/win/"

# Verify the extraction actually produced the real payload rather than
# trusting 7zz's exit code. This installer's NSIS layout has previously
# fooled the older `p7zip`/`7z` tool into silently extracting only small
# installer-UI plugin DLLs (a few KB each) while still exiting non-zero
# with a misleading "Unexpected end of input stream" — the files would
# exist at the right paths and still be wrong. `gsdll64.dll` holds almost
# all of Ghostscript's code and is genuinely ~25 MB; a 20 MB floor catches
# a bad extraction precisely without being sensitive to minor version
# growth.
DLL="${ROOT}/resources/gs/win/gsdll64.dll"
EXE="${ROOT}/resources/gs/win/gswin64c.exe"
[ -f "${DLL}" ] && [ -f "${EXE}" ] || { echo "ERROR: Windows extraction did not produce the expected files."; exit 1; }
DLL_SIZE=$(stat -f%z "${DLL}" 2>/dev/null || stat -c%s "${DLL}")
if [ "${DLL_SIZE}" -lt $((20 * 1024 * 1024)) ]; then
  echo "ERROR: gsdll64.dll is only ${DLL_SIZE} bytes (expected ~25 MB)."
  echo "This is the signature of a partial/wrong 7z extraction. Refusing to continue."
  exit 1
fi
echo "OK: resources/gs/win/ (gsdll64.dll: ${DLL_SIZE} bytes)"

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
  unset PKG_CONFIG_PATH PKG_CONFIG_LIBDIR CPPFLAGS LDFLAGS
  make distclean >/dev/null 2>&1 || true
  ./configure --without-x --disable-cups --disable-dbus \
              --disable-gtk --without-tesseract --disable-fontconfig \
              --without-libidn --without-libpaper >/dev/null
  make -j"$(sysctl -n hw.ncpu)" >/dev/null
  cp bin/gs "${ROOT}/resources/gs/mac/gs" )

chmod +x "${ROOT}/resources/gs/mac/gs"

say "Verifying"
echo "arch:    $(lipo -archs "${ROOT}/resources/gs/mac/gs")"
echo "version: $("${ROOT}/resources/gs/mac/gs" --version)"
echo "links:"
otool -L "${ROOT}/resources/gs/mac/gs" | tail -n +2
echo
echo "Every line above must be under /usr/lib or /System. Anything under"
echo "/opt/homebrew or /usr/local means the binary is NOT self-contained."
echo

# Hard gate: refuse to ship a binary that depends on anything outside the OS.
# This has already caught one real failure (a Homebrew libidn link), so it is
# an assertion, not a formality.
if otool -L "${ROOT}/resources/gs/mac/gs" | tail -n +2 \
     | grep -qvE '^\s+(/usr/lib/|/System/)'; then
  echo "ERROR: the binary links a non-system library (listed above)."
  echo "It would run here and fail on every other Mac. Refusing to continue."
  exit 1
fi
echo "OK: binary is self-contained."
