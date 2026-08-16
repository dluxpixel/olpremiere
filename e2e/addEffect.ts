// One way to add an effect from the inspector, shared by every spec that needs
// a clip with effects on it.
//
// The inspector used to hold a native <select>, so specs called selectOption and
// the browser did the opening for them. It is our own menu now, and a helper is
// the difference between one place to fix and five.

import { expect, type Page } from '@playwright/test'

/** Opens the Add effect menu, picks `type`, and waits for the menu to shut. */
export async function addEffect(page: Page, type: string): Promise<void> {
  await page.getByTestId('inspector-add-effect').click()
  await expect(page.getByTestId('add-effect-menu')).toBeVisible()
  await page.locator(`[data-testid="add-effect-row"][data-type="${type}"]`).first().click()
  // Applying closes the menu. Waiting for that here means a spec can add two
  // effects in a row without the second click landing on the backdrop.
  await expect(page.getByTestId('add-effect-menu')).toBeHidden()
}
