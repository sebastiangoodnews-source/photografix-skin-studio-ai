// Minimal static server for the release download.
//
// Binds 0.0.0.0 so the Arena preview proxy can reach it. The zip is served with
// Content-Disposition: attachment so a browser saves it rather than rendering it.
// Every request is logged: if a click never appears in this log, the request was
// blocked before it left the page (an iframe sandbox without allow-downloads does
// exactly that), which is a different problem from a broken server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8080);
const ZIP = 'Photografix-Skin-Studio-AI-Free-Core-v1.0.0.zip';

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const name = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, name);

  res.on('finish', () => {
    const ok = res.statusCode === 200 ? 'OK  ' : 'FAIL';
    console.log(
      `${ok} ${res.statusCode} ${req.method} /${name} ` +
        `${res.getHeader('Content-Length') || 0}B ${Date.now() - started}ms ` +
        `range=${req.headers.range || '-'} ua=${(req.headers['user-agent'] || '').slice(0, 40)}`
    );
  });

  // Never serve outside this directory.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }

  const isZip = name.endsWith('.zip');
  const size = fs.statSync(file).size;
  const headers = {
    'Content-Type': isZip ? 'application/zip' : 'text/html; charset=utf-8',
    'Content-Length': size,
    'Content-Disposition': isZip ? `attachment; filename="${ZIP}"` : 'inline',
    'Cache-Control': 'no-store',
    // Let a proxied/iframe context know a download is intentional.
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  };

  // Support range requests so an interrupted 413 KB download can resume.
  const range = req.headers.range;
  if (isZip && range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => console.log(`release download server on 0.0.0.0:${PORT}`));
