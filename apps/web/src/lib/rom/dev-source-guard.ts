import { POSE_ASSET_TEMPLATES } from '@dth/rom'

import { RUNTIME_RAW_SOURCES } from './storage/runtime-install'

/**
 * The dev server can keep serving an old template after the file changes: on
 * 2026-11-06 its watcher missed a template edit for 71 minutes while every other
 * module reloaded, so a generation paired new scripts with a CSV from the old
 * template. The cause of the missed event is unknown, so this guard doesn't rely
 * on the watcher: before generating, it compares the text this app has loaded with
 * the file on disk, which Vite serves statically without its module cache.
 *
 * Dev only. A built app bundles these files, so its copies can't drift.
 */
const DISK_URLS: Record<string, () => Promise<unknown>> = {
  ...import.meta.glob('../../../../../packages/rom/src/templates/*.csv', {
    query: '?url',
    import: 'default',
  }),
  ...import.meta.glob('./runtime/*.dsa', { query: '?url', import: 'default' }),
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** `fetch().text()` drops a BOM that `?raw` keeps; autocrlf only affects line ends. */
const normalize = (text: string) => text.replace(/^﻿/, '').replace(/\r\n/g, '\n')

/** Names of the bundled sources this guard has no disk URL for. */
export function sourcesWithoutDiskUrl(
  loaded: Readonly<Record<string, string>>,
  diskPaths: ReadonlyArray<string> = Object.keys(DISK_URLS),
): Array<string> {
  const onDisk = new Set(diskPaths.map(baseName))
  return Object.keys(loaded).filter((name) => !onDisk.has(name))
}

/** Names whose loaded text differs from `readDisk(name)`. */
export async function findStaleSources(
  loaded: Readonly<Record<string, string>>,
  readDisk: (name: string) => Promise<string>,
): Promise<Array<string>> {
  const names = Object.keys(loaded)
  const onDisk = await Promise.all(names.map(readDisk))
  return names.filter((name, i) => normalize(loaded[name]) !== normalize(onDisk[i]))
}

async function readViaDevServer(name: string): Promise<string> {
  const path = Object.keys(DISK_URLS).find((p) => baseName(p) === name)
  if (!path) throw new Error(`no dev URL for ${name}`)
  const url = (await DISK_URLS[path]()) as string
  const res = await fetch(url.replace(/\?.*$/, ''), { cache: 'no-store' })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.text()
}

/** Throws, so nothing is written, if a loaded source no longer matches its file. */
export async function assertDevSourcesFresh(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return
  const stale = await findStaleSources(
    { ...POSE_ASSET_TEMPLATES, ...RUNTIME_RAW_SOURCES },
    readViaDevServer,
  )
  if (stale.length > 0) {
    throw new Error(
      `Nothing was generated: the running app has an out-of-date copy of ${stale.join(', ')}. ` +
        'Restart the dev app (pnpm dev:desktop) and generate again.',
    )
  }
}
