/**
 * Скрипт применения SQL-миграций
 * Запуск: npm run migrate:dev
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

async function migrate() {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  // Only numbered, active migrations are executable. Files prefixed with
  // `_old_` are retained as historical references and must never be applied.
  const files = fs.readdirSync(migrationsDir)
    .filter(file => /^\d{3}_[A-Za-z0-9_-]+\.sql$/.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error('No active migrations matching NNN_*.sql were found');
  }

  const client = await pool.connect();
  try {
    // Создаём таблицу для отслеживания миграций
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const file of files) {
      const exists = await client.query(
        'SELECT 1 FROM _migrations WHERE filename = $1',
        [file]
      );
      if (exists.rows.length > 0) {
        console.log(`⏭  ${file} (already applied)`);
        continue;
      }

      console.log(`▶  Applying ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✅ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('\n✅ All migrations applied');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
