// «Хрущевский Беспредел» — онлайн-сервер (Express + ws)
// HTTP:  GET /, GET /health, GET /online, GET /auction
// Admin: POST /admin/gift|event|event/stop|tp|kick|broadcast|warn|unwarn|ban|unban|promo|promo/delete|drop|auction/remove
//        GET  /admin/players, GET /admin/bans, GET /admin/promos
// WS /ws: hello, list, gift_ack, admin, ping, peer (пересылка игрок→игрок),
//         set_title, auc_get, auc_list, auc_bid, auc_buy, auc_cancel, pvp_challenge, pvp_accept, pvp_decline, promo,
//         chat, clan_*, board_push/board_get, assist_*
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const AUTO_BAN_WARNS = Math.max(0, parseInt(process.env.AUTO_BAN_WARNS || '3', 10));   // 0 = выкл
const AUC_FEE = Math.max(0, Math.min(0.5, Number(process.env.AUC_FEE ?? 0.05)));       // комиссия аукциона
if (!ADMIN_KEY) console.warn('[warn] ADMIN_KEY не задан — админ-команды отключены');

const startedAt = Date.now();
/** playerId -> { ws, nick, playerId, connectedAt, title, lvl, ip } */
const online = new Map();

// ---------- persistent state (JSON-файл; на Render Free живёт до рестарта/редеплоя) ----------
const DB = {
  epoch: crypto.randomUUID(),   // меняется, если данные потеряны → клиенты возвращают себе эскроу
  pendingGifts: {},             // playerId -> [gift]
  lots: {},                     // lotId -> lot
  bans: {},                     // playerId -> { reason, until|null, ip|null, nick, at }
  warns: {},                    // playerId -> [{ reason, at }]
  promos: {},                   // CODE -> { code, money, item, qty, uses, used, until, message, by: {playerId: at} }
  known: {},                    // playerId -> { nick, ip, lastSeen }
  duels: {},                    // duelId -> открытый вызов (ставка вызвавшего в эскроу)
  clans: {},                    // clanId -> { id, name, tag, leader, members: {pid: nick}, created }
  clanOf: {},                   // playerId -> clanId
  boards: { rich: {}, kills: {} }, // playerId -> { nick, v, at }
  chat: [],                     // последние сообщения общего чата
};
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const k of Object.keys(DB)) if (raw[k] && typeof raw[k] === typeof DB[k]) DB[k] = raw[k];
  console.log('[db] загружено из', DATA_FILE, 'лотов', Object.keys(DB.lots).length, 'банов', Object.keys(DB.bans).length, 'промо', Object.keys(DB.promos).length);
} catch (_) { console.log('[db] новый, epoch', DB.epoch); }
let saveT = null;
function persist() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch (e) { console.warn('[db] save fail', e.message); }
  }, 500);
}
const pendingGifts = {
  get: id => DB.pendingGifts[id],
  set: (id, v) => { DB.pendingGifts[id] = v; persist(); },
  delete: id => { delete DB.pendingGifts[id]; persist(); },
  entries: () => Object.entries(DB.pendingGifts),
};
let activeEvent = null; // { id, name, text, data, startedAt, endsAt, nextDropAt }

