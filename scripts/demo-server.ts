/**
 * Standalone demo server — работает без PostgreSQL/Redis/Docker.
 * Включает:
 * - Admin API (in-memory)
 * - Telegram-бот (polling, не нужен публичный сервер)
 * - Claude AI-агент с tool use (search_knowledge, update_lead, book_meeting)
 * - In-memory база знаний (цветочный магазин)
 *
 * Запуск: node node_modules/tsx/dist/cli.mjs scripts/demo-server.ts
 */
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer, WebSocket as WS } from 'ws';

dotenv.config();

const PORT = parseInt(process.env['PORT'] ?? '3002');
const JWT_SECRET = 'demo-secret-key-for-testing-only-32chars!';
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'] ?? '';
const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

if (!ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY не задан — AI-агент не будет работать');
if (!TELEGRAM_BOT_TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запустится');

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ============================================================
// In-memory база данных
// ============================================================
const ORG_ID = uuid();
const AGENT_ID = uuid();
const USER_ID = uuid();

const passwordHash = bcrypt.hashSync('demo1234', 12);

const users = [
  { id: USER_ID, org_id: ORG_ID, email: 'demo@flowers.kz', password_hash: passwordHash, full_name: 'Администратор', role: 'admin' }
];

// Системный промпт агента
const AIGUL_PROMPT = `Ты — Айгуль, менеджер по продажам цветочного магазина. Твоя задача — помочь клиенту выбрать букет и оформить заказ, максимизируя средний чек через upsell. Этапы: 1) Приветствие, 2) Узнай повод и бюджет, 3) Используй search_knowledge() для поиска подходящих букетов, предложи 2-3, 4) Предложи upsell (открытка +500тг, конфеты +2000тг), 5) Уточни доставку. При возражении "дорого" — предложи альтернативу. Тон дружелюбный, используй эмодзи. Когда клиент готов купить — вызови update_lead() со stage='negotiation'. После согласия на доставку — book_meeting() и update_lead(stage='closed_won').`;

const agents = [
  {
    id: AGENT_ID, org_id: ORG_ID, name: 'Айгуль',
    system_prompt: AIGUL_PROMPT,
    channels: ['whatsapp', 'telegram', 'voice'],
    voice_config: { voice: 'Aoede', language: 'ru-RU', speed: 1.0 },
    model_text: 'claude-sonnet-4-20250514', model_voice: 'gemini-3.1-flash-live-preview',
    temperature: 0.7, max_tokens: 1024, is_active: true,
    created_at: new Date().toISOString(),
  }
];

// База знаний цветочного магазина
const knowledgeBase = [
  { content: 'Букет "Нежность" — 25 розовых роз с белой гипсофилой. Цена: 15 000 тенге. Идеален на день рождения, 8 марта, годовщину. Размер: стандартный (высота 50 см). Состав: розы Pink Floyd 25 шт, гипсофила, упаковка крафт с лентой.', category: 'bouquets' },
  { content: 'Букет "Страсть" — 51 красная роза премиум класса. Цена: 45 000 тенге. Подходит для признания в любви, предложения руки и сердца. Размер: большой (высота 70 см). Состав: розы Red Naomi 51 шт, зелень рускус, упаковка дизайнерская.', category: 'bouquets' },
  { content: 'Букет "Весенний день" — сборный из тюльпанов, нарциссов и гиацинтов. Цена: 12 000 тенге. Символизирует приход весны, свежесть. Подходит на 8 марта, день учителя. Состав: тюльпаны 15 шт, нарциссы 5 шт, гиацинт 3 шт.', category: 'bouquets' },
  { content: 'Букет "Экзотика" — орхидеи с экзотической зеленью. Цена: 28 000 тенге. Эксклюзивный подарок для особого человека. Состав: орхидеи 7 шт, монстера 3 листа, антуриум 2 шт. Долго стоит — 10-14 дней.', category: 'bouquets' },
  { content: 'Букет "Подружка" — ромашки, хризантемы, эустома. Цена: 8 500 тенге. Лёгкий, воздушный букет для подруг, коллег, мамы. Хорошая цена при хорошем качестве. Состав: ромашки 10 шт, хризантемы 5 шт, эустома 7 шт.', category: 'bouquets' },
  { content: 'Букет "Бизнес-класс" — строгий и стильный из красных гербер и зелени. Цена: 18 000 тенге. Для деловых партнёров, руководителей. Состав: герберы красные 21 шт, хамедорея, упаковка лён.', category: 'bouquets' },
  { content: 'Мини-букет "Комплимент" — 7 роз с зеленью. Цена: 4 500 тенге. Небольшой приятный подарок, когда не нужно шикать. Подходит как комплимент на любой случай. Отличный вариант при бюджете до 5 000 тенге.', category: 'bouquets' },
  { content: 'Букет из пионов "Розовое облако" — 15 пионов Sarah Bernhardt. Цена: 35 000 тенге. Роскошный аромат, пышные цветы. Сезонный товар (май-июнь). Подходит на свадьбы, важные события.', category: 'bouquets' },
  { content: 'Дополнения к букету: открытка с надписью +500 тенге, коробка конфет Рафаэлло +2 000 тенге, мягкая игрушка мишка +3 500 тенге, шары воздушные (5 шт) +1 500 тенге, декоративная коробка вместо упаковки +800 тенге.', category: 'upsell' },
  { content: 'Доставка цветов: по Алматы — 1 500 тенге (в течение 2 часов), срочная доставка за 1 час — 2 500 тенге, самовывоз — бесплатно. Режим работы магазина: 08:00-22:00 без выходных. Оплата: карта, наличные, QR-код Kaspi. Предварительный заказ принимается за 24 часа.', category: 'delivery' },
];

// Лиды и разговоры (in-memory)
interface Lead {
  id: string; org_id: string; phone: string; name: string | null;
  stage: string; score: number; source: string; created_at: string;
}
interface Conversation {
  id: string; org_id: string; lead_id: string; agent_id: string;
  channel: string; status: string; message_count: number; duration_seconds: number | null;
  sentiment: string | null; summary: string | null;
  started_at: string; ended_at: string | null; last_message_at: string | null;
  phone: string; lead_name: string | null; lead_stage: string; agent_name: string;
  created_at: string;
}
interface Msg {
  id: string; role: string; content: string | null;
  tool_name: string | null; tool_input: unknown; tool_result: unknown;
  tokens_input: number | null; tokens_output: number | null; latency_ms: number | null;
  created_at: string;
}

const leads: Lead[] = [
  { id: uuid(), org_id: ORG_ID, phone: '77011234567', name: 'Алия Сейткали', stage: 'interested', score: 70, source: 'whatsapp', created_at: '2026-04-10T10:00:00Z' },
  { id: uuid(), org_id: ORG_ID, phone: '77029876543', name: 'Марат Бекенов', stage: 'meeting_booked', score: 85, source: 'telegram', created_at: '2026-04-11T14:00:00Z' },
  { id: uuid(), org_id: ORG_ID, phone: '77075551234', name: 'Салтанат Нурова', stage: 'new', score: 20, source: 'whatsapp', created_at: '2026-04-13T09:00:00Z' },
];

const allConversations: Conversation[] = [];
const allMessages: Record<string, Msg[]> = {};
// Хранилище истории чатов для Telegram (chatId → messages для Claude)
const chatHistories: Record<string, Array<Anthropic.MessageParam>> = {};

// ============================================================
// Claude AI Agent с Tool Use
// ============================================================
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_knowledge',
    description: 'Поиск по базе знаний компании — букеты, цены, условия доставки',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'Поисковый запрос' } },
      required: ['query'],
    },
  },
  {
    name: 'update_lead',
    description: 'Обновить статус лида в CRM',
    input_schema: {
      type: 'object' as const,
      properties: {
        stage: { type: 'string', enum: ['new', 'interested', 'negotiation', 'meeting_booked', 'closed_won', 'closed_lost'] },
        notes: { type: 'string' },
      },
      required: ['stage'],
    },
  },
  {
    name: 'book_meeting',
    description: 'Записать клиента на встречу или доставку',
    input_schema: {
      type: 'object' as const,
      properties: {
        datetime: { type: 'string', description: 'Дата и время в формате ISO 8601' },
        type: { type: 'string', enum: ['demo', 'appointment', 'delivery', 'callback'] },
      },
      required: ['datetime', 'type'],
    },
  },
];

