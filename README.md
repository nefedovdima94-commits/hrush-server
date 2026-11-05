# Хрущевский Беспредел — онлайн-сервер

Минимальный сервер: Node.js + Express + ws. Онлайн-список, подарки, ивенты, peer (трейд/рейд), аукцион, PvP на ставку, варны/баны, ивент-дроп и промокоды.

## Файлы
| Файл | Что это |
|---|---|
| `server.js` | сервер (HTTP + WebSocket на одном порту, WS-путь `/ws`) |
| `client-snippet.js` | кусок JS для вставки в игру (`window.HrushOnline`) |
| `test-local.js` | локальный автотест |
| `render.yaml` | Blueprint для Render (необязательно) |

## Локально
```bash
npm install
ADMIN_KEY=test npm start          # http://localhost:3000
# в другом терминале:
ADMIN_KEY=test npm test
```

## Деплой на Render Free (по шагам)
1. Залей папку `hrush-server` в репозиторий на GitHub (можно отдельный репо, можно подпапку).
2. Зайди на https://render.com → **New +** → **Web Service** → подключи GitHub и выбери репозиторий.
3. Настройки:
   - **Root Directory**: `hrush-server` (если сервер лежит в подпапке; если в корне — пусто)
   - **Runtime / Language**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
   - (Advanced) **Health Check Path**: `/health`
4. **Environment Variables** → Add: `ADMIN_KEY` = длинный случайный пароль (например, вывод `openssl rand -hex 24`). `PORT` задавать не нужно — Render ставит его сам.
5. **Create Web Service**. Через 1–3 минуты будет адрес вида `https://hrush-server-xxxx.onrender.com`.
6. Проверка: открой `https://…onrender.com/health` → `{"ok":true,...}`.

Альтернатива: **New + → Blueprint** и выбрать репо — Render прочитает `render.yaml` и сам сгенерирует `ADMIN_KEY` (смотреть его во вкладке Environment).

### Особенности Free-тарифа
- Сервис засыпает после ~15 минут без трафика; первый заход будит его до ~1 минуты. Клиент сам переподключается.
- Очередь подарков, лоты, баны, варны, промокоды и открытые дуэли пишутся в `data.json`. На Free-тарифе диск эфемерный: файл пропадает при рестарте и редеплое, клиенты получают новый `epoch` и сами возвращают себе эскроу. Деньги и инвентарь игрок хранит у себя (localStorage). `ADMIN_KEY` задаётся только в Environment, в репозиторий не попадает.

## Подключение в игре
```html
<script src="client-snippet.js"></script>   <!-- или вставить содержимое файла в <script> -->
<script>
  HrushOnline.onOnline = players => console.log('Онлайн:', players);
  HrushOnline.onGift = g => { if (g.money) state.money += g.money; if (g.item) addItem(g.item, g.qty); };
  HrushOnline.onEvent = ev => showBanner(ev.name + ': ' + ev.text);
  HrushOnline.onExtra = m => { /* auc_lots, pvp_inv, pvp_result, pvp_cancel, warned, banned */ };
  HrushOnline.onReq = m => { /* ответ на HrushOnline.req: {reqId, op, ok, error} */ };
  HrushOnline.connect({ url: 'wss://hrush-server-xxxx.onrender.com/ws', nick: 'Петрович' });
</script>
```
`HrushOnline.playerId` — id игрока (генерируется и хранится в localStorage). Его админ использует для подарков.

## Админ-команды
Все с заголовком `x-admin-key: <ADMIN_KEY>`.

