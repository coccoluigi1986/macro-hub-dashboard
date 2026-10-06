// Minimal dev server: serves index.html statically and routes /api/* to the
// Vercel-style serverless functions in /api. No npm dependencies — only Node
// built-ins. The functions export an Express-like handler (req, res) via
// lib/vercel-adapter.js, so we shim req.query / res.status / res.send onto the
// native http objects.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Cache function modules so we don't re-require on every request.
const fnCache = {};

function getApiHandler(name) {
  if (fnCache[name]) return fnCache[name];
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  const handler = require(file);
  fnCache[name] = handler;
  return handler;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- API routes: /api/<name> → api/<name>.js ---
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\.js$/, '');
    const handler = getApiHandler(name);
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Function not found: ${name}` }));
      return;
    }

    // Shim Express-like interface onto native req/res for vercel-adapter.
    const parsed = new URLSearchParams(url.search);
    req.query = Object.fromEntries(parsed.entries());
    req.method = req.method || 'GET';

    let statusCode = 200;
    const headers = {};
    res.status = (code) => { statusCode = code; return res; };
    res.setHeader = (k, v) => { headers[k] = v; return res; };
    res.send = (body) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- Static files ---
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  // Prevent path traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for unknown routes
      if (err.code === 'ENOENT' && pathname !== '/') {
        fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(d2);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Macro Hub Dashboard dev server on http://0.0.0.0:${PORT}`);
});
