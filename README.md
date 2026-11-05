# Хрущевский Беспредел — онлайн-сервер

Минимальный сервер: Node.js + Express + ws. Онлайн-список игроков, подарки от админа, глобальные ивенты.

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
- Всё хранится в памяти: при рестарте/засыпании онлайн, очередь подарков и ивент сбрасываются. Деньги/инвентарь игрок хранит у себя в игре (localStorage).

## Подключение в игре
```html
<script src="client-snippet.js"></script>   <!-- или вставить содержимое файла в <script> -->
<script>
  HrushOnline.onOnline = players => console.log('Онлайн:', players);
  HrushOnline.onGift = g => { if (g.money) state.money += g.money; if (g.item) addItem(g.item, g.qty); };
  HrushOnline.onEvent = ev => showBanner(ev.name + ': ' + ev.text);
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
```
Из игры (консоль браузера): `HrushOnline.adminGift(key, playerId, {money:500})`, `HrushOnline.adminEvent(key, {name:'Субботник'})`. Ключ в код игры не вшивать.

## Протокол WS (`/ws`, JSON)
Клиент → сервер: `hello {playerId, nick}`, `list`, `gift_ack {giftId}`, `ping`, `admin {key, action: gift|event|event_stop|players|tp|kick|broadcast, ...}`
Сервер → клиент: `welcome {playerId, players, event}`, `online {players}`, `gift {gift}`, `event {event}`, `event_end`, `tp {node,message}`, `sys {text}`, `admin_result`, `kicked`, `error`

Подарок держится в очереди, пока клиент не пришлёт `gift_ack` (сниппет делает это сам и защищает от двойного начисления).
