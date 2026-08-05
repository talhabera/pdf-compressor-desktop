#!/usr/bin/env node
// Parses the PE import table of Windows binaries and fails if any imported
// DLL is neither shipped by Windows itself, one of our own bundled files, nor
// installed at setup time by the bundled VC++ redistributable.
//
// Why this exists: gswin64c.exe and gsdll64.dll dynamically link the Visual
// C++ runtime (VCRUNTIME140.dll, VCRUNTIME140_1.dll, MSVCP140.dll), which
// Windows does NOT ship on its own. Without it, `CreateProcess` succeeds and
// the *loader* then fails with STATUS_DLL_NOT_FOUND (0xC0000135) and empty
// stderr — a clean spawn from Node's point of view, indistinguishable from
// every other Ghostscript failure. That gap is why resources/gs/win/ now
// also bundles vcredist_x64.exe, run silently by the NSIS installer
// (build/installer.nsh). This check exists so that if a *future* Ghostscript
// build quietly adds some other unbundled dependency, the build fails here,
// loudly, instead of shipping an app that mysteriously fails to compress
// anything for a non-technical user with no way to diagnose it.
//
// Usage: node check-pe-imports.mjs <file.exe|file.dll> ...
// Exits 0 if every import resolves, 1 otherwise.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// Ships as part of Windows 10/11 itself — present without installing
// anything. Not exhaustive, just the DLLs Ghostscript's binaries actually
// import; kept short and reviewable rather than a giant generic allowlist.
const WINDOWS_SYSTEM_DLLS = new Set([
  'kernel32.dll',
  'user32.dll',
  'gdi32.dll',
  'advapi32.dll',
  'shell32.dll',
  'comdlg32.dll',
  'winspool.drv',
  'ole32.dll',
  'oleaut32.dll',
  'msvcrt.dll',
  'ntdll.dll',
  'ws2_32.dll',
  'shlwapi.dll',
  'version.dll',
  'winmm.dll',
  'crypt32.dll',
  'imm32.dll',
  'setupapi.dll',
  'rpcrt4.dll',
  'uxtheme.dll',
  'comctl32.dll',
  'ucrtbase.dll',
])

// The Universal CRT ships as part of the OS on Windows 10/11 (and via a
// Windows Update on 7/8.1, long since applied on any machine still receiving
// updates). These `api-ms-win-*` names are forwarder stubs into
// ucrtbase.dll, not a separate install — unlike VCRUNTIME/MSVCP below.
const isWindowsApiSet = (name) => /^api-ms-win-/i.test(name)

// NOT part of Windows and NOT vendored as separate DLL files (Ghostscript's
// official Windows build links them dynamically, and they cannot be cleanly
// extracted standalone from the redistributable installer — see the fetch
// script's Windows section). Instead, resources/gs/win/vcredist_x64.exe is
// bundled and run silently by the NSIS installer, so these resolve system-
// wide once install completes. Listed explicitly, with this reasoning, so an
// unrelated new dependency in a future Ghostscript build still fails loudly
// instead of being lost among these three known, deliberately handled ones.
const VCREDIST_PROVIDED = new Set(['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'])

function parseImportedDlls(file) {
  const buf = readFileSync(file)
  const peOffset = buf.readUInt32LE(0x3c)
  const numSections = buf.readUInt16LE(peOffset + 6)
  const optHeaderSize = buf.readUInt16LE(peOffset + 20)
  const optHeader = peOffset + 24
  const magic = buf.readUInt16LE(optHeader)
  // Data directory offset differs between PE32 (0x10b) and PE32+ (0x20b).
  const dataDirOffset = optHeader + (magic === 0x20b ? 112 : 96)
  const importTableRva = buf.readUInt32LE(dataDirOffset + 8)
  if (!importTableRva) return []

  const sections = []
  for (let i = 0; i < numSections; i++) {
    const s = optHeader + optHeaderSize + i * 40
    sections.push({
      va: buf.readUInt32LE(s + 12),
      size: buf.readUInt32LE(s + 8),
      raw: buf.readUInt32LE(s + 20),
    })
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + s.size) return rva - s.va + s.raw
    return null
  }

  const names = []
  let descriptor = rvaToOffset(importTableRva)
  for (;;) {
    const nameRva = buf.readUInt32LE(descriptor + 12)
    if (!nameRva) break
    let offset = rvaToOffset(nameRva)
    let name = ''
    while (buf[offset]) name += String.fromCharCode(buf[offset++])
    names.push(name)
    descriptor += 20
  }
  return names
}

function main(files) {
  if (files.length === 0) {
    console.error('usage: check-pe-imports.mjs <file.exe|file.dll> ...')
    return 2
  }

  const bundledNames = new Set(files.map((f) => basename(f).toLowerCase()))
  let ok = true

  for (const file of files) {
    let imports
    try {
      imports = parseImportedDlls(file)
    } catch (err) {
      console.error(`ERROR: could not parse PE imports of ${file}: ${err.message}`)
      ok = false
      continue
    }

    const unresolved = imports.filter((name) => {
      const lower = name.toLowerCase()
      return (
        !WINDOWS_SYSTEM_DLLS.has(lower) &&
        !isWindowsApiSet(name) &&
        !VCREDIST_PROVIDED.has(lower) &&
        !bundledNames.has(lower)
      )
    })

    console.log(`${basename(file)}: ${imports.length} imports`)
    if (unresolved.length > 0) {
      console.error(
        `  ERROR: depends on DLLs Windows doesn't ship, that aren't bundled, and that ` +
          `the redistributable doesn't cover: ${unresolved.join(', ')}`,
      )
      ok = false
    }
  }

  return ok ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
