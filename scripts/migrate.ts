import { closeDb } from '../src/db';
import { runMigrations } from '../src/migrations';

async function migrate(): Promise<void> {
  try {
    const applied = await runMigrations();
    if (applied.length === 0) console.log('Database is up to date');
    for (const filename of applied) console.log(`Applied ${filename}`);
  } finally {
    await closeDb();
  }
}

migrate().catch(error => { console.error(error); process.exit(1); });
