import { timingSafeEqual } from 'node:crypto';

export function createAuth({ token }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('XANGI_EXTENSION_AUTH_TOKEN must contain at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  return async function authenticate(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  };
}