function searchKnowledge(query: string): string[] {
  const q = query.toLowerCase();
  // Простой текстовый поиск (в продакшне — pgvector cosine similarity)
  const results = knowledgeBase
    .filter(kb => {
      const c = kb.content.toLowerCase();
      const words = q.split(/\s+/);
      return words.some(w => w.length > 2 && c.includes(w));
    })
    .slice(0, 3)
    .map(kb => kb.content);
  // Если ничего не нашли — вернём всю базу (для демо)
  return results.length > 0 ? results : knowledgeBase.slice(0, 3).map(kb => kb.content);
}

async function getAgentResponse(chatId: string, userMessage: string): Promise<string> {
  if (!anthropic) return '⚠️ AI-агент не настроен (нет ANTHROPIC_API_KEY)';

  // Добавляем сообщение пользователя в историю
  if (!chatHistories[chatId]) chatHistories[chatId] = [];
  chatHistories[chatId]!.push({ role: 'user', content: userMessage });

  // Ограничиваем историю 20 последними сообщениями
  if (chatHistories[chatId]!.length > 20) {
    chatHistories[chatId] = chatHistories[chatId]!.slice(-20);
  }

  const messages = [...chatHistories[chatId]!];
  let finalText = '';

  // Tool use loop
  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: AIGUL_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const input = block.input as Record<string, unknown>;
        let result: unknown;

        console.log(`  🔧 Tool: ${block.name}`, JSON.stringify(input));

        switch (block.name) {
          case 'search_knowledge': {
            const chunks = searchKnowledge(input['query'] as string);
            result = { results: chunks.map(c => ({ content: c })) };
            break;
          }
          case 'update_lead': {
            const lead = leads.find(l => l.phone === chatId) ?? leads[0];
            if (lead) {
              lead.stage = input['stage'] as string;
              lead.score = Math.min(100, lead.score + 15);
            }
            result = { success: true, stage: input['stage'], message: `Лид → ${input['stage']}` };
            console.log(`  ✅ Lead updated: ${input['stage']}`);
            break;
          }
          case 'book_meeting': {
            result = { success: true, datetime: input['datetime'], type: input['type'], message: `Встреча запланирована` };
            console.log(`  📅 Meeting booked: ${input['type']} at ${input['datetime']}`);
            break;
          }
          default:
            result = { error: `Unknown tool: ${block.name}` };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  // Сохраняем ответ ассистента в историю
  chatHistories[chatId]!.push({ role: 'assistant', content: finalText });

  return finalText;
}

// ============================================================
// Telegram Bot (long polling — не нужен публичный сервер)
// ============================================================
let tgOffset = 0;

async function startTelegramPolling() {
  if (!TELEGRAM_BOT_TOKEN) return;

  // Получаем инфо о боте
  try {
    const me = await axios.get(`${TG_API}/getMe`);
    console.log(`🤖 Telegram бот: @${me.data.result.username} (${me.data.result.first_name})`);
    // Убираем webhook если был
    await axios.post(`${TG_API}/deleteWebhook`);
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: unknown }; message?: string }).response?.data ?? (err as Error).message;
    console.error('❌ Telegram: не удалось подключиться', msg);
    return;
  }

  console.log('📡 Telegram polling started...\n');

  // Polling loop
  const poll = async () => {
    try {
      const resp = await axios.get(`${TG_API}/getUpdates`, {
        params: { offset: tgOffset, timeout: 30, allowed_updates: JSON.stringify(['message']) },
        timeout: 35000,
      });

      const updates = resp.data.result as Array<{
        update_id: number;
        message?: {
          message_id: number;
          from: { id: number; first_name: string; username?: string };
          chat: { id: number };
          text?: string;
        };
      }>;

      for (const update of updates) {
        tgOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);
        const text = msg.text;
        const userName = msg.from.first_name;

        // Команда /start
        if (text === '/start') {
          await sendTelegramMessage(chatId,
            `Привет, ${userName}! 🌸\n\nЯ — Айгуль, менеджер цветочного магазина.\nПомогу подобрать букет и оформить доставку!\n\nНапишите, что ищете — например:\n• "Хочу букет на день рождения"\n• "Что есть до 15000 тенге?"\n• "Какие есть розы?"`
          );
          continue;
        }

        console.log(`💬 [${userName}] ${text}`);

        // Отправляем "typing..."
        await axios.post(`${TG_API}/sendChatAction`, { chat_id: chatId, action: 'typing' }).catch(() => {});

        // Получаем ответ от Claude
        try {
          const reply = await getAgentResponse(chatId, text);
          await sendTelegramMessage(chatId, reply);
          console.log(`🤖 [Айгуль] ${reply.slice(0, 100)}...`);

          // Сохраняем в in-memory для админки
          saveConversation(chatId, userName, text, reply);
        } catch (err) {
          console.error('❌ Agent error:', (err as Error).message);
          await sendTelegramMessage(chatId, '😔 Извините, произошла ошибка. Попробуйте ещё раз через минуту.');
        }
      }
    } catch (err: unknown) {
      const errMsg = (err as Error).message;
      if (!errMsg.includes('ETIMEDOUT') && !errMsg.includes('ECONNRESET')) {
        console.error('Polling error:', errMsg);
      }
    }

    // Продолжаем polling
    setTimeout(poll, 100);
  };

  poll();
}

