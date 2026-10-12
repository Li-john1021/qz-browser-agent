import { expect, test } from './sidepanel-fixtures.mjs';
import { chooseProvider } from './provider-picker-fixture.mjs';

const provider = {
  id: 'fixture-device', label: 'Fixture device', requiresApiKey: false, auth: { label: 'Fixture' },
  modelOptions: [{ key: 'fixtureQuality', label: 'Quality', defaultValue: 'balanced', options: [
    { value: 'balanced', label: 'Balanced' }, { value: 'precise', label: 'Precise' },
  ] }],
};

async function configure(page) {
  await page.locator('#btn-settings').click();
  await page.evaluate(provider => {
    window.__loginWindows = [];
    window.open = url => { window.__loginWindows.push(url); return null; };
    window.__qzEmitPortMessage({ type: 'config', config: {
      provider: provider.id, providers: [provider, { id: 'deepseek', label: 'DeepSeek', requiresApiKey: true }], providerAuth: { [provider.id]: { loggedIn: false } },
      model: 'fixture-local', contextWindow: 64000, presets: [], providerApiKeys: {},
      securityGuardrails: { rules: [], siteOpenRateLimits: [], order: [] },
    } });
  }, provider);
  await expect(page.locator('#btn-provider-login')).toHaveText('Fixture 登录');
}

async function latestRequest(page, type) {
  await expect.poll(() => page.evaluate(type => window.__qzPostedMessages.filter(message => message.type === type).length, type)).toBeGreaterThan(0);
  return page.evaluate(type => window.__qzPostedMessages.filter(message => message.type === type).at(-1), type);
}
const login = { loginId: 'fixture-login', userCode: 'LOCAL-CODE', verificationUri: 'https://example.invalid/login', intervalSeconds: 1, expiresAt: Date.now() + 3600000 };

async function reply(page, request, type, fields) {
  await page.evaluate(({ request, type, fields }) => window.__qzEmitPortMessage({ type, requestId: request.requestId, ...fields }), { request, type, fields });
}

test('an arbitrary provider renders declared login and model options and retains a login failure', async ({ page }) => {
  await configure(page);
  await expect(page.locator('#cfg-apikey-field')).toBeHidden();
  await expect(page.locator('#cfg-provider-option-fixtureQuality')).toHaveValue('balanced');
  await page.locator('#cfg-provider-option-fixtureQuality').selectOption('precise');
  await page.locator('#btn-provider-login').click();
  const request = await latestRequest(page, 'start_provider_login');
  expect(request.provider).toBe(provider.id);
  await reply(page, request, 'error', { code: 'AUTH_UNAVAILABLE', message: 'Fixture login unavailable' });
  await expect(page.locator('#provider-auth-status')).toHaveText('Fixture login unavailable');
  await expect(page.locator('#btn-provider-login')).toBeEnabled();
  await expect(page.locator('#cfg-provider-option-fixtureQuality')).toHaveValue('precise');
});

test('switching providers discards a late login start without opening a page or resuming polling', async ({ page }) => {
  await configure(page);
  await page.locator('#btn-provider-login').click();
  const request = await latestRequest(page, 'start_provider_login');
  await chooseProvider(page, 'deepseek');
  await reply(page, request, 'provider_login_started', login);
  await chooseProvider(page, provider.id);
  await expect(page.locator('#btn-provider-login')).toBeEnabled();
  await expect(page.locator('#provider-device-box')).toBeHidden();
  expect(await page.evaluate(() => window.__loginWindows)).toEqual([]);
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === 'poll_provider_login'))).toEqual([]);
});

test('closing a draft discards an in-flight login poll and clears its next timer', async ({ page }) => {
  await configure(page);
  await page.clock.install();
  await page.locator('#btn-provider-login').click();
  await reply(page, await latestRequest(page, 'start_provider_login'), 'provider_login_started', login);
  await expect(page.locator('#provider-device-code')).toHaveText('LOCAL-CODE');
  await page.clock.runFor(1200);
  const poll = await latestRequest(page, 'poll_provider_login');
  expect(poll.provider).toBe(provider.id);
  expect(poll.loginId).toBe(login.loginId);
  await page.locator('#btn-close-settings').click();
  await reply(page, poll, 'provider_login_polled', { status: 'pending', intervalSeconds: 1 });
  await page.clock.runFor(5000);
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === 'poll_provider_login').length)).toBe(1);
});
