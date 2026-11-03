const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const clients = new Map();
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const makeId = (n = 12) => crypto.randomBytes(n).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const bodyOf = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', b => { data += b; if (data.length > 8192) { reject(new Error('请求内容太大')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('请求格式错误')); } });
  req.on('error', reject);
});
function code() {
  let c;
  do { c = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}
function findPlayer(token) {
  for (const room of rooms.values()) {
    const index = room.players.findIndex(p => p.token === token);
    if (index >= 0) return { room, index, player: room.players[index] };
  }
  throw new Error('房间已失效，请重新加入');
}
function view(room, index) {
  const p = room.players[index];
  const revealed = room.phase === 'reveal' || room.phase === 'won';
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    seconds: room.seconds,
    deadline: room.deadline,
    revealUntil: room.revealUntil,
    history: room.history.map((r, i) => ({ round: i + 1, words: r.words, matched: r.matched })),
    winner: room.phase === 'won',
    players: room.players.map((x, i) => ({
      name: x.name, submitted: x.word !== null,
      word: revealed ? x.word : (i === index ? x.word : null),
      isYou: i === index
    })),
    canStart: room.players.length === 2 && room.phase === 'lobby',
    isHost: p.token === room.host
  };
}
function push(room) {
  room.players.forEach((p, i) => {
    const stream = clients.get(p.token);
    if (stream) {
      try { stream.write(`data: ${JSON.stringify(view(room, i))}\n\n`); }
      catch { clients.delete(p.token); }
    }
  });
}
function startRound(room) {
  room.round += 1;
  room.phase = 'writing';
  room.players.forEach(p => { p.word = null; });
  room.deadline = Date.now() + room.seconds * 1000;
  room.revealUntil = null;
  push(room);
}
function checkReveal(room) {
  if (room.phase !== 'writing' || room.players.length !== 2 || !room.players.every(p => p.word !== null)) return;
  const [a, b] = room.players.map(p => p.word.trim().normalize('NFKC').toLocaleLowerCase());
  room.history.push({ words: room.players.map(p => p.word || ''), matched: a.length > 0 && a === b });
  room.phase = a.length > 0 && a === b ? 'won' : 'reveal';
  room.deadline = null;
  room.revealUntil = room.phase === 'reveal' ? Date.now() + 5000 : null;
  push(room);
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
const fail = (res, message, status = 400) => json(res, status, { error: message });
const routes = {
  '/api/create': ({ name, seconds }) => {
    const s = Number(seconds);
    if (![15, 30, 45, 60, 90, 120, 180].includes(s)) throw new Error('请选择有效的思考时间');
    name = clean(name, 18);
    if (!name) throw new Error('请输入昵称');
    const token = makeId();
    const room = { code: code(), host: token, seconds: s, phase: 'lobby', round: 0, history: [],
      deadline: null, revealUntil: null, created: Date.now(), updated: Date.now(),
      players: [{ token, name, word: null }] };
    rooms.set(room.code, room);
    return { token, code: room.code, state: view(room, 0) };
  },
  '/api/join': ({ name, code: rawCode }) => {
    const c = clean(rawCode, 10).toUpperCase();
    name = clean(name, 18);
    if (!name) throw new Error('请输入昵称');
    const room = rooms.get(c);
    if (!room) throw new Error('找不到该房间');
    if (room.players.length !== 1 || room.phase !== 'lobby') throw new Error('这个房间已满或已开局');
    const token = makeId();
    room.players.push({ token, name, word: null }); room.updated = Date.now();
    push(room);
    return { token, code: room.code, state: view(room, 1) };
  },
  '/api/start': ({ token }) => {
    const { room, player } = findPlayer(token);
    if (player.token !== room.host) throw new Error('只有房主可以开始');
    if (room.phase !== 'lobby' || room.players.length !== 2) throw new Error('请等两位玩家进入房间');
    room.updated = Date.now(); startRound(room); return { ok: true };
  },
  '/api/submit': ({ token, word }) => {
    const { room, player } = findPlayer(token);
    if (room.phase !== 'writing') throw new Error('现在不是填写阶段');
    if (player.word !== null) throw new Error('本轮已经提交');
    const w = clean(word, 40);
    if (!w) throw new Error('请输入词语');
    if (Date.now() >= room.deadline) throw new Error('本轮时间已经结束');
    player.word = w; room.updated = Date.now(); push(room); checkReveal(room);
    return { ok: true };
  },
  '/api/replay': ({ token }) => {
    const { room, player } = findPlayer(token);
    if (player.token !== room.host || room.phase !== 'won') throw new Error('只有房主可以重新开局');
    room.round = 0; room.phase = 'lobby'; room.deadline = null; room.revealUntil = null;
    room.players.forEach(p => { p.word = null; });
    room.updated = Date.now(); push(room); return { ok: true };
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    try {
      const token = url.searchParams.get('token');
      const { room, index } = findPlayer(token);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const previous = clients.get(token);
      if (previous) previous.end();
      clients.set(token, res);
      res.write(`data: ${JSON.stringify(view(room, index))}\n\n`);
      req.on('close', () => { if (clients.get(token) === res) clients.delete(token); });
    } catch (err) { fail(res, err.message, 401); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    try { const { room, index } = findPlayer(url.searchParams.get('token')); return json(res, 200, view(room, index)); }
    catch (err) { return fail(res, err.message, 401); }
  }
  if (req.method === 'POST' && routes[url.pathname]) {
    try { return json(res, 200, routes[url.pathname](await bodyOf(req))); }
    catch (err) { return fail(res, err.message); }
  }
  fail(res, '页面不存在', 404);
});

setInterval(() => {
  const now = Date.now();
  for (const [c, room] of rooms) {
    if (room.phase === 'writing' && now >= room.deadline) {
      room.players.forEach(p => { if (p.word === null) p.word = ''; });
      room.updated = now; checkReveal(room);
    }
    if (room.phase === 'reveal' && now >= room.revealUntil) {
      room.updated = now; startRound(room);
    }
    if (now - room.updated > 12 * 60 * 60 * 1000) {
      room.players.forEach(p => { clients.get(p.token)?.end(); clients.delete(p.token); });
      rooms.delete(c);
    }
  }
}, 250);
server.listen(PORT, '0.0.0.0', () => console.log(`Word Sync running on http://localhost:${PORT}`));
