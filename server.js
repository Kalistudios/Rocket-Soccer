'use strict';
// Rocket Soccer — static file host + WebSocket matchmaking/relay server.
// Pairs two players per room; the host client simulates physics and the
// server just relays host snapshots and guest inputs between the pair.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const full = path.join(__dirname, path.normalize(file).replace(/^([.][.][\\/])+/, ''));
  if (!full.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// rooms: code -> { host: ws|null, guest: ws|null }
const rooms = new Map();
let quickQueue = null; // one waiting quick-match player

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  do { c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function startRoom(code, host, guest) {
  const room = { host, guest };
  rooms.set(code, room);
  host.roomCode = code; host.isHost = true;
  guest.roomCode = code; guest.isHost = false;
  send(host, { t: 'start', room: code, host: true });
  send(guest, { t: 'start', room: code, host: false });
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function peerOf(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return ws.isHost ? room.guest : room.host;
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // Create a new coded room and wait for a guest to join.
    if (m.t === 'host') {
      const code = makeCode();
      rooms.set(code, { host: ws, guest: null });
      ws.roomCode = code; ws.isHost = true;
      send(ws, { t: 'wait', room: code, host: true });
      return;
    }

    // Join an EXISTING coded room only. Never create a room here.
    if (m.t === 'join') {
      const code = String(m.room || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: 'notfound' });
      } else if (room.guest) {
        send(ws, { t: 'full' });
      } else {
        startRoom(code, room.host, ws);
      }
      return;
    }

    // Quick match: pair with a single waiting player, else queue.
    if (m.t === 'quick') {
      if (quickQueue && quickQueue.readyState === 1) {
        const host = quickQueue; quickQueue = null;
        startRoom(makeCode(), host, ws);
      } else {
        quickQueue = ws;
        send(ws, { t: 'queued' });
      }
      return;
    }

    // Leave a waiting state before a match starts.
    if (m.t === 'cancel') {
      if (quickQueue === ws) quickQueue = null;
      const room = rooms.get(ws.roomCode);
      if (room && room.host === ws && !room.guest) {
        rooms.delete(ws.roomCode);
      }
      ws.roomCode = undefined; ws.isHost = undefined;
      return;
    }

    // Relay a rematch request to the peer.
    if (m.t === 'rematch') {
      send(peerOf(ws), { t: 'rematch' });
      return;
    }

    // relay gameplay traffic to the peer
    if (m.t === 'snap' || m.t === 'input') {
      send(peerOf(ws), m);
    }
  });

  ws.on('close', () => {
    if (quickQueue === ws) quickQueue = null;
    const room = rooms.get(ws.roomCode);
    if (room) {
      const peer = ws.isHost ? room.guest : room.host;
      send(peer, { t: 'peer-left' });
      if (peer) peer.roomCode = undefined;
      rooms.delete(ws.roomCode);
    }
  });
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Rocket Soccer server running:  http://localhost:${PORT}`);
  console.log('On your Android phone (same Wi-Fi), open  http://<this-PC-ip>:' + PORT);
});
