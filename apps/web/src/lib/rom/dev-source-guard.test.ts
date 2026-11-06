import { describe, expect, it } from 'vitest'

import { POSE_ASSET_TEMPLATES } from '@dth/rom'

import { findStaleSources, sourcesWithoutDiskUrl } from './dev-source-guard'
import { RUNTIME_RAW_SOURCES } from './storage/runtime-install'

const LOADED = { 'a.csv': 'row,11.0\n', 'b.dsa': 'code\n' }

describe('dev source guard', () => {
  it('reports a loaded template that no longer matches the file on disk', async () => {
    const disk: Record<string, string> = { 'a.csv': 'row,0.0\n', 'b.dsa': 'code\n' }
    await expect(findStaleSources(LOADED, async (name) => disk[name])).resolves.toEqual(['a.csv'])
  })

  it('passes when the text matches, ignoring a BOM and line endings', async () => {
    const disk: Record<string, string> = { 'a.csv': '\uFEFFrow,11.0\r\n', 'b.dsa': 'code\r\n' }
    await expect(findStaleSources(LOADED, async (name) => disk[name])).resolves.toEqual([])
  })

  it('fails closed when a file cannot be read', async () => {
    await expect(
      findStaleSources(LOADED, async () => {
        throw new Error('HTTP 404')
      }),
    ).rejects.toThrow('HTTP 404')
  })

  it('has a disk URL for every template and runtime source the app loads', () => {
    expect(sourcesWithoutDiskUrl({ ...POSE_ASSET_TEMPLATES, ...RUNTIME_RAW_SOURCES })).toEqual([])
  })

  it('names a source it has no URL for', () => {
    expect(sourcesWithoutDiskUrl({ 'new.csv': '' }, ['/x/old.csv'])).toEqual(['new.csv'])
  })
})
