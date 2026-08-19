const express = require('express');
const cors = require('cors');
const fs = require('fs');
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

// ---- Хранилище (простой JSON-файл, без нативных зависимостей) ----
const dataPath = path.join(__dirname, 'data.json');

function readDeals() {
  try {
    if (!fs.existsSync(dataPath)) return [];
    const raw = fs.readFileSync(dataPath, 'utf-8');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Ошибка чтения data.json', e);
    return [];
  }
}

function writeDeals(deals) {
  fs.writeFileSync(dataPath, JSON.stringify(deals, null, 2), 'utf-8');
}

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
  const deals = readDeals().sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  res.json(deals);
});

app.post('/api/deals', checkAccess, requireAdmin, (req, res) => {
  const { id, date, amount, rateIn, rateOut, kickbackPct, createdBy } = req.body;
  if (!id || !date || !amount || !rateIn || !rateOut) {
    return res.status(400).json({ error: 'Не хватает полей' });
  }
  const deals = readDeals();
  deals.push({
    id, date, amount, rateIn, rateOut,
    kickbackPct: kickbackPct || 0,
    createdBy: createdBy || '',
    createdAt: Date.now()
  });
  writeDeals(deals);
  res.json({ ok: true });
});

app.delete('/api/deals/:id', checkAccess, requireAdmin, (req, res) => {
  const deals = readDeals().filter(d => d.id !== req.params.id);
  writeDeals(deals);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
