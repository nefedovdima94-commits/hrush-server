/* «Хрущевский Беспредел» — клиентский кусок для онлайна.
 * Вставить в игру в <script> ... </script> (или подключить файлом).
 *
 *   HrushOnline.connect({ url: 'wss://ВАШ-СЕРВИС.onrender.com/ws', nick: 'Петрович' });
 *   HrushOnline.onOnline   = players => {...};   // список онлайн [{playerId, nick, since}]
 *   HrushOnline.onGift     = gift => {...};      // {giftId, item, qty, money, message}
 *   HrushOnline.onEvent    = ev => {...};        // {id, name, text, data, endsAt}
 *   HrushOnline.onEventEnd = () => {...};
 *   HrushOnline.onTp       = ({node, message}) => {...};
 *   HrushOnline.onSys      = text => {...};      // системное сообщение / broadcast
 *   HrushOnline.onStatus   = s => {...};         // 'connecting' | 'online' | 'offline'
 *   HrushOnline.list();                          // запросить список онлайн
 *   HrushOnline.peer(playerId, {k:'...', ...});  // сообщение другому игроку; HrushOnline.onPeer = m => {m.from, m.fromNick, m.data}
 *   HrushOnline.playerId                         // id игрока (хранится в localStorage)
 *   HrushOnline.req({type:'auc_bid',...})          // запрос с reqId → ответ в onReq({reqId,op,ok,error,...}); вернёт reqId или null
 *   HrushOnline.onExtra = m => {...};             // auc_lots, pvp_inv, pvp_result, pvp_cancel, warned, banned
 *   HrushOnline.setTitle('Титул', lvl)            // титул рядом с ником в онлайне
 */
