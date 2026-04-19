#!/usr/bin/env node
/**
 * scripts/local-stack.mjs
 *
 * Запускает полный локальный стек без Docker:
 *   1. Embedded PostgreSQL 18 (реальный PostgreSQL из npm)
 *   2. In-memory Redis (ioredis-mock, активируется через REDIS_URL=memory)
 *   3. Миграции + seed данных
 *   4. Основной сервер (tsx src/index.ts)
 *
 * Запуск: node scripts/local-stack.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// ─── Конфиг ─────────────────────────────────────────────────────────────────
const PG_PORT    = 5433;
const PG_USER    = 'salesagent';
const PG_PASS    = 'salesagent123';
const PG_DB      = 'salesagent';
const PG_DATADIR = join(ROOT, '.pgdata');
let SERVER_PORT = process.env.PORT || 3002; // will be re-read after .env loads

// Загружаем переменные из .env если есть
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('  📄 Loaded .env');
}

// ─── Проверяем обязательные ключи ────────────────────────────────────────────
const requiredKeys = ['ANTHROPIC_API_KEY', 'JWT_SECRET'];
const missing = requiredKeys.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('\n❌  Отсутствуют обязательные переменные окружения:');
  for (const k of missing) console.error(`    ${k}`);
  console.error('\nСоздай файл .env (скопируй .env.example) и заполни их.\n');
  process.exit(1);
}

// Re-read PORT after .env is loaded
SERVER_PORT = process.env.PORT || 3003;

if (!process.env['GOOGLE_API_KEY']) {
  console.warn('  ⚠️  GOOGLE_API_KEY не указан — голосовые звонки и embeddings недоступны');
  process.env['GOOGLE_API_KEY'] = 'placeholder-not-set';
}

// ─── 1. Запуск embedded PostgreSQL ───────────────────────────────────────────
console.log('\n🐘 Запуск PostgreSQL...');

const EmbeddedPostgres = (await import('embedded-postgres')).default;

const pg = new EmbeddedPostgres({
  databaseDir: PG_DATADIR,
  user:        PG_USER,
  password:    PG_PASS,
  port:        PG_PORT,
  persistent:  true,
});

try {
  await pg.initialise();
} catch (e) {
  // pgdata уже существует — пропускаем инициализацию
  if (!String(e).includes('already exist') && !String(e).includes('exit code 1')) throw e;
}
await pg.start();

console.log(`   ✅ PostgreSQL запущен на порту ${PG_PORT}`);

// ─── 2. Создаём базу данных ──────────────────────────────────────────────────
const { default: pgPkg } = await import('pg');
const { Pool } = pgPkg;

// Подключаемся к postgres (системная БД) для создания нашей
const adminPool = new Pool({
  host:     '127.0.0.1',
  port:     PG_PORT,
  user:     PG_USER,
  password: PG_PASS,
  database: 'postgres',
  max:      3,
});

try {
  await adminPool.query(`CREATE DATABASE ${PG_DB}`);
  console.log(`   ✅ База данных "${PG_DB}" создана`);
} catch (e) {
  if (e.code === '42P04') {
    console.log(`   ℹ️  База данных "${PG_DB}" уже существует`);
  } else {
    throw e;
  }
}
await adminPool.end();

// ─── 3. Применяем миграции ───────────────────────────────────────────────────
console.log('\n📦 Применяем миграции...');

const appPool = new Pool({
  host:     '127.0.0.1',
  port:     PG_PORT,
  user:     PG_USER,
  password: PG_PASS,
  database: PG_DB,
  max:      5,
});

// Включаем расширения
for (const ext of ['uuid-ossp', 'pgcrypto']) {
  try {
    await appPool.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
  } catch {/* ignore */}
}

// Читаем и применяем миграции
const migrDir = join(ROOT, 'migrations');
const migrFiles = readdirSync(migrDir)
  .filter(f => f.endsWith('.sql') && !f.startsWith('_'))
  .sort();

for (const file of migrFiles) {
  const sql = readFileSync(join(migrDir, file), 'utf8');

  // Разбиваем на инструкции
  // Учитываем $$ тела функций
  const statements = splitSqlStatements(sql);

  let successCount = 0;
  let skipCount = 0;

  for (const stmt of statements) {
    const s = stmt.trim();
    if (!s || s.length < 5) continue;

    // Пропускаем pgvector-специфичные инструкции (нет расширения)
    if (s.includes('CREATE EXTENSION') && s.includes('vector')) { skipCount++; continue; }
    if (s.includes('ivfflat')) { skipCount++; continue; }
    if (s.includes('vector_cosine_ops')) { skipCount++; continue; }
    // Функции которые зависят от pgvector операторов (<=>)
    if (s.includes('<=>')) { skipCount++; continue; }

    // Заменяем vector(768) на TEXT для совместимости без pgvector
    const safeStmt = s.replace(/\bvector\(768\)/g, 'TEXT');

    try {
      await appPool.query(safeStmt);
      successCount++;
    } catch (e) {
      // Пропускаем "already exists" ошибки (идемпотентность)
      if (e.code === '42P07' || e.code === '42710' || e.code === '42P16' ||
          e.message?.includes('already exists')) {
        skipCount++;
      } else {
        // Другие ошибки логируем но не падаем
        console.warn(`   ⚠️  [${file}] ${e.message?.split('\n')[0]}`);
      }
    }
  }

  console.log(`   ✅ ${file} (ok: ${successCount}, skip: ${skipCount})`);
}

