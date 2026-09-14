/**
 * Who counts as "internal" for the detailed /healthz payload.
 *
 * The public probe returns liveness only; the internal one names the environment, the
 * KLIP upstream state, the audit backlog and whether the break-glass password path is
 * enabled. That is a useful map for anyone deciding where to push, so the boundary has
 * to be exact.
 *
 * It was not. The original check listed string prefixes, with '172.2' and '172.3' as
 * shorthand for 172.20-172.31 - and those also match 172.2.x.x, 172.32.x.x and
 * 172.200.x.x, all of them public. RFC1918 is 172.16.0.0/12: second octet 16 to 31,
 * which no prefix string can express. Found on 14 Sep 2026 by probing the live
 * production gateway from a laptop and getting the full payload back.
 */
import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/http/health.js';

describe('addresses that ARE internal', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback, the form express reports behind nginx'],
    ['10.0.0.1', '10/8'],
    ['192.168.1.10', '192.168/16'],
    ['172.16.0.1', 'bottom of the 172.16/12 block'],
    ['172.31.255.254', 'top of the 172.16/12 block'],
    ['172.28.92.5', 'the corporate range this estate actually uses'],
  ])('%s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
});

describe('addresses that are NOT internal', () => {
  it.each([
    ['172.2.3.4', 'PUBLIC - the old 172.2 prefix matched this'],
    ['172.3.4.5', 'PUBLIC - the old 172.3 prefix matched this'],
    ['172.32.0.1', 'PUBLIC - one past the top of the block'],
    ['172.15.255.255', 'PUBLIC - one below the bottom of the block'],
    ['172.200.1.1', 'PUBLIC - matched 172.2 as a string'],
    ['8.8.8.8', 'plainly public'],
    ['11.0.0.1', 'adjacent to 10/8 but outside it'],
    ['192.169.1.1', 'adjacent to 192.168/16 but outside it'],
    ['1.127.0.0', 'contains a private-looking octet in the wrong position'],
  ])('%s (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([['not-an-ip'], [''], ['999.1.1.1'], ['10.0.0'], ['10.0.0.1.5'], ['10.0.0.0x1']])(
    'rejects the malformed value %j rather than guessing',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});