// ---------- helpers ----------
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const int = (v, lo, hi, def = 0) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
const num = (v, lo, hi, def = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
const send = (ws, msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const onlineList = () => [...online.values()].map(p => ({
  playerId: p.playerId, nick: p.nick, since: p.connectedAt, title: p.title || '', lvl: p.lvl || 0,
  clanId: p.clanId || DB.clanOf[p.playerId] || '', clanTag: (DB.clans[p.clanId || DB.clanOf[p.playerId] || ''] || {}).tag || '',
  money: p.money || 0, kills: p.kills || 0,
}));
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const p of online.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(s); };
const broadcastOnline = () => broadcast({ type: 'online', players: onlineList() });
const eventIsActive = () => activeEvent && (!activeEvent.endsAt || activeEvent.endsAt > Date.now());
const nickOf = id => online.get(id)?.nick || DB.known[id]?.nick || '?';
const FEATURES = ['peer', 'auction', 'pvp', 'promo', 'mod', 'drop', 'title', 'chat', 'clan', 'board', 'assist'];

function checkKey(key) {
  if (!ADMIN_KEY || typeof key !== 'string') return false;
  const a = Buffer.from(key), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = clean(it.id, 64); if (!id) return null;
  return { id, c: int(it.c, 1, 9999, 1), l: int(it.l, 1, 999, 1), d: it.d == null ? null : int(it.d, 0, 1e6, 0), name: clean(it.name, 48) };
}

// ---------- gifts (доставка от сервера; переживают офлайн) ----------
function deliver(playerId, g) {
  const gift = {
    giftId: crypto.randomUUID(),
    item: g.item ? clean(g.item, 64) : null,
    qty: g.item ? int(g.qty, 1, 9999, 1) : 0,
    lvl: g.lvl ? int(g.lvl, 1, 999, 1) : undefined,
    dur: g.dur != null ? int(g.dur, 0, 1e6, 0) : undefined,
    money: num(g.money, -1e12, 1e12, 0),
    title: g.title ? clean(g.title, 32) : undefined,
    force: g.force ? 1 : undefined,
    meta: g.meta || undefined,
    message: clean(g.message, 200),
    at: Date.now(),
  };
  const q = pendingGifts.get(playerId) || [];
  q.push(gift);
  pendingGifts.set(playerId, q.slice(-100));
  const p = online.get(playerId);
  if (p) send(p.ws, { type: 'gift', gift });
  return { delivered: !!p, gift };
}

// ---------- admin actions ----------
function giveGift({ playerId, item, qty, money, message, title }) {
  playerId = clean(playerId, 64);
  if (!playerId) throw new Error('playerId required');
  if (!item && !Number(money) && !title) throw new Error('item, money or title required');
  return deliver(playerId, { item, qty, money, message, title });
}

function cleanPool(arr) { return (Array.isArray(arr) ? arr : String(arr || '').split(/[\s,;]+/)).map(x => clean(x, 64)).filter(Boolean).slice(0, 60); }
function startEvent({ name, text, data, durationSec }) {
  name = clean(name, 64);
  if (!name) throw new Error('name required');
  const dur = int(durationSec, 0, 86400, 0);
  const d = data && typeof data === 'object' ? { ...data } : {};
  if (d.drop) {
    const pool = cleanPool(d.drop.items);
    d.drop = pool.length ? { items: pool, everySec: int(d.drop.everySec, 30, 3600, 120), chance: num(d.drop.chance, 0.01, 1, 0.5), qty: int(d.drop.qty, 1, 20, 1) } : undefined;
    if (!d.drop) delete d.drop;
  }
  activeEvent = {
    id: crypto.randomUUID(), name, text: clean(text, 300), data: d,
    startedAt: Date.now(), endsAt: dur ? Date.now() + dur * 1000 : null,
    nextDropAt: d.drop ? Date.now() + d.drop.everySec * 1000 : null,
  };
  broadcast({ type: 'event', event: activeEvent });
  return { event: activeEvent, sentTo: online.size };
}
function stopEvent() {
  const was = activeEvent; activeEvent = null;
  broadcast({ type: 'event_end', eventId: was?.id || null });
  return { stopped: !!was };
}
function dropNow({ items, qty, message }) {
  const pool = cleanPool(items);
  if (!pool.length) throw new Error('items required');
  let n = 0;
  for (const p of online.values()) {
    if (isBanned(p.playerId, p.ip)) continue;
    deliver(p.playerId, { item: pool[Math.floor(Math.random() * pool.length)], qty: int(qty, 1, 20, 1), force: 1, meta: { k: 'drop' }, message: clean(message, 120) || '🎁 Сундук от админа' });
    n++;
  }
  return { sentTo: n };
}
function eventDropTick() {
  if (!activeEvent) return;
  if (activeEvent.endsAt && activeEvent.endsAt <= Date.now()) { activeEvent = null; return; }
  const dr = activeEvent.data && activeEvent.data.drop;
  if (!dr || !activeEvent.nextDropAt || Date.now() < activeEvent.nextDropAt) return;
  activeEvent.nextDropAt = Date.now() + dr.everySec * 1000;
  for (const p of online.values()) {
    if (isBanned(p.playerId, p.ip) || Math.random() > dr.chance) continue;
    deliver(p.playerId, { item: dr.items[Math.floor(Math.random() * dr.items.length)], qty: dr.qty, force: 1, meta: { k: 'drop', ev: activeEvent.id }, message: '🎁 Дроп ивента «' + activeEvent.name + '»' });
  }
}

function tpPlayer({ playerId, node, message }) {
  playerId = clean(playerId, 64); node = clean(node, 64);
  if (!playerId) throw new Error('playerId required');
  if (!node) throw new Error('node required');
  const p = online.get(playerId);
  if (!p) throw new Error('player offline');
  send(p.ws, { type: 'tp', node, message: clean(message, 200) });
  return { delivered: true, playerId, node };
}
function kickPlayer({ playerId, reason }) {
  playerId = clean(playerId, 64);
  if (!playerId) throw new Error('playerId required');
  const p = online.get(playerId);
  if (!p) throw new Error('player offline');
  const why = clean(reason, 200) || 'кикнут админом';
  send(p.ws, { type: 'kicked', reason: why });
  try { p.ws.close(); } catch (_) {}
  online.delete(playerId);
  broadcastOnline();
  return { kicked: true, playerId, reason: why };
}
function broadcastSys({ text }) {
  text = clean(text, 300);
  if (!text) throw new Error('text required');
  broadcast({ type: 'sys', text });
  return { sentTo: online.size, text };
}

// ---------- ⚠️ варны / 🚫 баны ----------
function isBanned(playerId, ip) {
  const now = Date.now();
  for (const [id, b] of Object.entries(DB.bans)) {
    if (b.until && b.until <= now) { delete DB.bans[id]; persist(); continue; }
    if (id === playerId || (b.ip && ip && b.ip === ip)) return b;
  }
  return null;
}
function banPlayer({ playerId, minutes, reason, byIp }) {
  playerId = clean(playerId, 64);
  if (!playerId) throw new Error('playerId required');
  const min = int(minutes, 0, 525600, 0);
  const ip = byIp ? (online.get(playerId)?.ip || DB.known[playerId]?.ip || null) : null;
  const b = { reason: clean(reason, 200) || 'нарушение правил', until: min ? Date.now() + min * 60000 : null, ip, nick: nickOf(playerId), at: Date.now() };
  DB.bans[playerId] = b; persist();
  const kicked = [];
  for (const p of [...online.values()]) {
    if (p.playerId === playerId || (ip && p.ip === ip)) {
      send(p.ws, { type: 'banned', reason: b.reason, until: b.until });
      try { p.ws.close(); } catch (_) {}
      online.delete(p.playerId); kicked.push(p.playerId);
    }
  }
  if (kicked.length) broadcastOnline();
  return { banned: playerId, ban: b, kicked };
}
function unbanPlayer({ playerId }) {
  playerId = clean(playerId, 64);
  const was = !!DB.bans[playerId]; delete DB.bans[playerId]; persist();
  return { unbanned: playerId, was };
}
function warnPlayer({ playerId, reason }) {
  playerId = clean(playerId, 64);
  if (!playerId) throw new Error('playerId required');
  const w = { reason: clean(reason, 200) || 'нарушение правил', at: Date.now() };
  const list = (DB.warns[playerId] = (DB.warns[playerId] || []).concat(w).slice(-20)); persist();
  const p = online.get(playerId);
  if (p) send(p.ws, { type: 'warned', reason: w.reason, count: list.length, limit: AUTO_BAN_WARNS });
  let autoBan = null;
  if (AUTO_BAN_WARNS && list.length >= AUTO_BAN_WARNS) autoBan = banPlayer({ playerId, minutes: 1440, reason: 'автобан: ' + list.length + ' варна (' + w.reason + ')' }).ban;
  return { warned: playerId, count: list.length, delivered: !!p, autoBan };
}
function unwarnPlayer({ playerId }) { playerId = clean(playerId, 64); delete DB.warns[playerId]; persist(); return { unwarned: playerId }; }
function bansList() {
  isBanned('', ''); // чистка истёкших
  const known = Object.entries(DB.known).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 60).map(([id, k]) => ({ playerId: id, nick: k.nick, lastSeen: k.lastSeen, online: online.has(id), warns: (DB.warns[id] || []).length }));
  return { bans: DB.bans, warns: DB.warns, known, autoBanWarns: AUTO_BAN_WARNS };
}

