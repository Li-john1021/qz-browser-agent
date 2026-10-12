import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedSessionExchangeLocation } from '../../src/shared/session/session-exchange-source.js';
import { isAllowedSessionExportSource } from '../../src/background/services/session-exchange-bridge.js';

test('local exported chats can be imported without a hosted service', () => {
  for (const value of ['file:///tmp/conversation.html', 'http://localhost:8765/', 'http://127.0.0.1:4173/', 'http://[::1]:8765/']) {
    assert.equal(isAllowedSessionExchangeLocation(new URL(value)), true, value);
    assert.equal(isAllowedSessionExportSource(value), true, value);
  }
});
test('external origins, suffix impersonation and unsupported protocols cannot import chats', () => {
  for (const value of ['https://untrusted.invalid/', 'http://localhost.evil.test/', 'https://notlocalhost/', 'data:text/html,content', 'chrome://settings/', 'chrome-extension://id/export']) {
    assert.equal(isAllowedSessionExchangeLocation(new URL(value)), false, value);
    assert.equal(isAllowedSessionExportSource(value), false, value);
  }
  assert.equal(isAllowedSessionExportSource('bad url'), false);
});
