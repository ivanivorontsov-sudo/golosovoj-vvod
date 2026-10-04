import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wav': 'audio/wav' };
function handler(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/tests/fixtures/index.html';
  if (p === '/frame.html') p = '/tests/fixtures/frame.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}
export async function startServers() {
  for (;;) {
    const port = 18000 + Math.floor(Math.random() * 2000);
    try {
      const a = await listen(port), b = await listen(port + 1);
      return { port, url: `http://localhost:${port}/`, close: () => { a.close(); b.close(); } };
    } catch {}
  }
}
function listen(port) { return new Promise((res, rej) => { const s = http.createServer(handler); s.once('error', rej); s.listen(port, () => res(s)); }); }
