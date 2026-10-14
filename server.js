const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Коды доступа и строка подключения к БД задаются ТОЛЬКО через переменные
// окружения на сервере (Render), никогда не хранятся в коде/репозитории.
const ADMIN_CODE = process.env.ADMIN_CODE;     // полный доступ — у владельца
const VIEW_CODE = process.env.VIEW_CODE;       // только просмотр — у команды
const DATABASE_URL = process.env.DATABASE_URL; // строка подключения Supabase

// --- Телеграм-бот (команды в чате команды) ---
const BOT_TOKEN      = process.env.BOT_TOKEN;      // токен от @BotFather
const TG_SECRET      = process.env.TG_SECRET;      // произвольная строка, защищает вебхук
// id чатов, которым бот отвечает, через запятую. Пока пусто — отвечает только на /chatid.
const ALLOWED_CHATS  = (process.env.ALLOWED_CHATS || '')
  .split(',').map(x => x.trim()).filter(Boolean);

if (!ADMIN_CODE || !VIEW_CODE) {
  console.warn('ВНИМАНИЕ: задайте переменные окружения ADMIN_CODE и VIEW_CODE в настройках сервиса на Render.');
}
if (!DATABASE_URL) {
  console.error('ОШИБКА: не задана переменная окружения DATABASE_URL. Сервер не сможет сохранять данные.');
}

app.use(cors());
app.use(express.json());