async function sendTelegramMessage(chatId: string, text: string) {
  // Telegram ограничивает длину — разбиваем длинные
  const maxLen = 4000;
  if (text.length <= maxLen) {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'Markdown',
    }).catch(async () => {
      // Если Markdown не парсится — отправляем без форматирования
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text });
    });
  } else {
    for (let i = 0; i < text.length; i += maxLen) {
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: text.slice(i, i + maxLen) });
    }
  }
}

function saveConversation(chatId: string, userName: string, userText: string, agentText: string) {
  // Ищем существующий разговор
  let conv = allConversations.find(c => c.phone === chatId && c.status === 'active');
  if (!conv) {
    conv = {
      id: uuid(), org_id: ORG_ID, lead_id: leads[0]!.id, agent_id: AGENT_ID,
      channel: 'telegram', status: 'active', message_count: 0, duration_seconds: null,
      sentiment: null, summary: null,
      started_at: new Date().toISOString(), ended_at: null, last_message_at: null,
      phone: chatId, lead_name: userName, lead_stage: 'new', agent_name: 'Айгуль',
      created_at: new Date().toISOString(),
    };
    allConversations.unshift(conv);

    // Создаём лид если нет
    if (!leads.find(l => l.phone === chatId)) {
      leads.push({
        id: uuid(), org_id: ORG_ID, phone: chatId, name: userName,
        stage: 'new', score: 10, source: 'telegram', created_at: new Date().toISOString(),
      });
    }

    allMessages[conv.id] = [];
  }

  const now = new Date().toISOString();
  allMessages[conv.id]!.push(
    { id: uuid(), role: 'user', content: userText, tool_name: null, tool_input: null, tool_result: null, tokens_input: null, tokens_output: null, latency_ms: null, created_at: now },
    { id: uuid(), role: 'assistant', content: agentText, tool_name: null, tool_input: null, tool_result: null, tokens_input: null, tokens_output: null, latency_ms: null, created_at: now },
  );
  conv.message_count += 2;
  conv.last_message_at = now;
}

