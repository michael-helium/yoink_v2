// Word Game server — mechanics-aligned (final spec)
// Node 18+, Express static for client, Socket.IO for realtime

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

// ===== Config (from your finalized mechanics) =====
const GRID_SIZE = 4;
const MAX_POOL = GRID_SIZE * GRID_SIZE; // 16
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const ROUNDS = 3;
const ROUND_MS = 90_000;
const BREAK_MS = 10_000;

const YOINK_COOLDOWN_MS = 500;

// Rubberband spawn timing: 0/16 -> 0.5s, 15/16 -> 10s, none at 16/16
const INTERVAL_AT_0 = 500;     // ms when 0 tiles present
const INTERVAL_AT_15 = 10_000; // ms when 15 tiles present

// Letter spawn weights (probabilities)
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const WEIGHTS = [9,2,2,4,12,2,3,2,9,1,1,4,2,6,8,2,1,6,4,6,4,2,2,1,2,1];

// Letter values per spec
const VAL10 = new Set(['A','D','E','G','I','L','N','O','R','S','T','U']);
const VAL20 = new Set(['B','C','F','H','K','M','P','V','W','Y']);
const VAL30 = new Set(['J','Q','X','Z']);

function letterValue(L) {
  if (VAL30.has(L)) return 30;
  if (VAL20.has(L)) return 20;
  return 10;
}

// Round multipliers
const ROUND_MULT = [1.0, 1.2, 1.5];

// Dictionary (lowercase). Optional: DICT_PATH to load a word list.
const DICT = new Set([
  // small starter set; replace via DICT_PATH for real play
  'hello','world','stone','mouse','house','quiz','jazz','fuzzy','laser',
  'trail','bread','ratio','index','water','ardent','yoink','glory','blaze'
]);
const DICT_PATH = process.env.DICT_PATH;
if (DICT_PATH && fs.existsSync(DICT_PATH)) {
  try {
    const raw = fs.readFileSync(DICT_PATH, 'utf8');
    let added = 0;
    raw.split(/\r?\n/).forEach(w => {
      const s = w.trim();
      if (!s) return;
      // Proper nouns disallowed: skip capitalized-only entries (basic heuristic)
      if (/^[A-Z][a-z]+$/.test(s)) return;
      DICT.add(s.toLowerCase());
      added++;
    });
    console.log(`Loaded dictionary: +${added} words from ${DICT_PATH}`);
  } catch (e) {
    console.warn('Failed loading dictionary:', e.message);
  }
}

// ===== Helpers =====
function now() { return Date.now(); }

function choiceWeighted() {
  const total = WEIGHTS.reduce((a,b)=>a+b,0);
  let r = Math.floor(Math.random() * total) + 1;
  for (let i = 0; i < LETTERS.length; i++) {
    r -= WEIGHTS[i];
    if (r <= 0) return LETTERS[i];
  }
  return 'E';
}

function spawnIntervalMs(fullnessTiles) {
  if (fullnessTiles >= 16) return null; // no spawns at 16/16
  const f = Math.max(0, Math.min(15, fullnessTiles)); // clamp [0,15]
  // linear interpolation: 0 -> 0.5s, 15 -> 10s
  const t = INTERVAL_AT_0 + (INTERVAL_AT_15 - INTERVAL_AT_0) * (f / 15);
  return Math.round(t);
}

function scoreWord(wordUpper, roundIdx) {
  const base = [...wordUpper].reduce((s,c)=>s + letterValue(c), 0);
  const len = wordUpper.length;
  const lengthBonus = 1 + 0.20 * len; // +20% per letter
  const roundBonus = ROUND_MULT[roundIdx] ?? 1.0;
  return Math.round(base * lengthBonus * roundBonus);
}

// ===== Room state =====
function makeRoom(code) {
  return {
    code,
    hostId: null,
    players: {},   // id -> { name, score, bank:[], lastYoink:0 }
    order: [],     // join order
    pool: [],
    roundIdx: -1,  // before start
    phase: 'lobby',// lobby|playing|intermission|final
    endsAt: 0,
    timers: { spawn: null, round: null, break: null }
  };
}
const rooms = new Map();

function bestLeaderIds(room) {
  let top = -Infinity, leaders = [];
  for (const id of room.order) {
    const p = room.players[id];
    if (!p) continue;
    if (p.score > top) { top = p.score; leaders = [id]; }
    else if (p.score === top) leaders.push(id);
  }
  return leaders;
}

async function broadcast(room) {
  const sockets = await io.in(room.code).fetchSockets();
  const phase = room.phase;
  const leaders = bestLeaderIds(room);
  const leaderboardVisible = (phase === 'intermission' || phase === 'final');

  const base = {
    code: room.code,
    phase,
    roundIdx: room.roundIdx,
    pool: room.pool,
    endsAt: room.endsAt,
    leaderIds: leaders,
    roundMult: ROUND_MULT[room.roundIdx] ?? 1.0
  };

  const scoreboard = leaderboardVisible
    ? room.order.map(id => {
        const p = room.players[id];
        return { id, name: p?.name ?? '—', score: p?.score ?? 0 };
      }).sort((a,b)=>b.score - a.score)
    : null;

  for (const s of sockets) {
    const me = room.players[s.id];
    const players = room.order.map(id => {
      const p = room.players[id];
      return { id, name: p?.name ?? '—', score: leaderboardVisible ? (p?.score ?? 0) : null };
    });

    s.emit('state', {
      ...base,
      players,
      my: { id: s.id, name: me?.name ?? '', bank: me?.bank ?? [], score: leaderboardVisible ? (me?.score ?? 0) : null },
      leaderboard: scoreboard
    });
  }
}