// ---------- 🎟 промокоды ----------
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9А-ЯЁ_-]/g, '').slice(0, 24);
function promoCreate({ code, money, item, qty, uses, minutes, message, title }) {
  code = normCode(code);
  if (code.length < 3) throw new Error('код: 3-24 символа (буквы/цифры/_-)');
  const pr = { code, money: num(money, 0, 1e12, 0), item: item ? clean(item, 64) : null, qty: int(qty, 1, 9999, 1), title: title ? clean(title, 32) : null,
    uses: int(uses, 0, 1e6, 0), used: 0, until: int(minutes, 0, 525600, 0) ? Date.now() + int(minutes, 0, 525600, 0) * 60000 : null,
    message: clean(message, 120), by: {}, at: Date.now() };
  if (!pr.money && !pr.item && !pr.title) throw new Error('нужны деньги, предмет или титул');
  DB.promos[code] = pr; persist();
  return { promo: { ...pr, by: undefined } };
}
function promoDelete({ code }) { code = normCode(code); const was = !!DB.promos[code]; delete DB.promos[code]; persist(); return { deleted: code, was }; }
function promoList() { return { promos: Object.values(DB.promos).map(p => ({ ...p, by: undefined, players: Object.keys(p.by || {}).length })) }; }
function promoUse(playerId, code) {
  code = normCode(code);
  const pr = DB.promos[code];
  if (!pr) throw new Error('такого кода нет');
  if (pr.until && pr.until < Date.now()) throw new Error('код истёк');
  if (pr.uses && pr.used >= pr.uses) throw new Error('код закончился');
  if (pr.by[playerId]) throw new Error('ты уже активировал этот код');
  pr.by[playerId] = Date.now(); pr.used++; persist();
  deliver(playerId, { money: pr.money, item: pr.item, qty: pr.qty, title: pr.title, force: 1, meta: { k: 'promo', code }, message: '🎟 Промокод ' + code + (pr.message ? ': ' + pr.message : '') });
  return { code, money: pr.money, item: pr.item, qty: pr.qty, title: pr.title };
}

// ---------- 🏷 аукцион ----------
// Клиент сам снимает вещь/деньги (эскроу) и шлёт запрос с reqId; при ok:false — возвращает себе.
// Всё, что происходит потом (перебили ставку, продано, истёк срок), сервер доставляет подарком (gift.meta).
const lotPublic = l => ({ id: l.id, seller: l.seller, sellerNick: l.sellerNick, sellerTitle: l.sellerTitle || '', item: l.item, buyout: l.buyout, start: l.start, bid: l.bid ? { pid: l.bid.pid, nick: l.bid.nick, amount: l.bid.amount } : null, bids: l.bids || 0, endsAt: l.endsAt, createdAt: l.createdAt });
const lotsPublic = () => Object.values(DB.lots).sort((a, b) => a.endsAt - b.endsAt).slice(0, 300).map(lotPublic);
const minNext = l => l.bid ? l.bid.amount + Math.max(1, Math.ceil(l.bid.amount * 0.05)) : l.start;
const broadcastLots = () => broadcast({ type: 'auc_lots', lots: lotsPublic(), epoch: DB.epoch });
const iname = it => (it.name || it.id) + (it.c > 1 ? ' ×' + it.c : '');
function giveItem(pid, it, meta, message) { return deliver(pid, { item: it.id, qty: it.c, lvl: it.l, dur: it.d, force: 1, meta, message }); }
function settleLot(l, why) {
  delete DB.lots[l.id]; persist();
  if (l.bid) {
    const fee = Math.floor(l.bid.amount * AUC_FEE);
    giveItem(l.bid.pid, l.item, { k: 'auc_won', lotId: l.id }, '🏷 Аукцион: ты купил ' + iname(l.item) + ' у ' + l.sellerNick + ' за ' + l.bid.amount + ' ₽');
    deliver(l.seller, { money: l.bid.amount - fee, meta: { k: 'auc_sold', lotId: l.id }, message: '🏷 Продано: ' + iname(l.item) + ' → ' + l.bid.nick + ' за ' + l.bid.amount + ' ₽' + (fee ? ' (комиссия ' + fee + ' ₽)' : '') });
  } else {
    giveItem(l.seller, l.item, { k: 'auc_return', lotId: l.id }, '🏷 Лот вернулся: ' + iname(l.item) + ' (' + (why || 'никто не купил') + ')');
  }
  broadcastLots();
}
function aucList(pl, m) {
  const it = cleanItem(m.item); if (!it) throw new Error('нет вещи');
  const buyout = int(m.buyout, 0, 1e12, 0), start = int(m.start, 0, 1e12, 0);
  if (!buyout && !start) throw new Error('укажи цену');
  if (buyout && start && start > buyout) throw new Error('стартовая ставка больше цены выкупа');
  const mine = Object.values(DB.lots).filter(l => l.seller === pl.playerId).length;
  if (mine >= 10) throw new Error('максимум 10 лотов на игрока');
  const l = { id: 'L' + crypto.randomUUID().slice(0, 8), seller: pl.playerId, sellerNick: pl.nick, sellerTitle: pl.title || '', item: it,
    buyout, start: start || buyout, bid: null, bids: 0, createdAt: Date.now(), endsAt: Date.now() + int(m.durMin, 5, 2880, 60) * 60000 };
  DB.lots[l.id] = l; persist(); broadcastLots();
  return { lot: lotPublic(l) };
}
function aucBid(pl, m, buy) {
  const l = DB.lots[clean(m.lotId, 32)];
  if (!l || l.endsAt <= Date.now()) throw new Error('лот уже закрыт');
  if (l.seller === pl.playerId) throw new Error('свой лот нельзя');
  const amount = int(m.amount, 1, 1e12, 0);
  if (buy) { if (!l.buyout) throw new Error('у лота нет цены выкупа'); if (amount !== l.buyout) throw new Error('цена изменилась'); }
  else {
    if (l.bid && l.bid.pid === pl.playerId) throw new Error('твоя ставка и так лидирует');
    if (amount < minNext(l)) throw new Error('минимальная ставка ' + minNext(l) + ' ₽');
    if (l.buyout && amount >= l.buyout) buy = true;
  }
  const prev = l.bid;
  if (prev) deliver(prev.pid, { money: prev.amount, meta: { k: 'auc_refund', lotId: l.id }, message: '🏷 Твою ставку на ' + iname(l.item) + ' перебил ' + pl.nick + ' — ' + prev.amount + ' ₽ вернулись' });
  l.bid = { pid: pl.playerId, nick: pl.nick, amount }; l.bids++;
  if (buy) { settleLot(l); return { bought: true, lotId: l.id, amount }; }
  if (l.endsAt - Date.now() < 60000) l.endsAt = Date.now() + 60000; // анти-снайп
  persist(); broadcastLots();
  const s = online.get(l.seller); if (s) send(s.ws, { type: 'sys', text: '🏷 Ставка ' + amount + ' ₽ на твой лот ' + iname(l.item) + ' от ' + pl.nick });
  return { bid: amount, lotId: l.id };
}
function aucCancel(pl, m, adminWhy) {
  const l = DB.lots[clean(m.lotId, 32)];
  if (!l) throw new Error('лот не найден');
  if (!adminWhy) { if (l.seller !== pl.playerId) throw new Error('не твой лот'); if (l.bid) throw new Error('уже есть ставка — снять нельзя'); }
  if (l.bid) deliver(l.bid.pid, { money: l.bid.amount, meta: { k: 'auc_refund', lotId: l.id }, message: '🏷 Лот ' + iname(l.item) + ' снят — ' + l.bid.amount + ' ₽ вернулись' });
  l.bid = null;
  settleLot(l, adminWhy || 'снят с продажи');
  return { cancelled: l.id };
}
function aucTick() { const now = Date.now(); for (const l of Object.values(DB.lots)) if (l.endsAt <= now) settleLot(l); }

