const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = {};

function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function broadcast(room, data, excludeWs) {
  const msg = JSON.stringify(data);
  room.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastAll(room, data) {
  const msg = JSON.stringify(data);
  room.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function makeDeck() {
  const suits = ['♠','♥','♦','♣'], ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const d = [];
  for (const s of suits) for (const r of ranks) d.push({ suit: s, rank: r });
  return d.sort(() => Math.random() - 0.5);
}

wss.on('connection', ws => {
  ws.roomCode = null;
  ws.playerId = Math.random().toString(36).slice(2, 8);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;

    if (type === 'CREATE_ROOM') {
      const code = genCode();
      rooms[code] = {
        code, host: ws.playerId,
        bet: payload.bet || 10,
        clients: new Set([ws]),
        players: [{ id: ws.playerId, name: payload.name, chips: payload.chips || 500, ready: false }],
        phase: 'lobby',
        hands: {}, confirmed: {}, round: 0
      };
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: { code, room: sanitize(rooms[code]) } }));
    }

    else if (type === 'JOIN_ROOM') {
      const room = rooms[payload.code];
      if (!room) { ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '找不到房间' } })); return; }
      if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '游戏已开始' } })); return; }
      if (room.players.length >= 10) { ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '房间已满' } })); return; }
      room.clients.add(ws);
      ws.roomCode = payload.code;
      room.players.push({ id: ws.playerId, name: payload.name, chips: payload.chips || 500, ready: false });
      ws.send(JSON.stringify({ type: 'ROOM_JOINED', payload: { room: sanitize(room) } }));
      broadcast(room, { type: 'ROOM_UPDATE', payload: { room: sanitize(room) } }, ws);
    }

    else if (type === 'SET_READY') {
      const room = rooms[ws.roomCode]; if (!room) return;
      const p = room.players.find(p => p.id === ws.playerId);
      if (p) p.ready = true;
      broadcastAll(room, { type: 'ROOM_UPDATE', payload: { room: sanitize(room) } });
    }

    else if (type === 'START_GAME') {
      const room = rooms[ws.roomCode]; if (!room || room.host !== ws.playerId) return;
      if (room.players.length < 2) { ws.send(JSON.stringify({ type: 'ERROR', payload: { msg: '至少需要2人' } })); return; }
      const deck = makeDeck();
      room.hands = {}; room.confirmed = {}; room.phase = 'arrange'; room.round++;
      room.players.forEach(p => { p.ready = false; room.hands[p.id] = deck.splice(0, 5); });
      if (payload && payload.bet) room.bet = payload.bet;
      // send each player their own hand
      room.clients.forEach(ws2 => {
        if (ws2.readyState === WebSocket.OPEN) {
          ws2.send(JSON.stringify({
            type: 'GAME_START',
            payload: { room: sanitize(room), myHand: room.hands[ws2.playerId] }
          }));
        }
      });
    }

    else if (type === 'CONFIRM_HAND') {
      const room = rooms[ws.roomCode]; if (!room) return;
      room.confirmed[ws.playerId] = payload; // { bottom, top, giveup }
      broadcastAll(room, { type: 'CONFIRM_UPDATE', payload: { confirmedIds: Object.keys(room.confirmed), total: room.players.length } });
      if (Object.keys(room.confirmed).length === room.players.length) {
        // settle
        const result = settle(room);
        room.players.forEach(p => p.chips += result.delta[p.id] || 0);
        room.phase = 'result';
        // send full result including all hands
        broadcastAll(room, { type: 'RESULT', payload: { room: sanitize(room), confirmed: room.confirmed, delta: result.delta, vsLog: result.vsLog } });
      }
    }

    else if (type === 'NEXT_ROUND') {
      const room = rooms[ws.roomCode]; if (!room || room.host !== ws.playerId) return;
      const deck = makeDeck();
      room.hands = {}; room.confirmed = {}; room.phase = 'arrange'; room.round++;
      room.players.forEach(p => { p.ready = false; room.hands[p.id] = deck.splice(0, 5); });
      room.clients.forEach(ws2 => {
        if (ws2.readyState === WebSocket.OPEN) {
          ws2.send(JSON.stringify({
            type: 'GAME_START',
            payload: { room: sanitize(room), myHand: room.hands[ws2.playerId] }
          }));
        }
      });
    }

    else if (type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomCode]; if (!room) return;
    room.clients.delete(ws);
    room.players = room.players.filter(p => p.id !== ws.playerId);
    if (room.players.length === 0) { delete rooms[ws.roomCode]; return; }
    if (room.host === ws.playerId && room.players.length > 0) room.host = room.players[0].id;
    broadcastAll(room, { type: 'ROOM_UPDATE', payload: { room: sanitize(room) } });
  });
});

