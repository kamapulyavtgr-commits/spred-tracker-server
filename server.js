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
