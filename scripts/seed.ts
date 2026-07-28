/** Seed data for a fresh MySQL schema. Run: npm run seed */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import pool, { closeDb } from '../src/db';

const prompt = `Ты — Айгуль, менеджер по продажам цветочного магазина. Помоги клиенту выбрать букет и оформить заказ. Перед ответами о товарах, ценах и доставке используй search_knowledge(). Когда клиент готов купить — обнови статус лида.`;
const knowledge = [
  ['bouquets', 'Букет «Нежность»: 25 розовых роз с гипсофилой, 15 000 тенге.'],
  ['bouquets', 'Букет «Страсть»: 51 красная роза, 45 000 тенге.'],
  ['bouquets', 'Букет «Весенний день»: тюльпаны, нарциссы и гиацинты, 12 000 тенге.'],
  ['bouquets', 'Мини-букет «Комплимент»: 7 роз, 4 500 тенге.'],
  ['upsell', 'Дополнения: открытка +500 тенге, конфеты +2 000 тенге, мишка +3 500 тенге.'],
  ['delivery', 'Доставка по Алматы: 1 500 тенге за 2 часа, срочная за час — 2 500 тенге, самовывоз бесплатный.'],
] as const;

async function seed(): Promise<void> {
  const adminPassword = process.env['SEED_ADMIN_PASSWORD'];
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must contain at least 12 characters');
  }
  const orgId = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name, slug, plan, timezone, country, currency)
     VALUES ($1,$2,$3,'starter','Asia/Almaty','KZ','KZT')
     ON DUPLICATE KEY UPDATE id = id`,
    [orgId, 'Demo Flower Shop — Цветы Алматы', 'demo-flower-shop']
  );
  const org = await pool.query<{ id: string }>('SELECT id FROM organizations WHERE slug = $1', ['demo-flower-shop']);
  const actualOrgId = org.rows[0]!.id;
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, full_name, role)
     VALUES ($1,$2,$3,$4,$5,'admin') ON DUPLICATE KEY UPDATE id = id`,
    [randomUUID(), actualOrgId, 'demo@flowers.kz', passwordHash, 'Администратор']
  );
  await pool.query(
    `INSERT INTO subscriptions (id, org_id, plan, messages_limit, minutes_limit)
     VALUES ($1,$2,'starter',5000,500) ON DUPLICATE KEY UPDATE id = id`,
    [randomUUID(), actualOrgId]
  );
  await pool.query(
    `INSERT INTO agents (id, org_id, name, system_prompt, channels, voice_config, model_text, temperature, max_tokens, is_active)
     SELECT $1,$2,'Айгуль',$3,$4,$5,'openrouter/auto',0.8,1024,true
     WHERE NOT EXISTS (SELECT 1 FROM agents WHERE org_id = $2 AND name = 'Айгуль')`,
    [randomUUID(), actualOrgId, prompt, JSON.stringify(['whatsapp', 'telegram', 'voice']), JSON.stringify({ provider: 'fish', language: 'ru-RU', speed: 1 })]
  );
  for (let index = 0; index < knowledge.length; index++) {
    const [category, content] = knowledge[index]!;
    await pool.query(
      `INSERT INTO knowledge_chunks (id, org_id, content, category, source_file, chunk_index)
       SELECT $1,$2,$3,$4,'seed_flowers.md',$5
       WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks WHERE org_id = $2 AND source_file = 'seed_flowers.md' AND chunk_index = $5)`,
      [randomUUID(), actualOrgId, content, category, index]
    );
  }
  console.log('Seed complete. Login: demo@flowers.kz');
  await closeDb();
}

seed().catch(error => { console.error('Seed failed:', error); process.exit(1); });
