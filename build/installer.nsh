; Custom NSIS installer steps, included via electron-builder's `nsis.include`.
;
; Ghostscript's Windows binaries (gswin64c.exe, gsdll64.dll) dynamically link
; the Visual C++ 2015-2022 runtime (VCRUNTIME140.dll, VCRUNTIME140_1.dll,
; MSVCP140.dll), which Windows does NOT ship on its own. Without it,
; CreateProcess succeeds and the loader then fails with STATUS_DLL_NOT_FOUND
; (0xC0000135) and empty stderr — silently, with no diagnostic Ghostscript
; ever gets a chance to print. This runs Microsoft's official redistributable
; installer, bundled at resources/gs/vcredist_x64.exe (electron-builder's
; ${os} macro flattens resources/gs/win/ to resources/gs/ in the packaged
; app), silently and non-interactively right after the app's files land on
; disk.
;
; /install /quiet /norestart: installs without any UI and never reboots the
; user's machine as a side effect of installing a PDF compressor.
!macro customInstall
  DetailPrint "Setting up required components..."
  ExecWait '"$INSTDIR\resources\gs\vcredist_x64.exe" /install /quiet /norestart'
!macroend
