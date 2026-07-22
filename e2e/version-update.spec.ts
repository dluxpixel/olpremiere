// Proves the "which version am I on / did it just update" UI actually works in the
// real app: the always-on version tag, and the post-update toast that fires ONLY
// when the stored version changed since last launch. The Electron auto-APPLY
// (quitAndInstall) is main-process only and can't run here; this covers the
// renderer half the user actually sees.

import { expect, test } from '@playwright/test'
import fs from 'node:fs'

const APP_VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string
const KEY = 'reel:lastSeenVersion'

test('the top bar shows the running build version', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('app-version')).toHaveText(`v${APP_VERSION}`)
})

test('a version change since last launch shows the "Updated to" toast', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, '0.0.1'), KEY)
  await page.goto('/')
  await expect(
    page.getByTestId('toast').filter({ hasText: `Updated to v${APP_VERSION}` }),
  ).toBeVisible({ timeout: 8000 })
  // The stored version is advanced to the running build so it won't fire again.
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(APP_VERSION)
})

test('a first run (nothing stored) shows no update toast, but records the version', async ({ page }) => {
  await page.addInitScript((key) => localStorage.removeItem(key), KEY)
  await page.goto('/')
  await page.waitForTimeout(600) // let the mount effect run
  await expect(page.getByTestId('toast').filter({ hasText: 'Updated to' })).toHaveCount(0)
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe(APP_VERSION)
})

test('re-opening the same build shows no update toast', async ({ page }) => {
  await page.addInitScript((args) => localStorage.setItem(args.key, args.v), { key: KEY, v: APP_VERSION })
  await page.goto('/')
  await page.waitForTimeout(600)
  await expect(page.getByTestId('toast').filter({ hasText: 'Updated to' })).toHaveCount(0)
})
