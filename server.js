'use strict';
// Rocket Soccer — static file host + WebSocket matchmaking/relay server.
//
// Model: ONE authority per room (the first player = "host"/slot 0). The host
// client simulates all physics and broadcasts world snapshots. Every other
// player ("guest") only sends its input and renders the host's snapshots.
// The server is a dumb relay + lobby: it never simulates anything.
//
// Rooms hold up to 4 players. Modes: 1v1 (2 players) or 2v2 (4 players).
// Slot assignment is join order (0..N-1). Team = slot % 2 (even = blue/left,
// odd = orange/right), which auto-balances teams for both modes.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const NEED = { '1v1': 2, '2v2': 4 };

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

// code -> { code, mode, players: ws[], started: bool }
const rooms = new Map();
// mode -> ws[] waiting for a quick match
const quickQueues = { '1v1': [], '2v2': [] };

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function addToRoom(room, ws) {
  ws.roomCode = room.code;
  ws.slot = room.players.length;
  ws.isHost = (ws.slot === 0);
  room.players.push(ws);
}

// Tell everyone in the room how many players have joined (lobby progress).
function broadcastRoster(room) {
  for (const p of room.players) {
    send(p, { t: 'roster', room: room.code, mode: room.mode, count: room.players.length, need: NEED[room.mode] });
  }
}

// Room is full -> lock it and tell each player its slot + role.
function startRoom(room) {
  room.started = true;
  room.players.forEach((ws, i) => {
    ws.slot = i; ws.isHost = (i === 0);
    send(ws, { t: 'start', room: room.code, slot: i, isHost: i === 0, mode: room.mode, need: NEED[room.mode] });
  });
}

// Remove a socket from any queue/room. If it was in an active room, the match
// can't continue without every player (the host is the authority), so we end
// it for everyone and drop the room. Simple and glitch-free.
function leaveEverything(ws) {
  for (const k of Object.keys(quickQueues)) {
    const i = quickQueues[k].indexOf(ws);
    if (i >= 0) quickQueues[k].splice(i, 1);
  }
  const room = rooms.get(ws.roomCode);
  if (room && room.players.includes(ws)) {
    for (const p of room.players) {
      if (p !== ws) { send(p, { t: 'peer-left' }); p.roomCode = undefined; p.slot = undefined; p.isHost = undefined; }
    }
    rooms.delete(room.code);
  }
  ws.roomCode = undefined; ws.slot = undefined; ws.isHost = undefined;
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // Create a coded room and wait for it to fill.
    if (m.t === 'host') {
      const mode = (m.mode === '2v2') ? '2v2' : '1v1';
      const code = makeCode();
      const room = { code, mode, players: [], started: false };
      rooms.set(code, room);
      addToRoom(room, ws);
      send(ws, { t: 'wait', room: code, slot: 0, mode, count: 1, need: NEED[mode] });
      return;
    }

    // Join an existing room by code. Auto-starts when full.
    if (m.t === 'join') {
      const code = String(m.room || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'notfound' }); return; }
      if (room.started || room.players.length >= NEED[room.mode]) { send(ws, { t: 'full' }); return; }
      addToRoom(room, ws);
      broadcastRoster(room);
      if (room.players.length === NEED[room.mode]) startRoom(room);
      return;
    }

    // Quick match: queue per mode; form a room once enough players are waiting.
    if (m.t === 'quick') {
      const mode = (m.mode === '2v2') ? '2v2' : '1v1';
      const q = quickQueues[mode];
      if (!q.includes(ws)) q.push(ws);
      if (q.length >= NEED[mode]) {
        const group = q.splice(0, NEED[mode]);
        const room = { code: makeCode(), mode, players: [], started: false };
        rooms.set(room.code, room);
        for (const p of group) addToRoom(room, p);
        startRoom(room);
      } else {
        send(ws, { t: 'queued', mode, count: q.length, need: NEED[mode] });
      }
      return;
    }

    // Back out of a lobby/queue.
    if (m.t === 'cancel') { leaveEverything(ws); return; }

    // Guest input -> forward to host only, tagged with the sender's slot.
    if (m.t === 'input') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started) return;
      m.slot = ws.slot;
      send(room.players[0], m);
      return;
    }

    // Host snapshot -> broadcast to every guest.
    if (m.t === 'snap') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.started || !ws.isHost) return;
      for (const p of room.players) { if (p !== ws) send(p, m); }
      return;
    }

    // Any player asks for a rematch -> nudge the host, which resets the match.
    if (m.t === 'rematch') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      send(room.players[0], { t: 'rematch' });
      return;
    }
  });

  ws.on('close', () => { leaveEverything(ws); });
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log('Rocket Soccer server running:  http://localhost:' + PORT);
});