// ============================================================
// Express API (для админки)
// ============================================================
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'No token' }); return; }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { userId: string; orgId: string; role: string };
    (req as express.Request & { user: typeof payload }).user = payload;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'standalone', telegram: !!TELEGRAM_BOT_TOKEN, ai: !!ANTHROPIC_API_KEY }));

// Auth
app.post('/api/v1/auth/register', async (req, res) => {
  const { orgName, email, password, fullName } = req.body;
  if (users.find(u => u.email === email)) { res.status(409).json({ error: 'Email already registered' }); return; }
  const newUser = { id: uuid(), org_id: ORG_ID, email, password_hash: bcrypt.hashSync(password, 12), full_name: fullName ?? orgName, role: 'admin' };
  users.push(newUser);
  const token = jwt.sign({ userId: newUser.id, orgId: ORG_ID, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, orgId: ORG_ID, userId: newUser.id });
});

// Web-чат с Айгуль (без Telegram, прямо в админке)
app.post('/api/v1/chat', authMiddleware, async (req, res) => {
  const { message, sessionId } = req.body as { message: string; sessionId: string };
  if (!message?.trim() || !sessionId) { res.status(400).json({ error: 'message and sessionId required' }); return; }

  try {
    const reply = await getAgentResponse(`web-${sessionId}`, message);
    saveConversation(`web-${sessionId}`, 'Веб-клиент', message, reply);
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) { res.status(401).json({ error: 'Invalid email or password' }); return; }
  const token = jwt.sign({ userId: user.id, orgId: user.org_id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, orgId: user.org_id, userId: user.id });
});

