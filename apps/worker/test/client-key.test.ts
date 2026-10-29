import { describe, expect, it } from 'vitest';
import { clientKey } from '../src/client-key';

describe('clientKey', () => {
  it('keeps IPv4 addresses', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey(null)).toBe('unknown');
  });

  it('groups IPv6 addresses by /64, including compressed forms', () => {
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:DB8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:0db8:0001:0002::ffff')).toBe('2001:db8:1:2::/64');
  });
});