// ---- Подключение к PostgreSQL (Supabase) ----
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Создаём таблицу при первом запуске, если её ещё нет
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deals (
      id           TEXT PRIMARY KEY,
      date         TEXT NOT NULL,
      amount       DOUBLE PRECISION NOT NULL,
      rate_in      DOUBLE PRECISION NOT NULL,
      rate_out     DOUBLE PRECISION NOT NULL,
      kickback_pct DOUBLE PRECISION DEFAULT 0,
      created_by   TEXT DEFAULT '',
      scope        TEXT DEFAULT 'team',
      owner_id     TEXT,
      created_at   BIGINT NOT NULL
    )
  `);
  console.log('Таблица deals готова.');
}

// Преобразование строки БД в формат, который ждёт фронтенд
function rowToDeal(r) {
  return {
    id: r.id,
    date: r.date,
    amount: Number(r.amount),
    rateIn: Number(r.rate_in),
    rateOut: Number(r.rate_out),
    kickbackPct: Number(r.kickback_pct),
    createdBy: r.created_by,
    scope: r.scope,
    ownerId: r.owner_id,
    createdAt: Number(r.created_at)
  };
}

// ---- Проверка кода доступа и определение роли ----
function getRole(code) {
  if (ADMIN_CODE && code === ADMIN_CODE) return 'admin';
  if (VIEW_CODE && code === VIEW_CODE) return 'viewer';
  return null;
}

function checkAccess(req, res, next) {
  const code = req.headers['x-access-code'];
  const role = getRole(code);
  if (!role) {
    return res.status(401).json({ error: 'Неверный код доступа' });
  }
  req.role = role;
  req.userId = req.headers['x-user-id'] || null; // Telegram user id, для личного режима
  next();
}

// ---- Роуты ----

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Keep-alive: внешний пинг раз в несколько минут держит бодрыми
// и Render (не засыпает после 15 минут), и Supabase (не уходит
// на паузу после 7 дней простоя — для этого нужен запрос именно к БД).
// Кода доступа не требует: наружу ничего не отдаёт.
app.get('/api/ping', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM deals');
    res.json({ ok: true, deals: r.rows[0].n, at: new Date().toISOString() });
  } catch (e) {
    console.error('Ping: база недоступна:', e.message);
    res.status(503).json({ ok: false, error: 'db unavailable' });
  }
});

// Проверка кода при входе — возвращает роль, без выдачи данных
app.get('/api/auth', checkAccess, (req, res) => {
  res.json({ role: req.role });
});

app.get('/api/deals', checkAccess, async (req, res) => {
  const scope = req.query.scope === 'personal' ? 'personal' : 'team';

  if (scope === 'personal' && !req.userId) {
    return res.status(400).json({ error: 'Личный режим доступен только через Telegram' });
  }

  try {
    let result;
    if (scope === 'personal') {
      result = await pool.query(
        `SELECT * FROM deals
         WHERE scope = 'personal' AND owner_id = $1
         ORDER BY date DESC, created_at DESC`,
        [req.userId]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM deals
         WHERE scope = 'team' OR scope IS NULL
         ORDER BY date DESC, created_at DESC`
      );
    }
    res.json(result.rows.map(rowToDeal));
  } catch (e) {
    console.error('Ошибка чтения сделок:', e);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

app.post('/api/deals', checkAccess, async (req, res) => {
  const { id, date, amount, rateIn, rateOut, kickbackPct, createdBy, scope } = req.body;
  if (!id || !date || !amount || !rateIn || !rateOut) {
    return res.status(400).json({ error: 'Не хватает полей' });
  }

  const dealScope = scope === 'personal' ? 'personal' : 'team';

  if (dealScope === 'team' && req.role !== 'admin') {
    return res.status(403).json({ error: 'Только владелец может добавлять командные сделки' });
  }
  if (dealScope === 'personal' && !req.userId) {
    return res.status(400).json({ error: 'Личный режим доступен только через Telegram' });
  }

  try {
    await pool.query(
      `INSERT INTO deals
        (id, date, amount, rate_in, rate_out, kickback_pct, created_by, scope, owner_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id, date, amount, rateIn, rateOut,
        kickbackPct || 0,
        createdBy || '',
        dealScope,
        dealScope === 'personal' ? req.userId : null,
        Date.now()
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка сохранения сделки:', e);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

app.delete('/api/deals/:id', checkAccess, async (req, res) => {
  try {
    const found = await pool.query('SELECT * FROM deals WHERE id = $1', [req.params.id]);
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Сделка не найдена' });
    }
    const deal = found.rows[0];
    const dealScope = deal.scope || 'team';

    if (dealScope === 'team' && req.role !== 'admin') {
      return res.status(403).json({ error: 'Только владелец может удалять командные сделки' });
    }
    if (dealScope === 'personal' && deal.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Это не ваша личная сделка' });
    }

    await pool.query('DELETE FROM deals WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка удаления сделки:', e);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});


// ======================= ТЕЛЕГРАМ-БОТ =======================

const money = n => new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(Math.round(n * 100) / 100) + ' \u20BD';

const pctFmt = n => new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
}).format(n * 100) + '%';

// Та же формула, что и в мини-аппе: кикбек Рауля возвращается в общий котёл,
// итог делится на четверых поровну.
function computeDeal(d) {
  const usdt         = d.amount / d.rate_in;
  const amountOut    = usdt * d.rate_out;
  const profit       = amountOut - d.amount;
  const kickback     = d.amount * ((d.kickback_pct || 0) / 100);
  const totalToShare = profit + kickback;
  return {
    usdt, amountOut, profit, kickback, totalToShare,
    totalPct: totalToShare / d.amount,
    perPerson: totalToShare / 4
  };
}

// Даты в часовом поясе Москвы — чтобы «сегодня» совпадало с тем, что видит команда
function mskToday() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function mskDaysAgo(n) {
  return new Date(Date.now() + 3 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);
}

async function dealsBetween(from, to) {
  const r = await pool.query(
    'SELECT * FROM deals WHERE date >= $1 AND date <= $2 ORDER BY date, created_at',
    [from, to]
  );
  return r.rows;
}

// Сводка за период одним сообщением
function summary(title, rows) {
  if (rows.length === 0) return `<b>${title}</b>\n\nСделок нет.`;

  const c = rows.map(computeDeal);
  const total   = c.reduce((s, x) => s + x.totalToShare, 0);
  const avgPct  = c.reduce((s, x) => s + x.totalPct, 0) / c.length;
  const buyRub  = rows.reduce((s, d) => s + Number(d.amount), 0);
  const usdtVol = c.reduce((s, x) => s + x.usdt, 0);
  const share   = total / 4;

  return `<b>${title}</b>\n\n` +
    `Профит: <b>${money(total)}</b>  (${pctFmt(avgPct)})\n` +
    `На человека: <b>${money(share)}</b>\n` +
    `Сделок: ${rows.length}\n` +
    `Оборот: ${money(buyRub)} · ${usdtVol.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} USDT`;
}

// Курс USDT/RUB с биржи Rapira (публичный API, без ключей)
async function fetchRate() {
  const res = await fetch('https://api.rapira.net/open/market/rates', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('rapira ' + res.status);
  const json = await res.json();
  const item = (json.data || []).find(x => x.symbol === 'USDT/RUB');
  if (!item) throw new Error('пара USDT/RUB не найдена');
  return item;
}

async function tgSend(chatId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error('Telegram sendMessage:', e.message);
  }
}

const HELP =
  '<b>Команды трекера</b>\n\n' +
  '/today — профит за сегодня\n' +
  '/week — за последние 7 дней\n' +
  '/month — за текущий месяц\n' +
  '/last — последняя сделка\n' +
  '/rate — курс USDT/RUB на бирже\n' +
  '/chatid — id этого чата';

async function handleCommand(chatId, cmd) {
  switch (cmd) {
    case '/start':
    case '/help':
      return tgSend(chatId, HELP);

    case '/today': {
      const d = mskToday();
      const rows = await dealsBetween(d, d);
      return tgSend(chatId, summary('Сегодня, ' + d.split('-').reverse().join('.'), rows));
    }

    case '/week': {
      const from = mskDaysAgo(6), to = mskToday();
      const rows = await dealsBetween(from, to);
      const label = from.split('-').reverse().join('.') + ' — ' + to.split('-').reverse().join('.');
      return tgSend(chatId, summary('Последние 7 дней (' + label + ')', rows));
    }

    case '/month': {
      const to = mskToday(), from = to.slice(0, 7) + '-01';
      const rows = await dealsBetween(from, to);
      return tgSend(chatId, summary('Текущий месяц', rows));
    }

    case '/last': {
      const r = await pool.query('SELECT * FROM deals ORDER BY date DESC, created_at DESC LIMIT 1');
      if (!r.rows.length) return tgSend(chatId, 'Сделок пока нет.');
      const d = r.rows[0], c = computeDeal(d);
      return tgSend(chatId,
        `<b>Последняя сделка</b>\n\n` +
        `Дата: ${d.date.split('-').reverse().join('.')}\n` +
        `Вход: ${money(Number(d.amount))} по ${Number(d.rate_in).toFixed(2)}\n` +
        `Выход: по ${Number(d.rate_out).toFixed(2)}\n` +
        `Профит: <b>${money(c.totalToShare)}</b> (${pctFmt(c.totalPct)})\n` +
        `На человека: ${money(c.perPerson)}`);
    }

    case '/rate': {
      try {
        const it = await fetchRate();
        return tgSend(chatId,
          `<b>USDT/RUB · Rapira</b>\n\n` +
          `Текущий: <b>${Number(it.close).toFixed(2)} \u20BD</b>\n` +
          `Покупка: ${Number(it.bidPrice).toFixed(2)} · Продажа: ${Number(it.askPrice).toFixed(2)}\n` +
          `За сутки: ${Number(it.chg) >= 0 ? '+' : ''}${(Number(it.chg) * 100).toFixed(2)}%\n\n` +
          `<i>Биржевой курс, не курс вашей площадки.</i>`);
      } catch (e) {
        return tgSend(chatId, 'Не удалось получить курс: ' + e.message);
      }
    }

    default:
      return tgSend(chatId, 'Не знаю такую команду. /help — список.');
  }
}

// Вебхук Telegram. Секрет приходит заголовком, который Telegram ставит сам.
app.post('/api/tg', async (req, res) => {
  if (TG_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== TG_SECRET) {
    return res.sendStatus(401);
  }
  res.json({ ok: true });            // отвечаем сразу, обрабатываем после

  try {
    const msg = req.body.message || req.body.channel_post;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    // в группе команда может прийти как /today@MyBot — отрезаем имя бота
    const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    if (!cmd.startsWith('/')) return;

    // /chatid работает везде — чтобы узнать id и внести его в ALLOWED_CHATS
    if (cmd === '/chatid') {
      return tgSend(chatId, `id этого чата: <code>${chatId}</code>`);
    }

    if (ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(chatId)) {
      return tgSend(chatId, 'Этот чат не в списке разрешённых.');
    }
    if (!ALLOWED_CHATS.length) {
      return tgSend(chatId, 'Бот ещё не настроен: задайте ALLOWED_CHATS на сервере. /chatid покажет id.');
    }

    await handleCommand(chatId, cmd);
  } catch (e) {
    console.error('Ошибка обработки апдейта:', e);
  }
});

// ---- Запуск ----
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Не удалось инициализировать базу данных:', e);
    // Запускаем сервер всё равно, чтобы Render не считал деплой упавшим,
    // но запросы к данным будут возвращать ошибку до починки подключения.
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT} (БД недоступна!)`);
    });
  });