```bash
S=https://hrush-server-xxxx.onrender.com; K=ваш_ключ

# кто онлайн (+ неполученные подарки, текущий ивент)
curl -H "x-admin-key: $K" $S/admin/players

# подарить предмет и/или деньги игроку (если офлайн — получит при входе)
curl -X POST $S/admin/gift -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID_ИГРОКА","item":"Лом","qty":1,"money":500,"message":"От управдома"}'

# глобальный ивент (durationSec необязателен; 0 = бессрочно)
curl -X POST $S/admin/event -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"name":"Отключение воды","text":"Вся хрущевка без воды!","durationSec":600,"data":{"waterOff":true}}'

# остановить ивент
curl -X POST $S/admin/event/stop -H "x-admin-key: $K"

# телепорт онлайн-игрока в node игры
curl -X POST $S/admin/tp -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID","node":"hub","message":"Домой"}'

# кик
curl -X POST $S/admin/kick -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID","reason":"нарушение"}'

# эфир всем
curl -X POST $S/admin/broadcast -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"text":"Внимание жильцам хрущёвки!"}'

# варн (3 варна → автобан на сутки, если AUTO_BAN_WARNS не 0)
curl -X POST $S/admin/warn -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID","reason":"спам"}'
curl -X POST $S/admin/unwarn -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID"}'

# бан (minutes: 0 = навсегда; byIp: true банит ещё и по IP)
curl -X POST $S/admin/ban -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID","minutes":60,"reason":"нарушение"}'
curl -X POST $S/admin/unban -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"playerId":"ID"}'
curl -H "x-admin-key: $K" $S/admin/bans

# промокод
curl -X POST $S/admin/promo -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"code":"HRUSH","money":250,"uses":100,"message":"привет"}'
curl -H "x-admin-key: $K" $S/admin/promos
curl -X POST $S/admin/promo/delete -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"code":"HRUSH"}'

# разовый сундук всем онлайн
curl -X POST $S/admin/drop -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"items":["Лом","Батон"],"qty":1,"message":"сундук"}'

# снять лот
curl -X POST $S/admin/auction/remove -H "x-admin-key: $K" -H "content-type: application/json" \
  -d '{"lotId":"L........"}'
```
Публично без ключа: `GET /health`, `GET /online`, `GET /auction`.

Из игры (консоль браузера): `HrushOnline.adminGift(key, playerId, {money:500})`, `HrushOnline.adminEvent(key, {name:'Субботник'})`, `HrushOnline.req({type:'promo', code:'HRUSH'})`, `HrushOnline.req({type:'auc_list', item:{id,c,l,name}, buyout, start, durMin})`. Ключ в код игры не вшивать.

## Протокол WS (`/ws`, JSON)
Клиент → сервер: `hello {playerId, nick, title?, lvl?}`, `set_title {title, lvl?}`, `list`, `gift_ack {giftId}`, `ping`, `peer {to, data:{k, tid?, ...}}`, `auc_get`, `auc_list|auc_bid|auc_buy|auc_cancel` (с `reqId`), `pvp_challenge|pvp_accept|pvp_decline` (с `reqId`), `promo {code, reqId}`, `admin {key, action, ...}`

`admin.action`: `gift`, `event`, `event_stop`, `players`, `tp`, `kick`, `broadcast`, `warn`, `unwarn`, `ban`, `unban`, `bans`, `promo_create`, `promo_delete`, `promo_list`, `drop`, `auc_remove`, `auc_lots`

Сервер → клиент: `welcome {playerId, players, event, features, epoch, warns, aucFee}`, `online`, `gift`, `event`, `event_end`, `tp`, `sys`, `peer`, `peer_ok`, `peer_fail`, `auc_lots`, `pvp_inv`, `pvp_result`, `pvp_cancel`, `warned`, `banned`, `req {reqId, op, ok, error?}`, `admin_result`, `kicked`, `pong`, `error`

`features`: `peer`, `auction`, `pvp`, `promo`, `mod`, `drop`, `title`.

`peer` — пересылка игрок→игрок (трейд/рейд), как раньше. Сервер не разбирает `data`, только проверяет `data.k` и что получатель онлайн.

Аукцион и PvP: клиент сам списывает вещь или ставку (эскроу) и шлёт запрос с `reqId`. При `ok:false` клиент возвращает себе. Дальше сервер доставляет результат подарком (`gift.meta.k`: `auc_won`, `auc_sold`, `auc_return`, `auc_refund`, `pvp_win`, `pvp_refund`, `promo`, `drop`). Повтор того же `reqId` возвращает сохранённый ответ.

Ивент-дроп: в `data.drop` поля `items`, `everySec` (30–3600), `chance`, `qty`. Пока ивент идёт, онлайн-игроки с этим шансом получают подарок. `POST /admin/drop` выдаёт сундук сразу.

Подарок держится в очереди, пока клиент не пришлёт `gift_ack` (сниппет делает это сам и защищает от двойного начисления).
