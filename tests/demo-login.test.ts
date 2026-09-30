import { describe, expect, it } from 'vitest';
import { canUseDemoLogin } from '../src/shared/login';

describe('demo login fallback', () => {
  it('does not expose or allow the default admin account in browser preview mode', () => {
    expect(canUseDemoLogin(null, 'admin', 'admin123')).toBe(false);
  });

  it('blocks unknown credentials when Electron IPC is unavailable', () => {
    expect(canUseDemoLogin(null, 'guest', 'wrong')).toBe(false);
  });
});