function prefillPool(room) {
  room.pool = [];
  for (let i = 0; i < MAX_POOL; i++) room.pool.push(choiceWeighted());
}

function scheduleSpawn(room) {
  clearTimeout(room.timers.spawn);
  if (room.phase !== 'playing') return;

  const interval = spawnIntervalMs(room.pool.length);
  if (interval == null) {
    // pool full; recheck later to keep loop alive
    room.timers.spawn = setTimeout(() => scheduleSpawn(room), INTERVAL_AT_15);
    return;
  }

  room.timers.spawn = setTimeout(() => {
    if (room.phase === 'playing' && room.pool.length < MAX_POOL) {
      room.pool.push(choiceWeighted());
      broadcast(room);
    }
    scheduleSpawn(room);
  }, interval);
}

function startRound(room) {
  room.roundIdx += 1;
  if (room.roundIdx >= ROUNDS) {
    room.phase = 'final';
    room.endsAt = 0;
    clearTimeout(room.timers.spawn);
    clearTimeout(room.timers.round);
    clearTimeout(room.timers.break);
    broadcast(room);
    return;
  }
  // reset per-round
  for (const id of room.order) {
    const p = room.players[id];
    if (p) p.bank = []; // no carryover
  }
  prefillPool(room);
  room.phase = 'playing';
  room.endsAt = now() + ROUND_MS;

  clearTimeout(room.timers.round);
  room.timers.round = setTimeout(() => intermission(room), ROUND_MS);

  scheduleSpawn(room);
  broadcast(room);
}

function intermission(room) {
  room.phase = (room.roundIdx === ROUNDS - 1) ? 'final' : 'intermission';
  room.endsAt = (room.phase === 'final') ? 0 : now() + BREAK_MS;

  clearTimeout(room.timers.spawn);
  clearTimeout(room.timers.round);

  broadcast(room);

  if (room.phase === 'final') return;
  clearTimeout(room.timers.break);
  room.timers.break = setTimeout(() => startRound(room), BREAK_MS);
}

// ===== Socket handlers =====
io.on('connection', (socket) => {
  socket.on('create_or_join', ({ roomCode, name }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const playerName = (name || '').trim().slice(0, 24) || 'Player';
    if (!code) return;

    if (!rooms.has(code)) rooms.set(code, makeRoom(code));
    const room = rooms.get(code);

    if (room.phase !== 'lobby' && !room.players[socket.id]) {
      socket.emit('error_msg', 'Game already started.');
      return;
    }
    if (!room.players[socket.id]) {
      if (room.order.length >= MAX_PLAYERS) {
        socket.emit('error_msg', 'Room is full.');
        return;
      }
      room.players[socket.id] = { name: playerName, score: 0, bank: [], lastYoink: 0 };
      room.order.push(socket.id);
      if (!room.hostId) room.hostId = socket.id;
    }
    socket.join(code);
    broadcast(room);
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.phase !== 'lobby') return;
    if (room.order.length < MIN_PLAYERS) {
      socket.emit('error_msg', 'Need at least 2 players.');
      return;
    }
    startRound(room);
  });

  socket.on('yoink', ({ roomCode, poolIndex }) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room || room.phase !== 'playing') return;
    const me = room.players[socket.id];
    if (!me) return;

    // cooldown
    const t = now();
    if (t - (me.lastYoink || 0) < YOINK_COOLDOWN_MS) return;

    if (me.bank.length >= 7) {
      socket.emit('error_msg', 'Your bank is full.');
      return;
    }
    if (typeof poolIndex !== 'number' || poolIndex < 0 || poolIndex >= room.pool.length) return;

    const letter = room.pool[poolIndex];
    room.pool.splice(poolIndex, 1);
    me.bank.push(letter);
    me.lastYoink = t;

    // visual ping for others (ephemeral)
    io.to(room.code).emit('yoink_fx', { id: socket.id, name: me.name, letter, at: poolIndex });

    scheduleSpawn(room);
    broadcast(room);
  });

  socket.on('submit_word', ({ roomCode, consumeIndices }) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room || room.phase !== 'playing') return;
    const me = room.players[socket.id];
    if (!me) return;

    if (!Array.isArray(consumeIndices) || consumeIndices.length < 2 || consumeIndices.length > 7) {
      socket.emit('invalid_word', { reason: 'Word must be 2–7 letters.' });
      return;
    }

    const bank = me.bank;
    for (const idx of consumeIndices) {
      if (typeof idx !== 'number' || idx < 0 || idx >= bank.length) {
        socket.emit('invalid_word', { reason: 'Invalid selection.' });
        return;
      }
    }
    const word = consumeIndices.map(i => bank[i]).join('');
    const wLower = word.toLowerCase();

    if (!DICT.has(wLower)) {
      socket.emit('invalid_word', { word, reason: 'Not in dictionary.' });
      return;
    }

    const gained = scoreWord(word.toUpperCase(), room.roundIdx);
    me.score += gained;

    // consume used letters (descending indices)
    [...consumeIndices].sort((a,b)=>b-a).forEach(i => bank.splice(i,1));

    socket.emit('valid_word', { word: word.toUpperCase(), points: gained });
    broadcast(room);
  });

  socket.on('clear_word', () => { /* client-side UX only */ });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (!room.players[socket.id]) continue;

      delete room.players[socket.id];
      room.order = room.order.filter(id => id !== socket.id);
      if (room.hostId === socket.id) room.hostId = room.order[0] || null;

      if (room.order.length === 0) {
        clearTimeout(room.timers.spawn);
        clearTimeout(room.timers.round);
        clearTimeout(room.timers.break);
        rooms.delete(code);
      } else {
        broadcast(room);
      }
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));
