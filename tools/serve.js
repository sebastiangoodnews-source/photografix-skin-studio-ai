import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Development harness.
 *
 * Serves the panel in a plain browser so the UI and every processing engine can be
 * reviewed without Photoshop. Bound to 0.0.0.0 and free of host/origin allowlists
 * so it works behind the sandbox preview proxy.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const resolveSafe = (urlPath) => {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.resolve(ROOT, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (!target.startsWith(ROOT)) return null;
  return target;
};

const server = http.createServer(async (req, res) => {
  try {
    const filePath = resolveSafe(req.url || '/');
    if (!filePath) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Photografix Skin Studio harness: http://0.0.0.0:${PORT}`);
});
