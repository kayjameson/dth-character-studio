import { expect, test } from '@playwright/test'

import { P, buildSeed } from './fixtures.ts'
import { installTauriMock } from './tauri-mock.ts'

// A Save generates through the real path in a real browser, so this pins both
// halves of "a CSV always comes from the current templates": the character gets
// the template fingerprint, and a loaded template that differs from the file on
// disk stops the generation. The guard only exists in dev-mode transforms, so
// the prebuilt-bundle run skips the second test.

async function openKira(page: import('@playwright/test').Page) {
  const seed = buildSeed({ activeProjectFile: P.dcsp, demo: true })
  const kira = JSON.parse(seed.files[`${P.charFolder}/Kira.json`]) as Record<string, unknown>
  kira.exportPath = 'X:/exports/kira'
  seed.files[`${P.charFolder}/Kira.json`] = JSON.stringify(kira, null, 2)
  await page.addInitScript(installTauriMock, seed)
  await page.goto('/')
  await page.getByRole('link', { name: /Kira/ }).click()
  await page.getByText(/custom ROM frames/).waitFor()
  await page
    .locator('div.rounded-lg.border')
    .filter({ has: page.getByText('PHY', { exact: true }) })
    .getByRole('switch')
    .click()
}

const readKira = (page: import('@playwright/test').Page) =>
  page.evaluate(
    (path) => (window as any).__tauriMock.files.get(path) as string | undefined,
    `${P.charFolder}/Kira.json`,
  )

test('a Save stamps the template fingerprint on the character', async ({ page }) => {
  await openKira(page)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => JSON.parse((await readKira(page)) ?? '{}').generatedCsvTemplates)
    .toMatch(/^[0-9a-f]{8}$/)
})

test('a template that differs from the file on disk stops generation', async ({ page }) => {
  test.skip(!!process.env.CI || process.env.SMOKE_PREBUILT === '1', 'dev-mode guard')
  // What the 2026-11-06 miss looked like from the app: disk has moved on from
  // the loaded template. Only the plain file URL is faked, which is the one the
  // guard reads, not the `?import&raw` module the app loaded.
  await page.route(/poseasset-physics-g9\.csv$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/csv', body: 'moved,on\n' }),
  )
  await openKira(page)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Nothing was generated/).first()).toBeVisible()
  await expect(page.getByText(/poseasset-physics-g9\.csv/).first()).toBeVisible()
  // The definition saves first by design; generation is what must not happen.
  const script = await page.evaluate(
    (path) => (window as any).__tauriMock.files.get(path) as string | undefined,
    `${P.scriptsDir}/ROM_Kira_G9.dsa`,
  )
  expect(script).toContain('e2e fixture')
})
