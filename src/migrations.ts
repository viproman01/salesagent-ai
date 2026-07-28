import fs from 'fs';
import path from 'path';
import pool from './db';
import { logger } from './utils/logger';

export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (filename VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    );
    const directory = path.join(process.cwd(), 'migrations', 'mysql');
    if (!fs.existsSync(directory)) {
      throw new Error(`Migration directory is missing: ${directory}`);
    }

    for (const filename of fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
      const existing = await client.query<{ filename: string }>(
        'SELECT filename FROM _migrations WHERE filename = $1',
        [filename]
      );
      if (existing.rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
      await client.beginTransaction();
      try {
        const statements = sql
          .split(/;\s*(?:\r?\n|$)/)
          .map(statement => statement.trim())
          .filter(Boolean);
        for (const statement of statements) await client.query(statement);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
        await client.commit();
        applied.push(filename);
        logger.info('Database migration applied', { filename });
      } catch (error) {
        await client.rollback();
        throw error;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}
