
import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = 8000;
const GOOGLE_TARGET = 'https://generativelanguage.googleapis.com';

// Read target from environment or default to Google
const TARGET_URL = process.env.BRIDGE_TARGET || GOOGLE_TARGET;
// Explicit mode or auto-detect based on typical Ollama ports
const MODE = process.env.BRIDGE_MODE ||
             (TARGET_URL.includes('11434') || TARGET_URL.includes('ollama') ? 'ollama' : 'google');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[BRIDGE] Request: ${req.method} ${url.pathname}${url.search}`);

  if (MODE === 'ollama') {
    await handleOllamaRequest(req, res, url);
  } else {
    forwardRequest(req, res, url, TARGET_URL);
  }
});

function forwardRequest(req, res, url, targetBase) {
  const targetUrl = new URL(url.pathname + url.search, targetBase);
  console.log(`[BRIDGE] Forwarding to: ${targetUrl.toString()}`);

  const options = {
    method: req.method,
    headers: {
      ...req.headers,
      host: new URL(targetBase).host,
    },
  };
  delete options.headers['host'];

  const transport = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = transport.request(targetUrl, options, (proxyRes) => {
    console.log(`[BRIDGE] Response Status: ${proxyRes.statusCode}`);
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[BRIDGE] Error:', err);
    res.writeHead(500);
    res.end('Bridge Error: ' + err.message);
  });

  req.pipe(proxyReq);
}

function mapGeminiToOllamaMessages(contents) {
    if (!Array.isArray(contents)) return [];

    const messages = [];
    for (const content of contents) {
        let role = content.role;
        if (role === 'model') role = 'assistant';

        let text = '';
        if (content.parts) {
            text = content.parts.map(p => p.text || '').join('');
        }

        if (text) {
            messages.push({ role, content: text });
        }
    }
    return messages;
}

async function handleOllamaRequest(req, res, url) {
  console.log('[BRIDGE] Handling as Ollama request');

  // Buffer the body
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(chunk);
  }
  const body = Buffer.concat(bodyChunks).toString();

  let geminiReq;
  try {
    geminiReq = JSON.parse(body);
  } catch (e) {
    console.error('[BRIDGE] Failed to parse JSON body');
    res.writeHead(400);
    res.end('Invalid JSON');
    return;
  }

  // Extract messages from Gemini request history
  const messages = mapGeminiToOllamaMessages(geminiReq.contents);
  const model = 'tinyllama'; // Force model for now

  console.log(`[BRIDGE] Messages: ${messages.length}`);
  if (messages.length > 0) {
      console.log(`[BRIDGE] Last Prompt: "${messages[messages.length-1].content.substring(0, 50)}..."`);
  }

  // Check if client requested SSE (Streaming)
  const isSSE = url.searchParams.get('alt') === 'sse';

  // Construct Ollama request
  const ollamaReq = {
    model: model,
    messages: messages,
    stream: true
  };

  const ollamaTarget = new URL('/api/chat', TARGET_URL);

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const transport = ollamaTarget.protocol === 'https:' ? https : http;

  const proxyReq = transport.request(ollamaTarget, options, (proxyRes) => {
    console.log(`[BRIDGE] Ollama Response Status: ${proxyRes.statusCode}`);

    if (isSSE) {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'text/event-stream',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
    } else {
        // Wait for full response
    }

    let buffer = '';
    let fullText = '';

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const ollamaChunk = JSON.parse(line);
            const text = ollamaChunk.message?.content || '';
            const done = ollamaChunk.done;

            if (text) {
                if (isSSE) {
                    const geminiChunk = {
                        candidates: [{
                            content: {
                                parts: [{ text: text }],
                                role: "model"
                            },
                            finishReason: null
                        }]
                    };
                    res.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
                } else {
                    fullText += text;
                }
            }

            if (done) {
                 if (isSSE) {
                     res.write(`data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}\n\n`);
                 }
            }

        } catch (e) {
            console.error('Error parsing ollama chunk', e);
        }
      }
    });

    proxyRes.on('end', () => {
      if (buffer.trim()) {
          try {
             const ollamaChunk = JSON.parse(buffer);
             const text = ollamaChunk.message?.content || '';
             if (text) {
                 if (isSSE) {
                      const geminiChunk = { candidates: [{ content: { parts: [{ text: text }], role: "model" }, finishReason: null }] };
                      res.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
                 } else {
                     fullText += text;
                 }
             }
          } catch(e) {}
      }

      if (!isSSE) {
          const response = {
              candidates: [{
                  content: {
                      parts: [{ text: fullText }],
                      role: "model"
                  },
                  finishReason: "STOP",
                  index: 0
              }]
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
      } else {
          res.end();
      }
    });
  });

  proxyReq.write(JSON.stringify(ollamaReq));
  proxyReq.end();
}

server.listen(PORT, () => {
  console.log(`[BRIDGE] Listening on port ${PORT}`);
  console.log(`[BRIDGE] Target: ${TARGET_URL}`);
  console.log(`[BRIDGE] Mode: ${MODE}`);
});