(function () {
  var LS_ID = 'hrush_player_id', LS_NICK = 'hrush_nick';
  var ws = null, opts = {}, retry = 0, timer = null, stopped = false;
  // localStorage может БРОСАТЬ исключение (Telegram/«HTML»-просмотрщик, sandbox-iframe, file://, приватный режим).
  // Раньше это убивало весь клиент → window.HrushOnline не создавался → в профиле «нет клиента».
  var _mem = {}, lsOk = true;
  try { var _t = '__hrush_t'; window.localStorage.setItem(_t, '1'); window.localStorage.removeItem(_t); } catch (e) { lsOk = false; }
  var LS = {
    get: function (k) { if (lsOk) try { return window.localStorage.getItem(k); } catch (e) {} return _mem.hasOwnProperty(k) ? _mem[k] : null; },
    set: function (k, v) { v = String(v); _mem[k] = v; if (lsOk) try { window.localStorage.setItem(k, v); } catch (e) {} }
  };

  function genId() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  var playerId = LS.get(LS_ID) || genId();
  LS.set(LS_ID, playerId);

  var H = {
    playerId: playerId,
    players: [],
    event: null,
    status: 'offline',
    // диагностика для UI
    storageOk: lsOk,                                   // false → ID живёт только до перезагрузки
    wsSupported: typeof window.WebSocket === 'function' || typeof window.WebSocket === 'object',
    lastError: '',                                     // текст последней ошибки соединения
    retryAt: 0,                                        // когда следующая попытка (ms)
    attempts: 0,
    onOnline: function () {}, onGift: null, onEvent: function () {},
    onEventEnd: function () {}, onStatus: function () {}, onAdminResult: function (r) { console.log('[admin]', r); },
    onTp: null, onSys: function () {},
    // игрок → игрок через сервер (трейд/рейд). peerSupported: null=неизвестно, true/false
    features: [], peerSupported: null,
    onPeer: function () {}, onPeerFail: function () {}, onPeerOk: function () {},
    // аукцион / pvp / промо / модерация
    title: '', lvl: 0, epoch: null, warns: 0, banned: null,
    onReq: function () {}, onExtra: function () {}, onWelcome: function () {},
    send: function (msg) { if (!ws || ws.readyState !== 1) return false; raw(msg); return true; },
    req: function (msg) { if (!ws || ws.readyState !== 1) return null; msg.reqId = msg.reqId || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); raw(msg); return msg.reqId; },
    setTitle: function (t, lvl) { H.title = String(t || '').slice(0, 32); if (lvl != null) H.lvl = lvl; raw({ type: 'set_title', title: H.title, lvl: H.lvl }); },
    admin: function (key, action, params) { raw(Object.assign({}, params || {}, { type: 'admin', key: key, action: action })); },
    peer: function (to, data) { if (!ws || ws.readyState !== 1) { try { H.onPeerFail({ to: to, k: data && data.k, tid: data && data.tid, reason: 'нет связи' }); } catch (e) {} return false; } raw({ type: 'peer', to: to, data: data }); return true; },

    connect: function (o) {
      opts = o || {}; stopped = false;
      if (opts.nick) LS.set(LS_NICK, opts.nick);
      open();
    },
    disconnect: function () { stopped = true; clearTimeout(timer); if (ws) ws.close(); },
    list: function () { raw({ type: 'list' }); },
    setNick: function (nick) { LS.set(LS_NICK, nick); opts.nick = nick; hello(); },
    // админка из игры (ключ НЕ хранить в коде игры — вводить руками):
    adminGift: function (key, toPlayerId, gift) { raw(Object.assign({ type: 'admin', key: key, action: 'gift', playerId: toPlayerId }, gift)); },
    adminEvent: function (key, ev) { raw(Object.assign({ type: 'admin', key: key, action: 'event' }, ev)); },
    adminEventStop: function (key) { raw({ type: 'admin', key: key, action: 'event_stop' }); },
    adminPlayers: function (key) { raw({ type: 'admin', key: key, action: 'players' }); },
    adminTp: function (key, playerId, node, message) { raw({ type: 'admin', key: key, action: 'tp', playerId: playerId, node: node, message: message || '' }); },
    adminKick: function (key, playerId, reason) { raw({ type: 'admin', key: key, action: 'kick', playerId: playerId, reason: reason || '' }); },
    adminBroadcast: function (key, text) { raw({ type: 'admin', key: key, action: 'broadcast', text: text }); }
  };

  function setStatus(s) { H.status = s; try { H.onStatus(s); } catch (e) { console.error(e); } }
  function raw(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function hello() { raw({ type: 'hello', playerId: playerId, nick: opts.nick || LS.get(LS_NICK) || 'Жилец', title: H.title || '', lvl: H.lvl || 0 }); }

  function open() {
    if (!opts.url) return console.error('HrushOnline: нужен url');
    if (!H.wsSupported) { H.lastError = 'WebSocket недоступен в этом просмотрщике'; setStatus('nows'); return; }
    H.attempts++; H.retryAt = 0;
    setStatus('connecting');
    try { ws = new WebSocket(opts.url); } catch (e) { H.lastError = 'WebSocket заблокирован: ' + (e && e.message || e); setStatus('error'); return reconnect(); }
    ws.onopen = function () { retry = 0; H.lastError = ''; hello(); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (_) { return; }
      switch (m.type) {
        case 'welcome':
          H.features = m.features || []; H.peerSupported = H.features.indexOf('peer') >= 0;
          setStatus('online');
          H.players = m.players || []; H.onOnline(H.players);
          if (m.event) { H.event = m.event; H.onEvent(m.event); }
          H.epoch = m.epoch || null; H.warns = m.warns || 0; H.banned = null;
          try { H.onWelcome(m); } catch (err) { console.error(err); }
          break;
        case 'online': H.players = m.players || []; H.onOnline(H.players); break;
        case 'gift':
          // защита от двойного начисления при переподключении
          var seen = []; try { seen = JSON.parse(LS.get('hrush_gifts_seen') || '[]') || []; } catch (_) { seen = []; }
          if (seen.indexOf(m.gift.giftId) === -1) {
            try { (H.onGift || defaultGift)(m.gift); } catch (err) { console.error(err); }
            seen.push(m.gift.giftId); LS.set('hrush_gifts_seen', JSON.stringify(seen.slice(-200)));
          }
          raw({ type: 'gift_ack', giftId: m.gift.giftId });
          break;
        case 'event': H.event = m.event; H.onEvent(m.event); break;
        case 'event_end': H.event = null; H.onEventEnd(m.eventId); break;
        case 'tp':
          try { (H.onTp || defaultTp)(m); } catch (err) { console.error(err); }
          break;
        case 'sys':
          try { H.onSys(m.text || ''); } catch (err) { console.error(err); }
          break;
        case 'admin_result': H.onAdminResult(m); break;
        case 'peer': try { H.onPeer(m); } catch (err) { console.error(err); } break;
        case 'peer_ok': try { H.onPeerOk(m); } catch (err) { console.error(err); } break;
        case 'peer_fail': try { H.onPeerFail(m); } catch (err) { console.error(err); } break;
        case 'req': try { H.onReq(m); } catch (err) { console.error(err); } break;
        case 'banned': stopped = true; H.banned = { reason: m.reason, until: m.until }; H.lastError = 'бан: ' + (m.reason || ''); try { H.onExtra(m); } catch (err) { console.error(err); } setStatus('banned'); break;
        case 'auc_lots': case 'pvp_inv': case 'pvp_result': case 'pvp_cancel': case 'warned': case 'pong': case 'chat': case 'assist_open': case 'assist_update': case 'assist_end':
          if (m.type === 'warned') H.warns = m.count || H.warns;
          try { H.onExtra(m); } catch (err) { console.error(err); } break;
        case 'error': if (m.error === 'unknown type') { H.peerSupported = false; try { H.onPeerFail({ reason: 'server_old' }); } catch (err) {} } break;
        case 'kicked': stopped = true; setStatus('offline'); console.warn('HrushOnline:', m.reason); try { H.onSys('Кик: ' + (m.reason || '')); } catch (_) {} break;
      }
    };
    ws.onclose = function (ev) {
      if (H.status === 'connecting' && !H.lastError) H.lastError = 'сервер не ответил' + (ev && ev.code ? ' (код ' + ev.code + ')' : '') + ' — Render может просыпаться ~50 с';
      if (H.banned) { setStatus('banned'); return; }
      setStatus('offline'); if (!stopped) reconnect();
    };
    ws.onerror = function () { H.lastError = H.lastError || 'ошибка WebSocket (сеть/просмотрщик блокирует?)'; /* onclose сработает следом */ };
  }

  function reconnect() {
    clearTimeout(timer);
    // Render Free «просыпается» до ~50 сек — поэтому бэкофф до 30 сек
    var delay = Math.min(30000, 1000 * Math.pow(2, retry++));
    H.retryAt = Date.now() + delay;
    timer = setTimeout(open, delay);
  }

  function defaultGift(g) {
    var txt = 'Подарок от админа: ' + (g.item ? g.item + ' ×' + g.qty : '') + (g.money ? (g.item ? ', ' : '') + g.money + ' ₽' : '') + (g.message ? '\n' + g.message : '');
    alert(txt);
  }

  function defaultTp(m) {
    try {
      if (typeof p !== 'undefined' && p) {
        p.node = m.node;
        if (typeof showLog === 'function') showLog('📡 ТП: ' + m.node + (m.message ? ' — ' + m.message : ''));
        if (typeof renderAll === 'function') renderAll();
      }
    } catch (e) { console.error(e); }
  }

  window.HrushOnline = H;
})();