// Dashboard
app.get('/api/v1/dashboard/:orgId', authMiddleware, (_req, res) => {
  const allLeads = leads;
  const funnel = ['new', 'contacted', 'interested', 'objection', 'negotiation', 'meeting_booked', 'closed_won', 'closed_lost', 'nurturing']
    .map(stage => ({ stage, count: String(allLeads.filter(l => l.stage === stage).length) }))
    .filter(f => parseInt(f.count) > 0);

  const trend = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - 13 + i);
    const dateStr = d.toISOString().split('T')[0]!;
    const count = allConversations.filter(c => c.created_at.startsWith(dateStr)).length;
    return { date: dateStr, conversations: String(count || Math.floor(Math.random() * 3) + 1) };
  });

  res.json({
    metrics: {
      totalConversations: allConversations.length,
      totalLeads: allLeads.length,
      conversionRate: allLeads.length > 0 ? Math.round(allLeads.filter(l => l.stage === 'closed_won').length / allLeads.length * 100) : 0,
      avgResponseTimeMs: 1200,
    },
    funnel, trend,
    subscription: { plan: 'starter', messages_used: allConversations.reduce((s, c) => s + c.message_count, 0), messages_limit: 5000, minutes_used: 0, minutes_limit: 500 },
  });
});

// Conversations — объединяем seed + реальные из Telegram
app.get('/api/v1/conversations/:orgId', authMiddleware, (req, res) => {
  let filtered = [...allConversations];
  const ch = req.query['channel'] as string | undefined;
  const st = req.query['status'] as string | undefined;
  if (ch) filtered = filtered.filter(c => c.channel === ch);
  if (st) filtered = filtered.filter(c => c.status === st);
  res.json({ conversations: filtered, total: filtered.length, limit: 50, offset: 0 });
});

app.get('/api/v1/conversations/:convId/messages', authMiddleware, (req, res) => {
  const convId = req.params['convId']!;
  const msgs = allMessages[convId] ?? [];
  res.json({ messages: msgs, recording: null });
});

// Knowledge
app.get('/api/v1/knowledge', authMiddleware, (_req, res) => {
  res.json({ files: [{ source_file: 'flowers_catalog.md', category: 'bouquets', chunk_count: knowledgeBase.length, total_tokens: 1500, uploaded_at: '2026-04-10T08:00:00Z' }] });
});
app.post('/api/v1/knowledge/upload', authMiddleware, (_req, res) => {
  res.json({ filename: 'uploaded.pdf', chunks: 5, category: 'general', message: 'Загружено 5 фрагментов' });
});
app.get('/api/v1/knowledge/search', authMiddleware, (req, res) => {
  const q = (req.query['q'] as string ?? '');
  const results = searchKnowledge(q).map(c => ({ content: c, category: 'bouquets', source_file: 'flowers_catalog.md', similarity: 0.9 }));
  res.json({ results, query: q });
});
app.delete('/api/v1/knowledge/:filename', authMiddleware, (_req, res) => res.json({ message: 'Удалено' }));

