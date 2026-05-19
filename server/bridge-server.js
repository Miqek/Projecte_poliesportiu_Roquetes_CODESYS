const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const APP_DIR = path.resolve(__dirname, config.http.staticDir);
const LOG_FILE = path.resolve(__dirname, config.logging.file);
const FRAME_BYTES = config.codesys.frameBytes;

let codesysSocket = null;
let virtuHomeSocket = null;
let virtuHomeBuffer = Buffer.alloc(0);
let lastCodesysFrame = Buffer.alloc(FRAME_BYTES, 0);
let lastCommandFrame = Buffer.alloc(FRAME_BYTES, 0);
const wsClients = new Set();

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (config.logging.enabled) {
    fs.appendFile(LOG_FILE, line + '\n', () => {});
  }
}

function json(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function normalizeFrame(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frame = Buffer.alloc(FRAME_BYTES, 0);
  src.copy(frame, 0, 0, Math.min(src.length, FRAME_BYTES));
  return frame;
}

function buildStatus() {
  return {
    type: 'status',
    http: `http://${config.http.host}:${config.http.port}`,
    websocket: `ws://${config.websocket.host}:${config.websocket.port}`,
    codesysConnected: !!codesysSocket && !codesysSocket.destroyed,
    virtuHomeEnabled: !!config.virtuHome.enabled,
    virtuHomeConnected: !!virtuHomeSocket && !virtuHomeSocket.destroyed,
    frameBytes: FRAME_BYTES
  };
}

function broadcastJson(obj) {
  const payload = JSON.stringify(obj);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastBinary(frame, exceptClient = null) {
  for (const client of wsClients) {
    if (client !== exceptClient && client.readyState === WebSocket.OPEN) {
      client.send(frame, { binary: true });
    }
  }
}

function forwardToCodesys(frame) {
  if (codesysSocket && !codesysSocket.destroyed) {
    codesysSocket.write(frame);
  }
}

function forwardToVirtuHome(frame) {
  if (config.virtuHome.enabled && virtuHomeSocket && !virtuHomeSocket.destroyed) {
    virtuHomeSocket.write(frame);
  }
}

function connectVirtuHome() {
  if (!config.virtuHome.enabled) return;
  if (virtuHomeSocket && !virtuHomeSocket.destroyed) return;

  const socket = net.createConnection({
    host: config.virtuHome.host,
    port: config.virtuHome.port
  });

  virtuHomeSocket = socket;
  virtuHomeBuffer = Buffer.alloc(0);
  socket.setNoDelay(true);

  socket.on('connect', () => {
    log(`VirtuHome connectat a ${config.virtuHome.host}:${config.virtuHome.port}`);
    broadcastJson(buildStatus());
  });

  socket.on('data', (chunk) => {
    virtuHomeBuffer = Buffer.concat([virtuHomeBuffer, chunk]);

    while (virtuHomeBuffer.length >= FRAME_BYTES) {
      const frame = Buffer.from(virtuHomeBuffer.subarray(0, FRAME_BYTES));
      virtuHomeBuffer = virtuHomeBuffer.subarray(FRAME_BYTES);

      lastCommandFrame = frame;
      forwardToCodesys(frame);
      broadcastBinary(frame);
      log(`RX VirtuHome -> Bridge (${frame.length} bytes)`);
    }
  });

  socket.on('close', () => {
    log('VirtuHome desconnectat');
    virtuHomeSocket = null;
    broadcastJson(buildStatus());
    setTimeout(connectVirtuHome, config.virtuHome.reconnectMs);
  });

  socket.on('error', (err) => {
    log(`Error VirtuHome: ${err.message}`);
  });
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/status') {
    return json(res, 200, buildStatus());
  }

  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === '/') requestedPath = '/index.html';

  const safePath = path.normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.resolve(path.join(APP_DIR, '.' + safePath));

  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    res.writeHead(200, {
      'Content-Type': getMime(filePath),
      'Cache-Control': 'no-store'
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

httpServer.listen(config.http.port, config.http.host, () => {
  log(`HTTP actiu a http://${config.http.host}:${config.http.port}`);
});

const wss = new WebSocketServer({
  host: config.websocket.host,
  port: config.websocket.port
});

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  log(`WS connectat: ${req.socket.remoteAddress}`);

  ws.send(JSON.stringify(buildStatus()));
  ws.send(lastCodesysFrame, { binary: true });

  ws.on('message', (message, isBinary) => {
    if (!isBinary) {
      const text = message.toString('utf8').trim();
      if (text === 'status') {
        ws.send(JSON.stringify(buildStatus()));
      }
      return;
    }

    const frame = normalizeFrame(message);
    lastCommandFrame = frame;

    forwardToCodesys(frame);
    forwardToVirtuHome(frame);
    broadcastBinary(frame, ws);

    log(`RX HTML -> Bridge (${frame.length} bytes)`);
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    log('WS desconnectat');
  });

  ws.on('error', (err) => {
    log(`Error WS: ${err.message}`);
  });
});

wss.on('listening', () => {
  log(`WebSocket actiu a ws://${config.websocket.host}:${config.websocket.port}`);
});

const tcpServer = net.createServer((socket) => {
  if (codesysSocket && !codesysSocket.destroyed) {
    codesysSocket.destroy();
  }

  codesysSocket = socket;
  let tcpBuffer = Buffer.alloc(0);

  socket.setNoDelay(true);

  log(`CODESYS connectat des de ${socket.remoteAddress}:${socket.remotePort}`);
  broadcastJson(buildStatus());

  if (lastCommandFrame && lastCommandFrame.length === FRAME_BYTES) {
    socket.write(lastCommandFrame);
  }

  socket.on('data', (chunk) => {
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);

    while (tcpBuffer.length >= FRAME_BYTES) {
      const frame = Buffer.from(tcpBuffer.subarray(0, FRAME_BYTES));
      tcpBuffer = tcpBuffer.subarray(FRAME_BYTES);

      lastCodesysFrame = frame;
      broadcastBinary(frame);
      forwardToVirtuHome(frame);

      log(`RX CODESYS -> Bridge (${frame.length} bytes)`);
    }
  });

  socket.on('close', () => {
    if (codesysSocket === socket) {
      codesysSocket = null;
    }
    log('CODESYS desconnectat');
    broadcastJson(buildStatus());
  });

  socket.on('error', (err) => {
    log(`Error TCP CODESYS: ${err.message}`);
  });
});

tcpServer.listen(config.codesys.listenPort, config.codesys.listenHost, () => {
  log(`TCP Bridge escoltant a ${config.codesys.listenHost}:${config.codesys.listenPort}`);
  connectVirtuHome();
});

function shutdown() {
  log('Aturant bridge...');
  try { wss.close(); } catch (_) {}
  try { httpServer.close(); } catch (_) {}
  try { tcpServer.close(); } catch (_) {}
  try { if (codesysSocket) codesysSocket.destroy(); } catch (_) {}
  try { if (virtuHomeSocket) virtuHomeSocket.destroy(); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);