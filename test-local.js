// Локальный тест: node test-local.js  (сервер должен быть запущен с ADMIN_KEY=test)
const WebSocket = require('ws');
const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = process.env.ADMIN_KEY || 'test';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const wait = ms => new Promise(r => setTimeout(r, ms));
function client(playerId, nick, log) {
  const ws = new WebSocket(WS);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', playerId, nick })));
  ws.on('message', d => { const m = JSON.parse(d); log.push(m); if (m.type === 'gift') ws.send(JSON.stringify({ type: 'gift_ack', giftId: m.gift.giftId })); });
  return ws;
}
const post = (p, body, key = KEY) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': key }, body: JSON.stringify(body) }).then(async r => [r.status, await r.json()]);
(async () => {
  let ok = true; const check = (c, name) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + name); ok = ok && c; };
  check((await (await fetch(BASE + '/health')).json()).ok, '/health');
  const a = [], b = [];
  const wa = client('p-vasya', 'Вася', a); await wait(200);
  const wb = client('p-petya', 'Петя', b); await wait(300);
  const lastOnline = a.filter(m => m.type === 'online').pop();
  check(lastOnline && lastOnline.players.length === 2, 'список онлайн у Васи = 2');
  check((await post('/admin/gift', { playerId: 'p-petya', item: 'Лом', qty: 1 }, 'wrong'))[0] === 401, 'неверный ключ → 401');
  const [s, r] = await post('/admin/gift', { playerId: 'p-petya', item: 'Лом', qty: 2, money: 500, message: 'Держи' });
  await wait(200);
  check(s === 200 && r.delivered && b.some(m => m.type === 'gift' && m.gift.item === 'Лом' && m.gift.money === 500), 'подарок Пете дошёл');
  await post('/admin/gift', { playerId: 'p-offline', money: 100 });
  const c = []; const wc = client('p-offline', 'Офлайн', c); await wait(300);
  check(c.some(m => m.type === 'gift' && m.gift.money === 100), 'подарок офлайн-игроку пришёл при входе');
  await post('/admin/event', { name: 'Отключение воды', text: 'Вся хрущевка без воды!', durationSec: 60 });
  await wait(200);
  check([a, b, c].every(l => l.some(m => m.type === 'event' && m.event.name === 'Отключение воды')), 'глобальный ивент у всех');
  const ad = []; const wad = new WebSocket(WS);
  wad.on('message', d => ad.push(JSON.parse(d)));
  await new Promise(r => wad.on('open', r));
  wad.send(JSON.stringify({ type: 'admin', key: KEY, action: 'gift', playerId: 'p-vasya', item: 'Батон' })); await wait(200);
  check(ad.some(m => m.type === 'admin_result' && m.ok) && a.some(m => m.type === 'gift' && m.gift.item === 'Батон'), 'админ-подарок через WS');
  wb.close(); await wait(200);
  check(a.filter(m => m.type === 'online').pop().players.length === 2, 'Петя вышел → онлайн обновился');
  const pl = await (await fetch(BASE + '/admin/players', { headers: { 'x-admin-key': KEY } })).json();
  check(!pl.pending['p-petya'] && !pl.pending['p-offline'], 'подтверждённые подарки удалены из очереди');
  [wa, wc, wad].forEach(w => w.close());
  console.log(ok ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '\nЕСТЬ ОШИБКИ'); process.exit(ok ? 0 : 1);
})();
