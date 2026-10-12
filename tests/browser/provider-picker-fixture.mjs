/** Exercise the visible provider control; the hidden select is only a form adapter. */
export async function chooseProvider(page, providerId) {
  await page.locator("#cfg-provider-trigger").click();
  await page.locator("#cfg-provider-search").fill(providerId);
  await page.locator(`#cfg-provider-list [data-provider-id="${providerId}"]`).click();
}