// ---------- ⚔️ PvP на ставку ----------
// duelId -> { id, a:{pid,nick,st}, b:{pid,nick}, stake, at } — хранится в DB, чтобы ставка не пропала при рестарте
const duels = {
  get: id => DB.duels[id], set: (id, d) => { DB.duels[id] = d; persist(); }, delete: id => { delete DB.duels[id]; persist(); },
  values: () => Object.values(DB.duels),
};
function cleanStats(s, nick, title) {
  s = s && typeof s === 'object' ? s : {};
  const tac = ['agr', 'bal', 'def'].includes(s.tac) ? s.tac : 'bal';
  return { nick, title: title || '', lvl: int(s.lvl, 1, 9999, 1), hp: int(s.hp, 10, 1e6, 100), dmg: int(s.dmg, 1, 1e6, 5), arm: int(s.arm, 0, 1e5, 0),
    crit: num(s.crit, 0, 0.6, 0.05), dodge: num(s.dodge, 0, 0.4, 0.05), wpn: clean(s.wpn, 40) || 'кулаки', tac };
}
function simulate(A, B) {
  const T = { agr: { d: 1.25, a: 0.8, e: 0 }, bal: { d: 1, a: 1, e: 0 }, def: { d: 0.85, a: 1.3, e: 0.05 } };
  const f = [A, B].map(s => ({ ...s, cur: s.hp, d: s.dmg * T[s.tac].d, a: s.arm * T[s.tac].a, e: Math.min(0.5, s.dodge + T[s.tac].e) }));
  const log = []; let t = Math.random() < 0.5 ? 0 : 1, round = 0;
  while (round < 40 && f[0].cur > 0 && f[1].cur > 0) {
    const at = f[t], df = f[1 - t]; round++;
    if (Math.random() < df.e) log.push({ r: round, w: t, miss: 1 });
    else {
      let d = at.d * (0.8 + Math.random() * 0.4); const crit = Math.random() < at.crit; if (crit) d *= 2;
      d = Math.max(1, Math.floor(d - df.a * 0.6)); df.cur = Math.max(0, df.cur - d);
      log.push({ r: round, w: t, d, crit: crit ? 1 : 0, hp: df.cur });
    }
    t = 1 - t;
  }
  let win = f[0].cur <= 0 ? 1 : f[1].cur <= 0 ? 0 : (f[0].cur / f[0].hp >= f[1].cur / f[1].hp ? 0 : 1);
  return { win, log, hpLeft: [f[0].cur, f[1].cur] };
}
function duelCancel(d, why, notify) {
  duels.delete(d.id);
  if (d.stake) deliver(d.a.pid, { money: d.stake, meta: { k: 'pvp_refund', duelId: d.id }, message: '⚔️ Дуэль отменена (' + why + ') — ставка ' + d.stake + ' ₽ вернулась' });
  for (const pid of notify || [d.a.pid, d.b.pid]) { const p = online.get(pid); if (p) send(p.ws, { type: 'pvp_cancel', duelId: d.id, reason: why }); }
}
function pvpChallenge(pl, m) {
  const to = clean(m.to, 64); const t = online.get(to);
  if (!t) throw new Error('игрок не в сети');
  if (to === pl.playerId) throw new Error('сам с собой нельзя');
  for (const d of duels.values()) if (d.a.pid === pl.playerId) throw new Error('у тебя уже есть открытый вызов');
  const d = { id: 'D' + crypto.randomUUID().slice(0, 8), a: { pid: pl.playerId, nick: pl.nick, st: cleanStats(m.stats, pl.nick, pl.title) }, b: { pid: to, nick: t.nick }, stake: int(m.stake, 0, 1e12, 0), at: Date.now(), msg: clean(m.msg, 80) };
  duels.set(d.id, d);
  send(t.ws, { type: 'pvp_inv', duel: { id: d.id, from: pl.playerId, fromNick: pl.nick, stake: d.stake, stats: d.a.st, msg: d.msg, expiresAt: d.at + 90000 } });
  return { duelId: d.id, stake: d.stake };
}
function pvpAccept(pl, m) {
  const d = duels.get(clean(m.duelId, 32));
  if (!d || d.b.pid !== pl.playerId) throw new Error('вызов уже неактуален');
  const stake = int(m.stake, 0, 1e12, 0);
  if (stake !== d.stake) throw new Error('ставка не совпадает');
  if (!online.has(d.a.pid)) { duelCancel(d, 'вызвавший вышел', [d.a.pid]); throw new Error('вызвавший вышел из сети'); }
  duels.delete(d.id);
  const B = cleanStats(m.stats, pl.nick, pl.title);
  const r = simulate(d.a.st, B);
  const winner = r.win === 0 ? d.a : { pid: pl.playerId, nick: pl.nick };
  const loser = r.win === 0 ? { pid: pl.playerId, nick: pl.nick } : d.a;
  const res = { type: 'pvp_result', duelId: d.id, stake: d.stake, a: d.a.st, b: B, aId: d.a.pid, bId: pl.playerId, win: r.win, winnerId: winner.pid, log: r.log, hpLeft: r.hpLeft };
  for (const pid of [d.a.pid, pl.playerId]) { const p = online.get(pid); if (p) send(p.ws, res); }
  if (d.stake) deliver(winner.pid, { money: d.stake * 2, meta: { k: 'pvp_win', duelId: d.id }, message: '⚔️ Победа над ' + loser.nick + '! Банк дуэли: ' + d.stake * 2 + ' ₽' });
  if (d.stake >= 10000) broadcast({ type: 'sys', text: '⚔️ ' + winner.nick + ' победил ' + loser.nick + ' в дуэли на ' + d.stake + ' ₽!' });
  return { duelId: d.id, win: r.win };
}
function pvpDecline(pl, m) {
  const d = duels.get(clean(m.duelId, 32));
  if (!d || (d.b.pid !== pl.playerId && d.a.pid !== pl.playerId)) throw new Error('вызов уже неактуален');
  duelCancel(d, d.a.pid === pl.playerId ? 'отозван' : pl.nick + ' отказался');
  return { duelId: d.id };
}
function duelTick() { const now = Date.now(); for (const d of duels.values()) if (now - d.at > 90000) duelCancel(d, 'не ответили за 90 с'); }

