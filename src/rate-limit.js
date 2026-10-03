import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';
import ipaddr from 'ipaddr.js';
import { RateLimiterMemory } from 'rate-limiter-flexible';

export function createClientKeyResolver(trustedProxies = []) {
  if (!Array.isArray(trustedProxies)) throw new Error('TRUSTED_PROXY_CIDRS must be a list of explicit IPs or CIDRs');
  for (const range of trustedProxies) {
    const address = range.split('/')[0];
    if (!isIP(address)) throw new Error('Invalid trusted proxy IP or CIDR');
    if (range.includes('/')) {
      const [ip, bits] = ipaddr.parseCIDR(range);
      if (bits === 0 || (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress() && bits <= 96)) {
        throw new Error('Trusting every proxy address is not allowed');
      }
    }
  }
  const trust = proxyaddr.compile(trustedProxies);
  return (req) => {
    const candidate = proxyaddr(req, trust);
    // A malformed forwarded address must not create arbitrary limiter identities.
    const address = isIP(candidate) ? candidate : req.socket.remoteAddress;
    const ip = ipaddr.process(address);
    if (ip.kind() === 'ipv4') return ip.toString();
    const subnet = ipaddr.fromByteArray([...ip.toByteArray().slice(0, 8), ...Array(8).fill(0)]);
    return `${subnet.toNormalizedString()}/64`;
  };
}

export const RATE_POLICIES = Object.freeze({
  anonymous: 60, adminAuth: 30, adminRead: 120, adminWrite: 30,
  checkoutRead: 60, checkoutWrite: 5
});

export function createRateLimits() {
  const buckets = Object.fromEntries(Object.entries(RATE_POLICIES).map(([name, points]) =>
    [name, new RateLimiterMemory({ points, duration: 60, keyPrefix: name })]));
  return async (scope, key, res) => {
    try { await buckets[scope].consume(key); return true; }
    catch (error) {
      if (!Number.isFinite(error.msBeforeNext)) throw error;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.msBeforeNext / 1000))));
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return false;
    }
  };
}