function sanitize(room) {
  return { code: room.code, host: room.host, bet: room.bet, phase: room.phase, round: room.round, players: room.players, confirmedIds: Object.keys(room.confirmed) };
}

const RO = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const PAIR_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function cVal(r) { if (['J','Q','K'].includes(r)) return 10; if (r === 'A') return 1; return parseInt(r); }
function nFlex(c) { const v = cVal(c.rank); if (v === 3) return [3,6]; if (v === 6) return [6,3]; return [v]; }
function isSpadeA(c) { return c.suit === '♠' && c.rank === 'A'; }

function canFormNiu(b3) {
  const f = b3.map(c => nFlex(c));
  for (let i = 0; i < f[0].length; i++) for (let j = 0; j < f[1].length; j++) for (let k = 0; k < f[2].length; k++)
    if ((f[0][i]+f[1][j]+f[2][k]) % 10 === 0) return true;
  return false;
}

function bestNiuTop(t2) {
  const ft = t2.map(c => nFlex(c));
  let best = null;
  for (let ti = 0; ti < ft[0].length; ti++) for (let tj = 0; tj < ft[1].length; tj++) {
    const ts = (ft[0][ti]+ft[1][tj]) % 10;
    if (!best || ts > best.ts || (ts === 0 && best.ts !== 0)) best = { ts };
  }
  return best;
}

function evalHand(b3, t2) {
  const all = [...b3,...t2], ranks = all.map(c => c.rank), suits = all.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const ri = ranks.map(r => RO.indexOf(r)).sort((a,b) => a-b);
  const isStraight = ri[4]-ri[0] === 4 && new Set(ri).size === 5;
  const counts = {}; ranks.forEach(r => counts[r] = (counts[r]||0)+1);
  const cv = Object.values(counts).sort((a,b) => b-a);
  if (cv[0] === 4) return { label:'四支', mult:5, rank:9 };
  if (cv[0] === 3 && cv[1] === 2) return { label:'葫芦', mult:5, rank:8 };
  if (isFlush && isStraight) return { label:'同花顺', mult:5, rank:10 };
  if (isFlush) return { label:'同花', mult:5, rank:6 };
  if (isStraight) return { label:'顺子', mult:5, rank:5 };
  if (!canFormNiu(b3)) return { label:'无牛', mult:0, rank:0, giveup:true };
  if (t2.some(c => isSpadeA(c)) && t2.some(c => ['J','Q','K'].includes(c.rank))) return { label:'牛A特', mult:5, rank:4 };
  if (t2[0].rank === t2[1].rank) return { label:`对${t2[0].rank}`, mult:3, rank:3, pairIdx: PAIR_ORDER.indexOf(t2[0].rank) };
  const nr = bestNiuTop(t2); if (!nr) return { label:'无牛', mult:0, rank:0, giveup:true };
  const nl = nr.ts === 0 ? '牛牛' : `牛${nr.ts}`;
  if (nr.ts === 0) return { label:nl, mult:2, rank:2, niuSub:10 };
  return { label:nl, mult:1, rank:1, niuSub:nr.ts };
}

function cmpH(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank === 3) return (a.pairIdx||0) - (b.pairIdx||0);
  if (a.niuSub !== undefined && b.niuSub !== undefined) return a.niuSub - b.niuSub;
  return 0;
}

function settle(room) {
  const ps = room.players;
  const evals = {};
  ps.forEach(p => {
    const h = room.confirmed[p.id];
    if (!h || h.giveup) evals[p.id] = { label:'放弃', mult:0, rank:0, giveup:true };
    else evals[p.id] = evalHand(h.bottom, h.top);
  });
  const delta = {}; ps.forEach(p => delta[p.id] = 0);
  const vsLog = [];
  for (let i = 0; i < ps.length; i++) for (let j = i+1; j < ps.length; j++) {
    const a = ps[i], b = ps[j], ea = evals[a.id], eb = evals[b.id], c = cmpH(ea, eb);
    if (c > 0) { const pay = room.bet*ea.mult; delta[a.id]+=pay; delta[b.id]-=pay; vsLog.push({ w:a.name, l:b.name, wl:ea.label, pay }); }
    else if (c < 0) { const pay = room.bet*eb.mult; delta[b.id]+=pay; delta[a.id]-=pay; vsLog.push({ w:b.name, l:a.name, wl:eb.label, pay }); }
    else vsLog.push({ w:null, an:a.name, bn:b.name });
  }
  return { delta, vsLog };
}

server.listen(PORT, () => console.log(`牛牛服务器运行在端口 ${PORT}`));