// ─── 4. Seed demo данных ─────────────────────────────────────────────────────
console.log('\n🌱 Проверяем демо-данные...');

const { rows: orgs } = await appPool.query(`SELECT id FROM organizations WHERE slug = 'tsvetochny-mir'`);

if (orgs.length === 0) {
  await seedDemoData(appPool);
  console.log('   ✅ Демо-данные загружены: org=Цветочный мир');
} else {
  console.log('   ℹ️  Демо-данные уже есть');
}

// Получаем org_id для вывода
const { rows: [org] } = await appPool.query(`SELECT id FROM organizations WHERE slug = 'tsvetochny-mir'`);
await appPool.end();

// ─── 5. Запускаем сервер ─────────────────────────────────────────────────────
console.log('\n🚀 Запускаем SalesAgent AI...\n');

const DATABASE_URL = `postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}`;

const env = {
  ...process.env,
  NODE_ENV:        'development',
  PORT:            String(SERVER_PORT),
  DATABASE_URL,
  REDIS_URL:       'memory',
  JWT_SECRET:      process.env.JWT_SECRET || 'dev-secret-must-be-32-characters!!',
  FRONTEND_URL:    `http://localhost:5174`,
  API_BASE_URL:    `http://localhost:${SERVER_PORT}`,
};

const server = spawn(
  'node',
  ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'],
  {
    cwd:   ROOT,
    env,
    stdio: 'inherit',
  }
);

server.on('error', err => {
  console.error('Ошибка запуска сервера:', err);
  process.exit(1);
});

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Остановка...');
  server.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
}

process.on('SIGINT',  () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';

  const lines = sql.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Пропускаем строчные комментарии
    if (!inDollarQuote && trimmed.startsWith('--')) {
      continue;
    }

    current += line + '\n';

    // Проверяем $$ теги
    const dollarMatches = line.match(/\$\w*\$/g) || [];
    for (const tag of dollarMatches) {
      if (!inDollarQuote) {
        inDollarQuote = true;
        dollarTag = tag;
      } else if (tag === dollarTag) {
        inDollarQuote = false;
        dollarTag = '';
      }
    }

    // Если не внутри $$ блока и строка заканчивается на ;
    if (!inDollarQuote && trimmed.endsWith(';')) {
      statements.push(current.trim().replace(/;$/, ''));
      current = '';
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

async function seedDemoData(pool) {
  const { v4: uuid } = await import('uuid');

  // Используем bcryptjs через require (CommonJS)
  const bcrypt = require('bcryptjs');

  const orgId   = uuid();
  const userId  = uuid();
  const agentId = uuid();

  await pool.query(
    `INSERT INTO organizations (id, name, slug, country, currency, timezone)
     VALUES ($1, 'Цветочный мир', 'tsvetochny-mir', 'KZ', 'KZT', 'Asia/Almaty')`,
    [orgId]
  );

  await pool.query(
    `INSERT INTO subscriptions (org_id, plan, status, messages_limit, minutes_limit)
     VALUES ($1, 'trial', 'active', 5000, 500)`,
    [orgId]
  );

  const passwordHash = await bcrypt.hash('demo1234', 10);
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, full_name, role)
     VALUES ($1, $2, 'admin@demo.kz', $3, 'Администратор', 'admin')`,
    [userId, orgId, passwordHash]
  );

  await pool.query(
    `INSERT INTO agents (id, org_id, name, system_prompt, channels, is_active)
     VALUES ($1, $2, 'Айгуль',
       $3,
       ARRAY['whatsapp','telegram','voice'], true)`,
    [agentId, orgId,
     'Ты — Айгуль, дружелюбный консультант цветочного магазина "Цветочный мир". Помоги клиенту выбрать букет и оформить заказ. Используй search_knowledge() для поиска товаров и цен в каталоге.']
  );

  // 5 лидов
  const leads = [
    { phone: '+77011111111', name: 'Алия Сейткали',  stage: 'interested',     score: 70, source: 'whatsapp' },
    { phone: '+77022222222', name: 'Марат Бекенов',  stage: 'meeting_booked', score: 85, source: 'telegram' },
    { phone: '+77033333333', name: 'Салтанат Нурова', stage: 'new',           score: 20, source: 'whatsapp' },
    { phone: '+77044444444', name: 'Динара Ахметова', stage: 'closed_won',    score: 95, source: 'voice'    },
    { phone: '+77055555555', name: 'Аслан Касымов',  stage: 'negotiation',    score: 65, source: 'telegram' },
  ];

  for (const lead of leads) {
    await pool.query(
      `INSERT INTO leads (org_id, phone, name, stage, source, score)
       VALUES ($1, $2, $3, $4::lead_stage, $5, $6)`,
      [orgId, lead.phone, lead.name, lead.stage, lead.source, lead.score]
    );
  }

  console.log(`   org_id: ${orgId}`);
  console.log(`   Логин: admin@demo.kz / demo1234`);
}
