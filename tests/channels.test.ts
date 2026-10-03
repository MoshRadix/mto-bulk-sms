import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../electron/ipc/channels';
import { getGroupMemberCount } from '../electron/ipc/setup.ipc';

// The preload whitelist is intentionally duplicated inline because sandboxed preload cannot import local modules.
describe('preload whitelist', () => {
  it('matches electron/ipc/channels.ts and has no local requires', () => {
    const src = readFileSync('electron/preload.ts', 'utf8');
    for (const c of CHANNELS) expect(src).toContain(`'${c}'`);
    expect(src).not.toMatch(/from '\.\//);
    expect(src.match(/'[a-z]+:[a-z-]+'/g)?.length).toBe(CHANNELS.length);
  });

  it('includes supported admin management actions', () => {
    expect(CHANNELS).toEqual(expect.arrayContaining([
      'contacts:update',
      'contacts:delete',
      'contacts:bulk-delete',
      'groups:update',
      'groups:delete',
    ]));
  });

  it('derives group member count from actual contact assignments when members are stale', () => {
    expect(getGroupMemberCount([], ['c1', 'c2', 'c3'])).toBe(3);
    expect(getGroupMemberCount(['old-member'], ['c1', 'c2'])).toBe(2);
    expect(getGroupMemberCount(['a', 'b'], [])).toBe(2);
  });
});
