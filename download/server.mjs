// Minimal static server for the release download.
// Binds 0.0.0.0 so the Arena preview proxy can reach it, and serves the zip with
// Content-Disposition: attachment so a browser downloads it instead of opening it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8080);
const ZIP = 'Photografix-Skin-Studio-AI-Free-Core-v1.0.0.zip';

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const name = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, name);

  // Never serve outside this directory.
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }

  const isZip = name.endsWith('.zip');
  const size = fs.statSync(file).size;
  res.writeHead(200, {
    'Content-Type': isZip ? 'application/zip' : 'text/html; charset=utf-8',
    'Content-Length': size,
    'Content-Disposition': isZip ? `attachment; filename="${ZIP}"` : 'inline',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`release download server on 0.0.0.0:${PORT}`));
