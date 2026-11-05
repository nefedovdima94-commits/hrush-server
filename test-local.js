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
  const health = await (await fetch(BASE + '/health')).json();
  const prior = ['peer', 'auction', 'pvp', 'promo', 'mod', 'drop', 'title', 'chat', 'clan', 'board', 'assist'];
  check(health.ok && [...prior, 'dm', 'house'].every(f => (health.features || []).includes(f)), '/health dm+house и прежние фичи');
  const a = [], b = [];
  const wa = client('p-vasya', 'Вася', a); await wait(200);
  const wb = client('p-petya', 'Петя', b); await wait(300);
  const lastOnline = a.filter(m => m.type === 'online').pop();
  check(lastOnline && lastOnline.players.length === 2, 'список онлайн у Васи = 2');
  const welcomeA = a.find(m => m.type === 'welcome');
  check(welcomeA && [...prior, 'dm', 'house'].every(f => (welcomeA.features || []).includes(f)), 'welcome: прежние фичи + dm/house');
  wa.send(JSON.stringify({ type: 'peer', to: 'p-petya', data: { k: 'trade', tid: 't1', offer: 1 } }));
  await wait(200);
  check(b.some(m => m.type === 'peer' && m.from === 'p-vasya' && m.fromNick === 'Вася' && m.data && m.data.k === 'trade' && m.data.tid === 't1'), 'peer дошёл Пете');
  check(a.some(m => m.type === 'peer_ok' && m.to === 'p-petya' && m.k === 'trade' && m.tid === 't1'), 'отправителю peer_ok');
  wa.send(JSON.stringify({ type: 'peer', to: 'nobody', data: { k: 'raid', tid: 't2' } }));
  await wait(200);
  check(a.some(m => m.type === 'peer_fail' && m.to === 'nobody' && m.reason === 'offline' && m.k === 'raid' && m.tid === 't2'), 'офлайн → peer_fail');
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
  // tp / broadcast / kick
  await post('/admin/broadcast', { text: 'Проверка эфира' }); await wait(150);
  check(a.some(m => m.type === 'sys' && m.text === 'Проверка эфира'), 'broadcast → sys');
  await post('/admin/tp', { playerId: 'p-vasya', node: 'hub', message: 'домой' }); await wait(150);
  check(a.some(m => m.type === 'tp' && m.node === 'hub'), 'tp Васе');
  const [ks, kr] = await post('/admin/kick', { playerId: 'p-offline', reason: 'тест' }); await wait(200);
  check(ks === 200 && kr.kicked && c.some(m => m.type === 'kicked'), 'kick офлайн-клиента');
  // промокод
  const [ps, pr] = await post('/admin/promo', { code: 'hrush', money: 250, message: 'тест' });
  check(ps === 200 && pr.promo && pr.promo.code === 'HRUSH' && pr.promo.money === 250, 'промокод создан');
  wa.send(JSON.stringify({ type: 'promo', reqId: 'pr1', code: 'hrush' })); await wait(250);
  check(a.some(m => m.type === 'req' && m.reqId === 'pr1' && m.ok && m.money === 250), 'промокод активирован');
  check(a.some(m => m.type === 'gift' && m.gift.money === 250 && m.gift.meta && m.gift.meta.k === 'promo' && m.gift.meta.code === 'HRUSH'), 'подарок по промокоду');
  wa.send(JSON.stringify({ type: 'promo', reqId: 'pr1', code: 'hrush' })); await wait(150);
  check(a.filter(m => m.type === 'req' && m.reqId === 'pr1' && m.ok).length >= 2, 'повтор reqId идемпотентен');
  wa.send(JSON.stringify({ type: 'promo', reqId: 'pr2', code: 'HRUSH' })); await wait(200);
  check(a.some(m => m.type === 'req' && m.reqId === 'pr2' && m.ok === false), 'промокод один раз на игрока');
  // аукцион: клиент сам держит эскроу, сервер только лот и расчёт
  wa.send(JSON.stringify({ type: 'auc_list', reqId: 'al1', item: { id: 'crowbar', c: 1, l: 1, name: 'Лом' }, buyout: 100, start: 50, durMin: 30 }));
  await wait(250);
  const listed = a.find(m => m.type === 'req' && m.reqId === 'al1');
  check(listed && listed.ok && listed.lot && listed.lot.id && listed.lot.buyout === 100 && listed.lot.seller === 'p-vasya', 'лот выставлен');
  const auc = await (await fetch(BASE + '/auction')).json();
  const lotId = listed && listed.lot && listed.lot.id;
  check(!!lotId && auc.lots.some(l => l.id === lotId), 'GET /auction видит лот');
  check(!!lotId && b.some(m => m.type === 'auc_lots' && m.lots.some(l => l.id === lotId)), 'auc_lots ушел онлайн');
  if (lotId) wb.send(JSON.stringify({ type: 'auc_buy', reqId: 'ab1', lotId, amount: 100 }));
  await wait(300);
  check(b.some(m => m.type === 'req' && m.reqId === 'ab1' && m.ok && m.bought), 'выкуп лота');
  check(b.some(m => m.type === 'gift' && m.gift.item === 'crowbar' && m.gift.meta && m.gift.meta.k === 'auc_won'), 'покупателю вещь');
  check(a.some(m => m.type === 'gift' && m.gift.money === 95 && m.gift.meta && m.gift.meta.k === 'auc_sold'), 'продавцу выплата минус комиссия 5%');
  // PvP на ставку
  wa.send(JSON.stringify({ type: 'pvp_challenge', reqId: 'pc1', to: 'p-petya', stake: 100, msg: 'давай', stats: { lvl: 2, hp: 40, dmg: 8, arm: 1, wpn: 'лом', tac: 'bal' } }));
  await wait(250);
  const inv = b.find(m => m.type === 'pvp_inv' && m.duel && m.duel.from === 'p-vasya');
  check(a.some(m => m.type === 'req' && m.reqId === 'pc1' && m.ok) && inv && inv.duel.stake === 100, 'вызов на дуэль');
  const duelId = inv && inv.duel && inv.duel.id;
  if (duelId) wb.send(JSON.stringify({ type: 'pvp_accept', reqId: 'pa1', duelId, stake: 100, stats: { lvl: 2, hp: 40, dmg: 8, arm: 1, wpn: 'кулаки', tac: 'def' } }));
  await wait(300);
  const resA = duelId && a.find(m => m.type === 'pvp_result' && m.duelId === duelId);
  const resB = duelId && b.find(m => m.type === 'pvp_result' && m.duelId === duelId);
  check(resA && resB && resA.winnerId === resB.winnerId && (resA.winnerId === 'p-vasya' || resA.winnerId === 'p-petya'), 'результат дуэли обоим');
  const winLog = resA && resA.winnerId === 'p-vasya' ? a : b;
  check(!!resA && winLog.some(m => m.type === 'gift' && m.gift.money === 200 && m.gift.meta && m.gift.meta.k === 'pvp_win'), 'победителю банк 2×ставки');
  // варн (один — без автобана)
  const [wns, wnr] = await post('/admin/warn', { playerId: 'p-vasya', reason: 'спам' }); await wait(200);
  check(wns === 200 && wnr.count === 1 && !wnr.autoBan && a.some(m => m.type === 'warned' && m.count === 1 && m.reason === 'спам'), 'варн доставлен');
  // ивент-дроп: конфиг в ивенте и разовый сундук
  const [eds, edr] = await post('/admin/event', { name: 'Сундуки', text: 'дроп', durationSec: 120, data: { drop: { items: ['Лом'], everySec: 30, chance: 1, qty: 1 } } });
  check(eds === 200 && edr.event && edr.event.data && edr.event.data.drop && edr.event.data.drop.items[0] === 'Лом' && edr.event.nextDropAt, 'ивент с дропом');
  const [ds, dr] = await post('/admin/drop', { items: ['Лом'], qty: 1, message: 'сундук' }); await wait(250);
  check(ds === 200 && dr.sentTo >= 2 && a.some(m => m.type === 'gift' && m.gift.meta && m.gift.meta.k === 'drop' && m.gift.item === 'Лом') && b.some(m => m.type === 'gift' && m.gift.meta && m.gift.meta.k === 'drop'), 'разовый дроп онлайн');
  // бан и отказ при входе
  const banLog = []; const wban = client('p-ban', 'Бан', banLog); await wait(300);
  const [bs, br] = await post('/admin/ban', { playerId: 'p-ban', minutes: 10, reason: 'тест' }); await wait(200);
  check(bs === 200 && br.banned === 'p-ban' && banLog.some(m => m.type === 'banned' && m.reason === 'тест'), 'бан кикает онлайн');
  const ban2 = []; const wban2 = client('p-ban', 'Бан', ban2); await wait(300);
  check(ban2.some(m => m.type === 'banned') && !ban2.some(m => m.type === 'welcome'), 'забаненный не проходит hello');
  const [us] = await post('/admin/unban', { playerId: 'p-ban' });
  check(us === 200, 'разбан');
  try { wban.close(); wban2.close(); } catch (_) {}
  // v33: СМС онлайн и в очередь, пока адресат офлайн
  wa.send(JSON.stringify({ type: 'dm', reqId: 'dm1', to: 'p-petya', text: 'привет' }));
  await wait(250);
  check(a.some(m => m.type === 'req' && m.reqId === 'dm1' && m.ok && m.delivered), 'СМС онлайн доставлено');
  check(b.some(m => m.type === 'dm' && m.msg && m.msg.from === 'p-vasya' && m.msg.text === 'привет'), 'СМС дошло Пете');
  wb.close(); await wait(250);
  wa.send(JSON.stringify({ type: 'dm', reqId: 'dm2', to: 'p-petya', text: 'ты где' }));
  await wait(250);
  check(a.some(m => m.type === 'req' && m.reqId === 'dm2' && m.ok && m.delivered === false), 'СМС офлайн в очередь');
  const b2 = []; const wb2 = client('p-petya', 'Петя', b2); await wait(400);
  const w2 = b2.find(m => m.type === 'welcome');
  check(!!w2 && (w2.dms || []).some(d => d.text === 'ты где' && d.from === 'p-vasya'), 'офлайн-СМС в welcome.dms');
  // хата офлайн-игрока и налёт бригады
  wb2.send(JSON.stringify({ type: 'house_push', lvl: 5, cash: 20000, def: 10, items: [{ id: 'crowbar', c: 2, v: 100 }] }));
  await wait(300);
  wb2.close(); await wait(300);
  wa.send(JSON.stringify({ type: 'house_list', reqId: 'hl1' }));
  await wait(300);
  const hl = a.find(m => m.type === 'req' && m.reqId === 'hl1');
  check(!!hl && hl.ok && (hl.houses || []).some(h => h.pid === 'p-petya' && h.lvl === 5), 'house_list видит офлайн-хату');
  wa.send(JSON.stringify({ type: 'house_raid', reqId: 'hr1', to: 'p-petya', power: 500, stl: 40 }));
  await wait(300);
  const hr = a.find(m => m.type === 'req' && m.reqId === 'hr1');
  check(!!hr && hr.ok && typeof hr.success === 'boolean' && hr.chance >= 8 && hr.chance <= 80, 'house_raid ответил');
  const b3 = []; const wb3 = client('p-petya', 'Петя', b3); await wait(400);
  const w3 = b3.find(m => m.type === 'welcome');
  check(!!w3 && (w3.houseHits || []).some(h => h.fromNick === 'Вася'), 'houseHits при входе');
  try { wb3.close(); } catch (_) {}
  check(a.filter(m => m.type === 'online').pop().players.length >= 1, 'онлайн обновился после выходов');
  const pl = await (await fetch(BASE + '/admin/players', { headers: { 'x-admin-key': KEY } })).json();
  check(!pl.pending['p-petya'], 'подтверждённые подарки удалены из очереди');
  [wa, wad].forEach(w => { try { w.close(); } catch (_) {} });
  console.log(ok ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : '\nЕСТЬ ОШИБКИ'); process.exit(ok ? 0 : 1);
})();
