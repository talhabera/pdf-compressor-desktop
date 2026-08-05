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
