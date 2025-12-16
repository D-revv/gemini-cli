
import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = 8000;
const TARGET_URL = 'https://generativelanguage.googleapis.com';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

  console.log(`[BRIDGE] Request: ${req.method} ${targetUrl.toString()}`);
  console.log('[BRIDGE] Headers:', JSON.stringify(req.headers, null, 2));

  const options = {
    method: req.method,
    headers: {
      ...req.headers,
      host: new URL(TARGET_URL).host, // Important: set the host header to the target
    },
  };

  // Remove headers that might confuse the target
  delete options.headers['host'];

  const proxyReq = https.request(targetUrl, options, (proxyRes) => {
    console.log(`[BRIDGE] Response Status: ${proxyRes.statusCode}`);
    console.log('[BRIDGE] Response Headers:', JSON.stringify(proxyRes.headers, null, 2));

    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[BRIDGE] Error:', err);
    res.writeHead(500);
    res.end('Bridge Error: ' + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`[BRIDGE] Listening on port ${PORT}`);
  console.log(`[BRIDGE] Forwarding to ${TARGET_URL}`);
});
