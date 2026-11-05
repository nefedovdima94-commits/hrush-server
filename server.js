// «Хрущевский Беспредел» — минимальный онлайн-сервер (Express + ws)
// HTTP:  GET /, GET /health, GET /online
// Admin: POST /admin/gift, POST /admin/event, GET /admin/players   (заголовок x-admin-key)
// WS:    тот же порт, путь /ws
'use strict';
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) console.warn('[warn] ADMIN_KEY не задан — админ-команды отключены');

const startedAt = Date.now();
/** playerId -> { ws, nick, playerId, connectedAt } */
const online = new Map();
/** playerId -> [gift]  — подарки, ещё не подтверждённые клиентом (в памяти, сбрасываются при рестарте) */
const pendingGifts = new Map();
let activeEvent = null; // { id, name, text, data, startedAt, endsAt }

// ---------- helpers ----------
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const send = (ws, msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const onlineList = () => [...online.values()].map(p => ({ playerId: p.playerId, nick: p.nick, since: p.connectedAt }));
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const p of online.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(s); };
const broadcastOnline = () => broadcast({ type: 'online', players: onlineList() });
const eventIsActive = () => activeEvent && (!activeEvent.endsAt || activeEvent.endsAt > Date.now());

function checkKey(key) {
  if (!ADMIN_KEY || typeof key !== 'string') return false;
  const a = Buffer.from(key), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- admin actions (общие для HTTP и WS) ----------
function giveGift({ playerId, item, qty, money, message }) {
  playerId = clean(playerId, 64);
  if (!playerId) throw new Error('playerId required');
  const gift = {
    giftId: crypto.randomUUID(),
    item: item ? clean(item, 64) : null,
    qty: item ? Math.max(1, Math.min(9999, parseInt(qty, 10) || 1)) : 0,
    money: Math.max(-1e9, Math.min(1e9, Number(money) || 0)),
    message: clean(message, 200),
    at: Date.now(),
  };
  if (!gift.item && !gift.money) throw new Error('item or money required');
  const q = pendingGifts.get(playerId) || [];
  q.push(gift);
  pendingGifts.set(playerId, q.slice(-50));
  const p = online.get(playerId);
  if (p) send(p.ws, { type: 'gift', gift });
  return { delivered: !!p, gift };
}

function startEvent({ name, text, data, durationSec }) {
  name = clean(name, 64);
  if (!name) throw new Error('name required');
  const dur = Math.max(0, Math.min(86400, parseInt(durationSec, 10) || 0));
  activeEvent = {
    id: crypto.randomUUID(), name, text: clean(text, 300),
    data: data && typeof data === 'object' ? data : {},
    startedAt: Date.now(), endsAt: dur ? Date.now() + dur * 1000 : null,
  };
  broadcast({ type: 'event', event: activeEvent });
  return { event: activeEvent, sentTo: online.size };
}

function stopEvent() {
  const was = activeEvent; activeEvent = null;
  broadcast({ type: 'event_end', eventId: was?.id || null });
  return { stopped: !!was };
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.type('text').send(`Хрущевский Беспредел — сервер работает. Онлайн: ${online.size}. WS: /ws`));
app.get('/health', (req, res) => res.json({ ok: true, online: online.size, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));
app.get('/online', (req, res) => res.json({ players: onlineList() }));

const admin = (req, res, next) => checkKey(req.get('x-admin-key')) ? next() : res.status(401).json({ error: 'bad admin key' });
const wrap = fn => (req, res) => { try { res.json({ ok: true, ...fn(req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); } };
app.get('/admin/players', admin, (req, res) => res.json({ players: onlineList(), pending: Object.fromEntries([...pendingGifts].map(([k, v]) => [k, v.length])), event: eventIsActive() ? activeEvent : null }));
app.post('/admin/gift', admin, wrap(giveGift));
app.post('/admin/event', admin, wrap(startEvent));
app.post('/admin/event/stop', admin, wrap(stopEvent));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.player = null;
  ws.msgCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (++ws.msgCount > 30) return; // простой антиспам: ≤30 сообщений за 10 сек
    let m; try { m = JSON.parse(raw); } catch { return send(ws, { type: 'error', error: 'bad json' }); }

    switch (m.type) {
      case 'hello': {
        const playerId = clean(m.playerId, 64) || crypto.randomUUID();
        const nick = clean(m.nick, 24) || 'Жилец';
        const prev = online.get(playerId);
        if (prev && prev.ws !== ws) { send(prev.ws, { type: 'kicked', reason: 'вход с другой вкладки' }); prev.ws.close(); }
        ws.player = { ws, playerId, nick, connectedAt: Date.now() };
        online.set(playerId, ws.player);
        send(ws, { type: 'welcome', playerId, nick, players: onlineList(), event: eventIsActive() ? activeEvent : null });
        for (const gift of pendingGifts.get(playerId) || []) send(ws, { type: 'gift', gift });
        broadcastOnline();
        break;
      }
      case 'list':
        send(ws, { type: 'online', players: onlineList() });
        break;
      case 'gift_ack': { // клиент подтвердил получение подарка
        if (!ws.player) break;
        const q = (pendingGifts.get(ws.player.playerId) || []).filter(g => g.giftId !== m.giftId);
        q.length ? pendingGifts.set(ws.player.playerId, q) : pendingGifts.delete(ws.player.playerId);
        break;
      }
      case 'admin': { // админка прямо из игры: {type:'admin', key, action:'gift'|'event'|'event_stop'|'players', ...}
        if (!checkKey(m.key)) return send(ws, { type: 'admin_result', ok: false, error: 'bad admin key' });
        try {
          const r = m.action === 'gift' ? giveGift(m)
            : m.action === 'event' ? startEvent(m)
            : m.action === 'event_stop' ? stopEvent()
            : m.action === 'players' ? { players: onlineList() }
            : (() => { throw new Error('unknown action'); })();
          send(ws, { type: 'admin_result', ok: true, action: m.action, ...r });
        } catch (e) { send(ws, { type: 'admin_result', ok: false, error: e.message }); }
        break;
      }
      case 'ping':
        send(ws, { type: 'pong', t: Date.now() });
        break;
      default:
        send(ws, { type: 'error', error: 'unknown type' });
    }
  });

  ws.on('close', () => {
    if (ws.player && online.get(ws.player.playerId)?.ws === ws) {
      online.delete(ws.player.playerId);
      broadcastOnline();
    }
  });
});

// heartbeat + сброс антиспама
setInterval(() => {
  for (const ws of wss.clients) {
    ws.msgCount = 0;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 10000);

server.listen(PORT, () => console.log(`hrush-server на порту ${PORT}, WS: /ws`));
