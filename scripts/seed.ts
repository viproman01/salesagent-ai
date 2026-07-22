/**
 * Seed script: создаёт тестовые данные для демонстрации
 * Запуск: npm run seed
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { validate as isUuid, v4 as uuidv4 } from 'uuid';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });

// Системный промпт агента "Айгуль" — менеджер цветочного магазина
const AIGUL_SYSTEM_PROMPT = `Ты — Айгуль, менеджер по продажам цветочного магазина. Твоя задача — помочь клиенту выбрать букет и оформить заказ, максимизируя средний чек через upsell. Этапы: 1) Приветствие, 2) Узнай повод и бюджет, 3) Используй search_knowledge() для поиска подходящих букетов, предложи 2-3, 4) Предложи upsell (открытка +500тг, конфеты +2000тг), 5) Уточни доставку. При возражении "дорого" — предложи альтернативу. Тон дружелюбный, используй эмодзи. Когда клиент готов купить — вызови update_lead() со stage='negotiation'. После согласия на доставку — book_meeting() и update_lead(stage='closed_won').`;

// База знаний: 10 букетов цветочного магазина
const FLOWER_KNOWLEDGE = [
  {
    name: 'Нежность',
    content: `Букет "Нежность" — 25 розовых роз с белой гипсофилой. Цена: 15 000 тенге. Идеален на день рождения, 8 марта, годовщину. Размер: стандартный (высота 50 см). Доступен: всегда. Состав: розы Pink Floyd 25 шт, гипсофила, упаковка крафт с лентой.`,
    category: 'bouquets',
  },
  {
    name: 'Страсть',
    content: `Букет "Страсть" — 51 красная роза премиум класса. Цена: 45 000 тенге. Подходит для признания в любви, предложения руки и сердца. Размер: большой (высота 70 см). Состав: розы Red Naomi 51 шт, зелень рускус, упаковка дизайнерская.`,
    category: 'bouquets',
  },
  {
    name: 'Весенний день',
    content: `Букет "Весенний день" — сборный из тюльпанов, нарциссов и гиацинтов. Цена: 12 000 тенге. Символизирует приход весны, свежесть. Подходит на 8 марта, день учителя. Состав: тюльпаны 15 шт, нарциссы 5 шт, гиацинт 3 шт.`,
    category: 'bouquets',
  },
  {
    name: 'Экзотика',
    content: `Букет "Экзотика" — орхидеи с экзотической зеленью. Цена: 28 000 тенге. Эксклюзивный подарок для особого человека. Состав: орхидеи 7 шт, монстера 3 листа, антуриум 2 шт. Долго стоит — 10-14 дней.`,
    category: 'bouquets',
  },
  {
    name: 'Подружка',
    content: `Букет "Подружка" — ромашки, хризантемы, эустома. Цена: 8 500 тенге. Лёгкий, воздушный букет для подруг, коллег, мамы. Хорошая цена при хорошем качестве. Состав: ромашки 10 шт, хризантемы 5 шт, эустома 7 шт.`,
    category: 'bouquets',
  },
  {
    name: 'Бизнес-класс',
    content: `Букет "Бизнес-класс" — строгий и стильный из красных гербер и зелени. Цена: 18 000 тенге. Для деловых партнёров, руководителей. Состав: герберы красные 21 шт, хамедорея, упаковка лён.`,
    category: 'bouquets',
  },
  {
    name: 'Мини-букет',
    content: `Мини-букет "Комплимент" — 7 роз с зеленью. Цена: 4 500 тенге. Небольшой приятный подарок, когда не нужно шикать. Подходит как комплимент на любой случай. Отличный вариант при бюджете до 5 000 тенге.`,
    category: 'bouquets',
  },
  {
    name: 'Пионы премиум',
    content: `Букет из пионов "Розовое облако" — 15 пионов Sarah Bernhardt. Цена: 35 000 тенге. Роскошный аромат, пышные цветы. Сезонный товар (май-июнь). Подходит на свадьбы, важные события. Срок жизни 5-7 дней.`,
    category: 'bouquets',
  },
  {
    name: 'Добавки к букету',
    content: `Дополнения к букету: открытка с надписью +500 тенге, коробка конфет Рафаэлло +2 000 тенге, мягкая игрушка мишка +3 500 тенге, шары воздушные (5 шт) +1 500 тенге, декоративная коробка вместо упаковки +800 тенге.`,
    category: 'upsell',
  },
  {
    name: 'Условия доставки',
    content: `Доставка цветов: по Алматы — 1 500 тенге (в течение 2 часов), срочная доставка за 1 час — 2 500 тенге, самовывоз — бесплатно. Режим работы магазина: 08:00-22:00 без выходных. Оплата: карта, наличные, QR-код Kaspi. Предварительный заказ принимается за 24 часа.`,
    category: 'delivery',
  },
];

async function seed() {
  const client = await pool.connect();

  try {
    console.log('🌱 Начало сидирования базы данных...');

    // ---- Организация ----
    const configuredVoiceOrgId = process.env['VOICE_DEFAULT_ORG_ID']?.trim();
    if (configuredVoiceOrgId && !isUuid(configuredVoiceOrgId)) {
      throw new Error('VOICE_DEFAULT_ORG_ID must be a valid UUID');
    }
    // В локальном voice-контуре seed должен создать того же tenant, который
    // разрешён WebSocket-конфигурацией. Без явного значения сохраняем прежнее
    // поведение со случайным UUID.
    const orgId = configuredVoiceOrgId || uuidv4();
    await client.query(
      `INSERT INTO organizations (id, name, slug, plan, timezone, country, currency)
       VALUES ($1, $2, $3, 'starter', 'Asia/Almaty', 'KZ', 'KZT')
       ON CONFLICT (slug) DO NOTHING`,
      [orgId, 'Demo Flower Shop — Цветы Алматы', 'demo-flower-shop']
    );

    // Получаем существующий или созданный org_id
    const orgResult = await client.query<{ id: string }>(
      `SELECT id FROM organizations WHERE slug = 'demo-flower-shop'`
    );
    const actualOrgId = orgResult.rows[0]!.id;
    if (configuredVoiceOrgId && actualOrgId !== configuredVoiceOrgId) {
      throw new Error(
        'Existing demo organization does not match VOICE_DEFAULT_ORG_ID'
      );
    }

    console.log(`✅ Организация: ${actualOrgId}`);

    // ---- Пользователь ----
    const passwordHash = await bcrypt.hash('demo1234', 12);
    await client.query(
      `INSERT INTO users (org_id, email, password_hash, full_name, role)
       VALUES ($1, 'demo@flowers.kz', $2, 'Администратор', 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [actualOrgId, passwordHash]
    );

    // ---- Подписка ----
    await client.query(
      `INSERT INTO subscriptions (org_id, plan, messages_limit, minutes_limit)
       VALUES ($1, 'starter', 5000, 500)
       ON CONFLICT (org_id) DO NOTHING`,
      [actualOrgId]
    );

    console.log('✅ Пользователь: demo@flowers.kz / demo1234');

    // ---- Агент "Айгуль" ----
    const agentResult = await client.query<{ id: string }>(
      `INSERT INTO agents
         (org_id, name, system_prompt, channels, voice_config, temperature)
       VALUES ($1, 'Айгуль', $2, ARRAY['whatsapp','telegram','voice','webchat'],
               '{"voice":"Aoede","language":"ru-RU","speed":1.0}'::jsonb, 0.8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [actualOrgId, AIGUL_SYSTEM_PROMPT]
    );

    const agentId = agentResult.rows[0]?.id;
    if (!agentId) {
      // Агент уже существует — получаем его id
      const existingAgent = await client.query<{ id: string }>(
        'SELECT id FROM agents WHERE org_id = $1 AND name = $2',
        [actualOrgId, 'Айгуль']
      );
      console.log(`✅ Агент "Айгуль" уже существует: ${existingAgent.rows[0]?.id}`);
    } else {
      console.log(`✅ Агент "Айгуль": ${agentId}`);
    }

    // ---- База знаний ----
    console.log('📚 Загрузка базы знаний...');
    // Пропускаем embedding — генерируем без них (embeddings добавляются через API)
    let chunkIndex = 0;
    for (const item of FLOWER_KNOWLEDGE) {
      await client.query(
        `INSERT INTO knowledge_chunks (org_id, content, category, source_file, chunk_index)
         VALUES ($1, $2, $3, 'seed_flowers.md', $4)
         ON CONFLICT DO NOTHING`,
        [actualOrgId, item.content, item.category, chunkIndex++]
      );
    }
    console.log(`✅ База знаний: ${FLOWER_KNOWLEDGE.length} записей`);

    // ---- Тестовые лиды ----
    const leads = [
      {
        phone:  '77011234567',
        name:   'Алия Сейткали',
        stage:  'interested',
        score:  70,
        source: 'whatsapp',
      },
      {
        phone:  '77029876543',
        name:   'Марат Бекенов',
        stage:  'meeting_booked',
        score:  85,
        source: 'telegram',
      },
      {
        phone:  '77075551234',
        name:   'Салтанат Нурова',
        stage:  'new',
        score:  20,
        source: 'whatsapp',
      },
    ];

    for (const lead of leads) {
      await client.query(
        `INSERT INTO leads (org_id, phone, name, stage, score, source)
         VALUES ($1, $2, $3, $4::lead_stage, $5, $6)
         ON CONFLICT (org_id, phone) DO NOTHING`,
        [actualOrgId, lead.phone, lead.name, lead.stage, lead.score, lead.source]
      );
    }
    console.log(`✅ Лиды: ${leads.length} записей`);

    console.log('\n🎉 Сидирование завершено!');
    console.log('---');
    console.log(`Логин:    demo@flowers.kz`);
    console.log(`Пароль:   demo1234`);
    console.log(`Org ID:   ${actualOrgId}`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