// ---------- повтор запросов (reqId) — идемпотентность при переподключении ----------
const reqCache = new Map();
function handleReq(ws, m, fn) {
  const reqId = clean(m.reqId, 48);
  const key = ws.player.playerId + '|' + reqId;
  if (reqId && reqCache.has(key)) return send(ws, reqCache.get(key));
  let out;
  try { out = { type: 'req', reqId, op: m.type, ok: true, ...fn() }; }
  catch (e) { out = { type: 'req', reqId, op: m.type, ok: false, error: e.message }; }
  if (reqId) { reqCache.set(key, out); if (reqCache.size > 5000) reqCache.delete(reqCache.keys().next().value); }
  send(ws, out);
}


// ---------- 💬 чат · 🏴 кланы · 🏆 рейтинги · 🆘 помощь в бою ----------
const CHAT_MAX = 80;
const assists = new Map(); // assistId -> fight

function pushChat(room, from, nick, text, clanId) {
  const msg = { id: crypto.randomUUID(), room, from, nick, text: clean(text, 200), clanId: clanId || '', at: Date.now() };
  if (room === 'global') {
    DB.chat.push(msg); if (DB.chat.length > CHAT_MAX) DB.chat = DB.chat.slice(-CHAT_MAX); persist();
    broadcast({ type: 'chat', msg });
  } else if (room === 'clan') {
    const c = DB.clans[clanId]; if (!c) throw new Error('нет клана');
    c.chat = c.chat || []; c.chat.push(msg); if (c.chat.length > 60) c.chat = c.chat.slice(-60); persist();
    for (const pid of Object.keys(c.members || {})) {
      const pl = online.get(pid); if (pl) send(pl.ws, { type: 'chat', msg });
    }
  }
  return { msg };
}
function clanPublic(c) {
  if (!c) return null;
  return { id: c.id, name: c.name, tag: c.tag, leader: c.leader, members: Object.keys(c.members || {}).length, nicks: Object.values(c.members || {}).slice(0, 20) };
}
function clanCreate(pl, m) {
  if (DB.clanOf[pl.playerId]) throw new Error('ты уже в клане');
  const name = clean(m.name, 24); const tag = clean(m.tag || name.slice(0, 4), 6).toUpperCase();
  if (!name || name.length < 2) throw new Error('имя клана 2–24 символа');
  if (!tag || tag.length < 2) throw new Error('тег 2–6');
  for (const c of Object.values(DB.clans)) if (c.tag === tag) throw new Error('тег занят');
  const id = crypto.randomUUID().slice(0, 8);
  const c = { id, name, tag, leader: pl.playerId, members: { [pl.playerId]: pl.nick }, created: Date.now(), chat: [] };
  DB.clans[id] = c; DB.clanOf[pl.playerId] = id; pl.clanId = id; persist();
  broadcastOnline();
  return { clan: clanPublic(c) };
}
function clanJoin(pl, m) {
  if (DB.clanOf[pl.playerId]) throw new Error('ты уже в клане');
  const id = clean(m.clanId, 16);
  const c = DB.clans[id]; if (!c) throw new Error('клан не найден');
  if (Object.keys(c.members).length >= 20) throw new Error('клан полон (20)');
  c.members[pl.playerId] = pl.nick; DB.clanOf[pl.playerId] = id; pl.clanId = id; persist();
  broadcast({ type: 'sys', text: '🏴 ' + pl.nick + ' вступил в «' + c.name + '» [' + c.tag + ']' });
  broadcastOnline();
  return { clan: clanPublic(c) };
}
function clanLeave(pl) {
  const id = DB.clanOf[pl.playerId]; if (!id) throw new Error('ты не в клане');
  const c = DB.clans[id]; if (!c) { delete DB.clanOf[pl.playerId]; persist(); return { left: true }; }
  delete c.members[pl.playerId]; delete DB.clanOf[pl.playerId]; pl.clanId = '';
  if (c.leader === pl.playerId) {
    const rest = Object.keys(c.members);
    if (!rest.length) delete DB.clans[id];
    else c.leader = rest[0];
  }
  persist(); broadcastOnline();
  return { left: true, clan: clanPublic(DB.clans[id]) };
}
function clanList() { return { clans: Object.values(DB.clans).map(clanPublic).sort((a, b) => b.members - a.members).slice(0, 40) }; }
function clanMine(pl) {
  const id = DB.clanOf[pl.playerId]; const c = id && DB.clans[id];
  return { clan: c ? { ...clanPublic(c), chat: (c.chat || []).slice(-30), memberList: c.members } : null };
}
function boardPush(pl, m) {
  const money = num(m.money, 0, 1e15, 0);
  const kills = int(m.kills, 0, 1e9, 0);
  pl.money = money; pl.kills = kills;
  const nick = pl.nick;
  const now = Date.now();
  const prevR = DB.boards.rich[pl.playerId];
  const prevK = DB.boards.kills[pl.playerId];
  if (!prevR || money >= (prevR.v || 0)) DB.boards.rich[pl.playerId] = { nick, v: money, at: now };
  if (!prevK || kills >= (prevK.v || 0)) DB.boards.kills[pl.playerId] = { nick, v: kills, at: now };
  // trim
  for (const key of ['rich', 'kills']) {
    const arr = Object.entries(DB.boards[key]).sort((a, b) => b[1].v - a[1].v);
    if (arr.length > 100) {
      DB.boards[key] = Object.fromEntries(arr.slice(0, 100));
    }
  }
  persist();
  broadcastOnline();
  return { ok: true };
}
function boardGet() {
  const top = (obj) => Object.entries(obj).map(([playerId, x]) => ({ playerId, nick: x.nick, v: x.v, at: x.at }))
    .sort((a, b) => b.v - a.v).slice(0, 20);
  return { rich: top(DB.boards.rich || {}), kills: top(DB.boards.kills || {}) };
}
function assistCall(pl, m) {
  // один активный вызов на игрока
  for (const [id, a] of assists) if (a.host === pl.playerId && a.status === 'open') { assists.delete(id); }
  const enemy = {
    name: clean(m.name, 48) || 'Враг',
    maxHp: int(m.maxHp, 20, 500000, 100),
    hp: int(m.hp, 1, 500000, 100),
    dmg: int(m.dmg, 1, 50000, 10),
    armor: int(m.armor, 0, 5000, 0),
    level: int(m.level, 1, 99, 1),
    loot: clean(m.loot, 24) || 'street',
    money: num(m.money, 0.1, 20, 1),
  };
  enemy.hp = Math.min(enemy.hp, enemy.maxHp);
  const id = crypto.randomUUID().slice(0, 10);
  const a = { id, host: pl.playerId, hostNick: pl.nick, helpers: {}, enemy, status: 'open', at: Date.now(), hits: {} };
  assists.set(id, a);
  broadcast({ type: 'assist_open', assist: { id, host: a.host, hostNick: a.hostNick, enemy: { name: enemy.name, hp: enemy.hp, maxHp: enemy.maxHp, level: enemy.level } } });
  return { assistId: id, enemy };
}
function assistJoin(pl, m) {
  const id = clean(m.assistId, 16); const a = assists.get(id);
  if (!a || a.status !== 'open') throw new Error('вызов закрыт');
  if (a.host === pl.playerId) throw new Error('это твой бой');
  if (Object.keys(a.helpers).length >= 4) throw new Error('уже 4 помощника');
  a.helpers[pl.playerId] = pl.nick;
  const members = [a.host, ...Object.keys(a.helpers)];
  for (const pid of members) {
    const t = online.get(pid); if (t) send(t.ws, { type: 'assist_update', assist: assistPublic(a) });
  }
  return { assist: assistPublic(a) };
}
function assistPublic(a) {
  return {
    id: a.id, host: a.host, hostNick: a.hostNick, status: a.status,
    helpers: Object.entries(a.helpers).map(([playerId, nick]) => ({ playerId, nick })),
    enemy: { name: a.enemy.name, hp: a.enemy.hp, maxHp: a.enemy.maxHp, level: a.enemy.level, dmg: a.enemy.dmg, armor: a.enemy.armor, loot: a.enemy.loot },
  };
}
function assistHit(pl, m) {
  const id = clean(m.assistId, 16); const a = assists.get(id);
  if (!a || a.status !== 'open') throw new Error('бой закрыт');
  if (pl.playerId !== a.host && !a.helpers[pl.playerId]) throw new Error('ты не в этом бою');
  const dmg = int(m.dmg, 1, 1e7, 1);
  a.enemy.hp = Math.max(0, a.enemy.hp - dmg);
  a.hits[pl.playerId] = (a.hits[pl.playerId] || 0) + dmg;
  const members = [a.host, ...Object.keys(a.helpers)];
  const upd = { type: 'assist_update', assist: assistPublic(a), lastHit: { pid: pl.playerId, nick: pl.nick, dmg } };
  for (const pid of members) { const t = online.get(pid); if (t) send(t.ws, upd); }
  if (a.enemy.hp <= 0) return assistFinish(a, true);
  return { assist: assistPublic(a) };
}
function assistFinish(a, won) {
  if (a.status !== 'open') return { assist: assistPublic(a) };
  a.status = won ? 'won' : 'lost';
  const members = [a.host, ...Object.keys(a.helpers)];
  const n = Math.max(1, members.length);
  if (won) {
    const pot = Math.floor((a.enemy.level * 120 + Math.random() * 150) * a.enemy.money);
    const share = Math.max(1, Math.floor(pot / n));
    for (const pid of members) {
      deliver(pid, { money: share, force: 1, meta: { k: 'assist_loot', assistId: a.id }, message: '🆘 Доля за помощь против ' + a.enemy.name + ': +' + share + ' ₽ (из ' + n + ')' });
    }
    broadcast({ type: 'sys', text: '🆘 ' + a.hostNick + (Object.keys(a.helpers).length ? ' + братва' : '') + ' положили «' + a.enemy.name + '». Лут поделён на ' + n });
  }
  for (const pid of members) {
    const t = online.get(pid); if (t) send(t.ws, { type: 'assist_end', assist: assistPublic(a), won: !!won });
  }
  setTimeout(() => assists.delete(a.id), 60000);
  return { assist: assistPublic(a), won: !!won, shares: n };
}
function assistCancel(pl, m) {
  const id = clean(m.assistId, 16); const a = assists.get(id);
  if (!a) return { cancelled: true };
  if (a.host !== pl.playerId) throw new Error('только хозяин боя');
  a.status = 'cancel';
  const members = [a.host, ...Object.keys(a.helpers)];
  for (const pid of members) { const t = online.get(pid); if (t) send(t.ws, { type: 'assist_end', assist: assistPublic(a), won: false, reason: 'отменён' }); }
  assists.delete(id);
  return { cancelled: true };
}
function assistList() {
  return { assists: [...assists.values()].filter(a => a.status === 'open').map(assistPublic).slice(0, 20) };
}

