/**
 * Dev Bootstrap: запускает сервер с in-memory PostgreSQL (pg-mem) и
 * in-memory Redis (ioredis-mock), без внешних зависимостей.
 *
 * Используй: tsx src/dev-bootstrap.ts
 *
 * ВАЖНО: этот файл использует require() чтобы патчить модули ДО
 * того, как они будут загружены основным приложением.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  console.log('🚀 Dev Bootstrap: подготовка in-memory сервисов...');

  // ====================================================
  // 1. Патчим pg → pg-mem (in-memory PostgreSQL)
  // ====================================================
  try {
    const { newDb } = require('pg-mem');
    const db = newDb();

    // Применяем SQL миграции
    const migrDir = path.join(process.cwd(), 'migrations');
    if (fs.existsSync(migrDir)) {
      const files = fs.readdirSync(migrDir)
        .filter((f: string) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrDir, file), 'utf8');
        // Разбиваем по ';' и выполняем поочерёдно
        const statements = sql
          .split(';')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 5);

        for (const stmt of statements) {
          try {
            db.public.none(stmt + ';');
          } catch {
            // Пропускаем ошибки (расширения, уже существующие объекты)
          }
        }
        console.log(`  ✅ Migration: ${file}`);
      }
    }

    // Создаём pg-совместимый Pool
    const pgMem = db.adapters.createPg();

    // Патчим require.cache для 'pg'
    const pgPath = require.resolve('pg');
    (require as any).cache[pgPath] = {
      id: pgPath,
      filename: pgPath,
      loaded: true,
      exports: pgMem,
      parent: null,
      children: [],
      paths: [],
    };
    console.log('  ✅ PostgreSQL: in-memory (pg-mem)');

    // Сидируем демо-данные
    await seedDemoData(pgMem);

  } catch (err) {
    console.warn('  ⚠️  pg-mem недоступен, используем реальный PostgreSQL:', err instanceof Error ? err.message : err);
  }

  // ====================================================
  // 2. Патчим ioredis → ioredis-mock (in-memory Redis)
  // ====================================================
  try {
    const IORedisMock = require('ioredis-mock');
    const ioredisPath = require.resolve('ioredis');

    (require as any).cache[ioredisPath] = {
      id: ioredisPath,
      filename: ioredisPath,
      loaded: true,
      exports: { default: IORedisMock, Redis: IORedisMock },
      parent: null,
      children: [],
      paths: [],
    };
    console.log('  ✅ Redis: in-memory (ioredis-mock)');
  } catch (err) {
    console.warn('  ⚠️  ioredis-mock недоступен:', err instanceof Error ? err.message : err);
  }

  console.log('');
  console.log('🏃 Запускаем сервер...');
  console.log('');

  // ====================================================
  // 3. Загружаем основной сервер
  // ====================================================
  require('./index');
}

async function seedDemoData(pgMem: { Pool: new () => any }) {
  try {
    const { Pool } = pgMem;
    const pool = new Pool();

    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');

    // Организация
    const orgId = uuidv4();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, country, currency, timezone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, 'Цветочный мир', 'tsvetochny-mir', 'KZ', 'KZT', 'Asia/Almaty']
    );

    // Подписка
    await pool.query(
      `INSERT INTO subscriptions (org_id, plan, status, dialogs_limit)
       VALUES ($1, 'trial', 'trial', 500)`,
      [orgId]
    );

    // Администратор
    const passwordHash = await bcrypt.hash('demo1234', 10);
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [userId, orgId, 'admin@demo.kz', passwordHash, 'Администратор']
    );

    // Агент
    const agentId = uuidv4();
    const systemPrompt = `Ты — Айгуль, дружелюбный консультант цветочного магазина "Цветочный мир".
Помоги клиенту выбрать букет и оформить заказ. Используй search_knowledge() для поиска товаров.`;

    await pool.query(
      `INSERT INTO agents (id, org_id, name, system_prompt, channels, is_active)
       VALUES ($1, $2, $3, $4, ARRAY['whatsapp','telegram','voice','webchat'], true)`,
      [agentId, orgId, 'Айгуль', systemPrompt]
    );

    // 3 тестовых лида
    for (const lead of [
      { phone: '+77011111111', name: 'Дамир', stage: 'new' },
      { phone: '+77022222222', name: 'Меруерт', stage: 'negotiation' },
      { phone: '+77033333333', name: 'Арман', stage: 'contacted' },
    ]) {
      await pool.query(
        `INSERT INTO leads (org_id, phone, name, stage, source, score)
         VALUES ($1, $2, $3, $4::lead_stage, 'whatsapp', $5)`,
        [orgId, lead.phone, lead.name, lead.stage, 50]
      );
    }

    await pool.end();
    console.log('  ✅ Demo data: org=Цветочный мир, user=admin@demo.kz / demo1234');
  } catch (err) {
    console.warn('  ⚠️  Seed ошибка:', err instanceof Error ? err.message : err);
  }
}

bootstrap().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
