const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Два кода доступа задаются ТОЛЬКО через переменные окружения на сервере (Render),
// никогда не хранятся в коде/репозитории.
const ADMIN_CODE = process.env.ADMIN_CODE;   // полный доступ — у вас
const VIEW_CODE = process.env.VIEW_CODE;     // только просмотр — у команды

if (!ADMIN_CODE || !VIEW_CODE) {
  console.warn('ВНИМАНИЕ: задайте переменные окружения ADMIN_CODE и VIEW_CODE в настройках сервиса на Render.');
}

app.use(cors());
app.use(express.json());

// ---- База данных ----
const dbPath = path.join(__dirname, 'data.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    rateIn REAL NOT NULL,
    rateOut REAL NOT NULL,
    kickbackPct REAL NOT NULL,
    createdBy TEXT,
    createdAt INTEGER NOT NULL
  )
`);

// ---- Проверка кода доступа и определение роли ----
function getRole(code){
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
  next();
}

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Только владелец может добавлять и удалять сделки' });
  }
  next();
}

// ---- Роуты ----

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Проверка кода при входе — возвращает роль, без выдачи данных
app.get('/api/auth', checkAccess, (req, res) => {
  res.json({ role: req.role });
});

app.get('/api/deals', checkAccess, (req, res) => {
  const rows = db.prepare('SELECT * FROM deals ORDER BY date DESC, createdAt DESC').all();
  res.json(rows);
});

app.post('/api/deals', checkAccess, requireAdmin, (req, res) => {
  const { id, date, amount, rateIn, rateOut, kickbackPct, createdBy } = req.body;
  if (!id || !date || !amount || !rateIn || !rateOut) {
    return res.status(400).json({ error: 'Не хватает полей' });
  }
  db.prepare(`
    INSERT INTO deals (id, date, amount, rateIn, rateOut, kickbackPct, createdBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, date, amount, rateIn, rateOut, kickbackPct || 0, createdBy || '', Date.now());
  res.json({ ok: true });
});

app.delete('/api/deals/:id', checkAccess, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