function adminDispatch(m) {
  switch (m.action) {
    case 'gift': return giveGift(m);
    case 'event': return startEvent(m);
    case 'event_stop': return stopEvent();
    case 'players': return { players: onlineList() };
    case 'tp': return tpPlayer(m);
    case 'kick': return kickPlayer(m);
    case 'broadcast': return broadcastSys(m);
    case 'warn': return warnPlayer(m);
    case 'unwarn': return unwarnPlayer(m);
    case 'ban': return banPlayer(m);
    case 'unban': return unbanPlayer(m);
    case 'bans': return bansList();
    case 'promo_create': return promoCreate(m);
    case 'promo_delete': return promoDelete(m);
    case 'promo_list': return promoList();
    case 'drop': return dropNow(m);
    case 'auc_remove': return aucCancel(null, m, clean(m.reason, 80) || 'снят админом');
    case 'auc_lots': return { lots: lotsPublic() };
    default: throw new Error('unknown action');
  }
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/', (req, res) => res.type('text').send(`Хрущевский Беспредел — сервер работает. Онлайн: ${online.size}. WS: /ws`));
app.get('/health', (req, res) => res.json({ ok: true, online: online.size, uptimeSec: Math.round((Date.now() - startedAt) / 1000), features: FEATURES, lots: Object.keys(DB.lots).length }));
app.get('/online', (req, res) => res.json({ players: onlineList() }));
app.get('/auction', (req, res) => res.json({ lots: lotsPublic() }));
app.get('/boards', (req, res) => res.json(boardGet()));
app.get('/clans', (req, res) => res.json(clanList()));
app.get('/chat', (req, res) => res.json({ chat: DB.chat.slice(-40) }));

const admin = (req, res, next) => checkKey(req.get('x-admin-key')) ? next() : res.status(401).json({ error: 'bad admin key' });
const wrap = fn => (req, res) => { try { res.json({ ok: true, ...fn(req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); } };
app.get('/admin/players', admin, (req, res) => res.json({ players: onlineList(), pending: Object.fromEntries(pendingGifts.entries().map(([k, v]) => [k, v.length])), event: eventIsActive() ? activeEvent : null }));
app.get('/admin/bans', admin, (req, res) => res.json(bansList()));
app.get('/admin/promos', admin, (req, res) => res.json(promoList()));
app.post('/admin/gift', admin, wrap(giveGift));
app.post('/admin/event', admin, wrap(startEvent));
app.post('/admin/event/stop', admin, wrap(stopEvent));
app.post('/admin/tp', admin, wrap(tpPlayer));
app.post('/admin/kick', admin, wrap(kickPlayer));
app.post('/admin/broadcast', admin, wrap(broadcastSys));
app.post('/admin/warn', admin, wrap(warnPlayer));
app.post('/admin/unwarn', admin, wrap(unwarnPlayer));
app.post('/admin/ban', admin, wrap(banPlayer));
app.post('/admin/unban', admin, wrap(unbanPlayer));
app.post('/admin/promo', admin, wrap(promoCreate));
app.post('/admin/promo/delete', admin, wrap(promoDelete));
app.post('/admin/drop', admin, wrap(dropNow));
app.post('/admin/auction/remove', admin, wrap(m => aucCancel(null, m, 'снят админом')));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.player = null;
  ws.msgCount = 0;
  ws.ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '');
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (++ws.msgCount > 40) return; // антиспам: ≤40 сообщений за 10 сек
    let m; try { m = JSON.parse(raw); } catch { return send(ws, { type: 'error', error: 'bad json' }); }
    if (!m || typeof m !== 'object') return;
    const needHello = () => { if (!ws.player) { send(ws, { type: 'req', reqId: clean(m.reqId, 48), op: m.type, ok: false, error: 'not hello' }); return true; } return false; };

    switch (m.type) {
      case 'hello': {
        const playerId = clean(m.playerId, 64) || crypto.randomUUID();
        const nick = clean(m.nick, 24) || 'Жилец';
        const ban = isBanned(playerId, ws.ip);
        if (ban) { send(ws, { type: 'banned', reason: ban.reason, until: ban.until }); try { ws.close(); } catch (_) {} return; }
        const prev = online.get(playerId);
        if (prev && prev.ws !== ws) { send(prev.ws, { type: 'kicked', reason: 'вход с другой вкладки' }); prev.ws.close(); }
        ws.player = { ws, playerId, nick, connectedAt: Date.now(), title: clean(m.title, 32), lvl: int(m.lvl, 0, 9999, 0), ip: ws.ip, clanId: DB.clanOf[playerId] || '', money: 0, kills: 0 };
        online.set(playerId, ws.player);
        DB.known[playerId] = { nick, ip: ws.ip, lastSeen: Date.now() };
        const ks = Object.keys(DB.known); if (ks.length > 2000) delete DB.known[ks[0]];
        persist();
        send(ws, { type: 'welcome', playerId, nick, players: onlineList(), event: eventIsActive() ? activeEvent : null, features: FEATURES, epoch: DB.epoch, warns: (DB.warns[playerId] || []).length, aucFee: AUC_FEE, clanId: DB.clanOf[playerId] || '', chat: DB.chat.slice(-20), boards: boardGet(), assists: assistList().assists });
        for (const gift of pendingGifts.get(playerId) || []) send(ws, { type: 'gift', gift });
        broadcastOnline();
        break;
      }
      case 'set_title': {
        if (!ws.player) break;
        ws.player.title = clean(m.title, 32); if (m.lvl != null) ws.player.lvl = int(m.lvl, 0, 9999, 0);
        broadcastOnline();
        break;
      }
      case 'list':
        send(ws, { type: 'online', players: onlineList() });
        break;
      case 'peer': { // игрок → игрок (трейд, приглашение в рейд, ходы рейда). Сервер только пересылает.
        if (!ws.player) return send(ws, { type: 'peer_fail', reason: 'not hello' });
        const to = clean(m.to, 64);
        const data = (m.data && typeof m.data === 'object' && !Array.isArray(m.data)) ? m.data : null;
        const k = data ? clean(data.k, 24) : '';
        if (!to || !data || !k) return send(ws, { type: 'peer_fail', to, reason: 'bad peer msg' });
        if (to === ws.player.playerId) return send(ws, { type: 'peer_fail', to, k, reason: 'self' });
        const t = online.get(to);
        if (!t) return send(ws, { type: 'peer_fail', to, k, tid: data.tid || null, reason: 'offline' });
        send(t.ws, { type: 'peer', from: ws.player.playerId, fromNick: ws.player.nick, data, at: Date.now() });
        send(ws, { type: 'peer_ok', to, k, tid: data.tid || null });
        break;
      }
      case 'gift_ack': {
        if (!ws.player) break;
        const q = (pendingGifts.get(ws.player.playerId) || []).filter(g => g.giftId !== m.giftId);
        q.length ? pendingGifts.set(ws.player.playerId, q) : pendingGifts.delete(ws.player.playerId);
        break;
      }
      case 'auc_get': send(ws, { type: 'auc_lots', lots: lotsPublic(), epoch: DB.epoch }); break;
      case 'auc_list': if (!needHello()) handleReq(ws, m, () => aucList(ws.player, m)); break;
      case 'auc_bid': if (!needHello()) handleReq(ws, m, () => aucBid(ws.player, m, false)); break;
      case 'auc_buy': if (!needHello()) handleReq(ws, m, () => aucBid(ws.player, m, true)); break;
      case 'auc_cancel': if (!needHello()) handleReq(ws, m, () => aucCancel(ws.player, m)); break;
      case 'pvp_challenge': if (!needHello()) handleReq(ws, m, () => pvpChallenge(ws.player, m)); break;
      case 'pvp_accept': if (!needHello()) handleReq(ws, m, () => pvpAccept(ws.player, m)); break;
      case 'pvp_decline': if (!needHello()) handleReq(ws, m, () => pvpDecline(ws.player, m)); break;
      case 'promo': if (!needHello()) handleReq(ws, m, () => promoUse(ws.player.playerId, m.code)); break;
      case 'chat': if (!needHello()) handleReq(ws, m, () => pushChat(clean(m.room, 12) || 'global', ws.player.playerId, ws.player.nick, m.text, DB.clanOf[ws.player.playerId])); break;
      case 'clan_create': if (!needHello()) handleReq(ws, m, () => clanCreate(ws.player, m)); break;
      case 'clan_join': if (!needHello()) handleReq(ws, m, () => clanJoin(ws.player, m)); break;
      case 'clan_leave': if (!needHello()) handleReq(ws, m, () => clanLeave(ws.player)); break;
      case 'clan_list': if (!needHello()) handleReq(ws, m, () => clanList()); break;
      case 'clan_mine': if (!needHello()) handleReq(ws, m, () => clanMine(ws.player)); break;
      case 'board_push': if (!needHello()) handleReq(ws, m, () => boardPush(ws.player, m)); break;
      case 'board_get': if (!needHello()) handleReq(ws, m, () => boardGet()); break;
      case 'assist_call': if (!needHello()) handleReq(ws, m, () => assistCall(ws.player, m)); break;
      case 'assist_join': if (!needHello()) handleReq(ws, m, () => assistJoin(ws.player, m)); break;
      case 'assist_hit': if (!needHello()) handleReq(ws, m, () => assistHit(ws.player, m)); break;
      case 'assist_cancel': if (!needHello()) handleReq(ws, m, () => assistCancel(ws.player, m)); break;
      case 'assist_list': if (!needHello()) handleReq(ws, m, () => assistList()); break;
      case 'admin': {
        if (!checkKey(m.key)) return send(ws, { type: 'admin_result', ok: false, action: m.action, error: 'bad admin key' });
        try { send(ws, { type: 'admin_result', ok: true, action: m.action, ...adminDispatch(m) }); }
        catch (e) { send(ws, { type: 'admin_result', ok: false, action: m.action, error: e.message }); }
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
      const pid = ws.player.playerId;
      online.delete(pid);
      // открытый вызов на дуэль от вышедшего — отменяем (ставка вернётся подарком)
      for (const d of duels.values()) if (d.a.pid === pid) duelCancel(d, 'вызвавший вышел', [d.b.pid]);
      for (const [id, a] of [...assists.entries()]) {
        if (a.host === pid && a.status === 'open') { try { assistCancel(ws.player, { assistId: id }); } catch (_) { assists.delete(id); } }
        else if (a.helpers[pid]) { delete a.helpers[pid]; const members = [a.host, ...Object.keys(a.helpers)]; for (const x of members) { const t = online.get(x); if (t) send(t.ws, { type: 'assist_update', assist: assistPublic(a) }); } }
      }
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
setInterval(() => { try { aucTick(); duelTick(); eventDropTick(); } catch (e) { console.error('[tick]', e); } }, 3000);
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB)); } catch (_) {} process.exit(0); });

server.listen(PORT, () => console.log(`hrush-server на порту ${PORT}, WS: /ws`));