// Agents
app.get('/api/v1/agents', authMiddleware, (_req, res) => res.json({ agents }));
app.get('/api/v1/agents/:id', authMiddleware, (req, res) => {
  const a = agents.find(x => x.id === req.params['id']);
  if (a) {
    res.json(a);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});
app.post('/api/v1/agents', authMiddleware, (req, res) => {
  const a = { id: uuid(), org_id: ORG_ID, ...req.body, created_at: new Date().toISOString() };
  agents.push(a);
  res.status(201).json({ id: a.id });
});
app.put('/api/v1/agents/:id', authMiddleware, (req, res) => {
  const idx = agents.findIndex(a => a.id === req.params['id']);
  if (idx === -1) { res.status(404).json({ error: 'Not found' }); return; }
  agents[idx] = { ...agents[idx]!, ...req.body };
  res.json({ success: true });
});
app.delete('/api/v1/agents/:id', authMiddleware, (req, res) => {
  const a = agents.find(x => x.id === req.params['id']);
  if (a) a.is_active = false;
  res.json({ success: true });
});

// Recordings
app.get('/api/v1/recordings', authMiddleware, (_req, res) => res.json({ recordings: [], limit: 20, offset: 0 }));
app.get('/api/v1/recordings/:id/audio', authMiddleware, (_req, res) => res.status(404).json({ error: 'No recordings' }));
app.get('/api/v1/recordings/:id/transcript', authMiddleware, (_req, res) => res.status(404).json({ error: 'No recordings' }));

// ============================================================
// WebSocket прокси Gemini Live (для браузеров с блокировкой Google)
// ============================================================
const GOOGLE_API_KEY = process.env['GOOGLE_API_KEY'] ?? '';
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws/gemini-live' });

wss.on('connection', (clientWs, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const model = url.searchParams.get('model') ?? 'gemini-3.1-flash-live-preview';
  console.log(`🔌 [Gemini Live Proxy] Client connected, model=${model}`);

  if (!GOOGLE_API_KEY) {
    clientWs.send(JSON.stringify({ error: 'GOOGLE_API_KEY not set on server' }));
    clientWs.close();
    return;
  }

  // Подключаемся к Gemini Live
  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GOOGLE_API_KEY}`;
  const geminiWs = new WS(geminiUrl);

  // Прокси: client → gemini
  clientWs.on('message', (data) => {
    if (geminiWs.readyState === WS.OPEN) {
      geminiWs.send(data.toString());
    }
  });

  // Прокси: gemini → client
  geminiWs.on('message', (data) => {
    if (clientWs.readyState === WS.OPEN) {
      clientWs.send(data.toString());
    }
  });

  geminiWs.on('open', () => console.log('  ✅ Connected to Gemini Live'));
  geminiWs.on('close', (code, reason) => {
    console.log(`  🔌 Gemini closed: ${code} ${reason}`);
    if (clientWs.readyState === WS.OPEN) clientWs.close(code, reason.toString());
  });
  geminiWs.on('error', (err) => console.error('  ❌ Gemini error:', err.message));

  clientWs.on('close', () => {
    console.log('  🔌 Client disconnected');
    if (geminiWs.readyState === WS.OPEN) geminiWs.close();
  });
});

// ============================================================
// Запуск
// ============================================================
httpServer.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 SalesAgent AI — Standalone Server`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📍 Admin UI:  http://localhost:5173`);
  console.log(`📍 API:       http://localhost:${PORT}`);
  console.log(`🔑 Login:     demo@flowers.kz / demo1234`);
  console.log(`🤖 AI Agent:  ${ANTHROPIC_API_KEY ? '✅ Claude Sonnet' : '❌ нет ключа'}`);
  console.log(`📱 Telegram:  ${TELEGRAM_BOT_TOKEN ? '✅ polling...' : '❌ нет токена'}`);
  console.log(`${'='.repeat(50)}\n`);

  // Запускаем Telegram polling
  startTelegramPolling();
});
