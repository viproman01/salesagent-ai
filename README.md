# SalesAgent AI

**AI-платформа для автоматизации продаж**: голосовые звонки, WhatsApp/Telegram, автоматическое управление CRM для SMB-бизнеса в Казахстане и России.

## Технологический стек

| Компонент   | Технология |
|-------------|-----------|
| Backend     | Node.js 20 + Express + TypeScript |
| Database    | PostgreSQL 16 + pgvector |
| Cache/Queue | Redis + BullMQ |
| AI Voice    | Deepgram Flux → Claude fast/medium/deep → Fish Audio |
| Voice fallback | AssemblyAI Streaming (cold STT) + Gemini Live (runtime rollback) |
| AI Text     | Anthropic Claude |
| Classifier  | Claude Haiku |
| Телефония   | Voximplant |
| WhatsApp    | Wazzup24 API |
| Telegram    | Telegram Bot API |
| CRM         | AmoCRM REST API v4 |
| Storage     | S3 / MinIO |
| Frontend    | React 18 + Tailwind CSS + Vite |
| Deploy      | Docker Compose |

---

## Быстрый старт / Quick Start

### 1. Клонирование и настройка

```bash
git clone <repo>
cd salesagent-ai
cp .env.example .env
# Отредактируйте .env и заполните ключи API
```

### 2. Запуск с Docker Compose

```bash
docker-compose up -d
```

Сервисы:
- **Backend API**: http://localhost:3000
- **Admin UI**:    http://localhost:5173
- **MinIO Console**: http://localhost:9001 (minioadmin/minioadmin)
- **PostgreSQL**: localhost:5432

### 3. Применение миграций и сидирование

```bash
# Установка зависимостей
npm install

# Миграции (выполняются автоматически через docker-entrypoint)
npm run migrate:dev

# Тестовые данные (org + agent "Айгуль" + база знаний + лиды)
npm run seed
```

**Тестовые данные:**
- Email: `demo@flowers.kz`
- Пароль: `demo1234`

---

## Разработка / Development

```bash
# Backend
npm install
npm run dev

# Frontend (в другом терминале)
cd admin
npm install
npm run dev
```

---

## Переменные окружения

| Переменная | Описание |
|-----------|---------|
| `ANTHROPIC_API_KEY` | Ключ Anthropic Claude API |
| `GOOGLE_API_KEY` | Ключ Google AI (Gemini + Embeddings) |
| `VOICE_RUNTIME` | `pipeline` для нового контура, `gemini` для rollback |
| `VOICE_DEFAULT_ORG_ID` | Единственный разрешённый tenant для voice WebSocket |
| `VOICE_WS_AUTH_TOKEN` | Общий секрет Voximplant ↔ backend, минимум 32 символа |
| `DEEPGRAM_API_KEY` | Основной streaming STT (Flux multilingual) |
| `ASSEMBLYAI_API_KEY` | Опциональный cold fallback STT |
| `FISH_API_KEY` | Ключ Fish Audio streaming TTS |
| `FISH_TTS_REFERENCE_ID` | ID разрешённого клона/голоса Fish Audio |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `WAZZUP24_API_KEY` | API-ключ Wazzup24 для WhatsApp |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram Bot |
| `VOXIMPLANT_ACCOUNT_ID` | ID аккаунта Voximplant |
| `AMOCRM_CLIENT_ID` | OAuth Client ID для AmoCRM |
| `JWT_SECRET` | Секрет для подписи JWT (мин. 32 символа) |
| `S3_ENDPOINT` | Endpoint S3/MinIO |

Полный список — в `.env.example`.

### Production voice pipeline

Контур реального времени реализован полностью на уровне кода:

- Voximplant передаёт и получает G.711 μ-law 8 kHz через защищённый media
  WebSocket.
- Deepgram Flux распознаёт речь и определяет границы реплик; при ошибке
  подключения до первого аудио доступен cold fallback на AssemblyAI.
- Fast и medium Claude запускаются параллельно. Deep запускается только при
  высокой сложности или явной эскалации.
- Семантический ledger не разрешает поздней модели противоречить уже
  произнесённому ответу.
- Fish Audio синтезирует только подтверждённые сегменты. Barge-in синхронно
  отменяет LLM/TTS текущего поколения и очищает телефонный playback.
- Приветствие прямо сообщает, что отвечает виртуальный помощник.

Одна команда запускает lint, typecheck, весь voice test-suite, production build
и проверку VoxEngine-скриптов:

```bash
npm run verify:voice
```

После заполнения `FISH_API_KEY` и `FISH_TTS_REFERENCE_ID` выполните реальный
smoke-test голоса:

```bash
npm run smoke:fish-tts
```

Тест сохраняет запись в `/tmp/fish-tts-smoke.wav`. Затем настройте Voximplant:

```bash
npm run setup:voximplant
```

Полная процедура запуска, приёмки, наблюдаемости и rollback описана в
[`docs/voice-pipeline-runbook.md`](docs/voice-pipeline-runbook.md). Технический
план и статус реализации — в
[`docs/План_внедрения_голосового_AI_агента.docx`](docs/План_внедрения_голосового_AI_агента.docx).

Текущая реализация использует hosted API. H100 не требуется для запуска; слой
`ModelRunner` и provider-контракты позволяют позже подключить self-hosted модели
без изменения телефонного state machine.

---

## API Endpoints

### REST API

| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/api/v1/auth/register` | Регистрация организации |
| POST | `/api/v1/auth/login` | Вход |
| GET  | `/api/v1/dashboard/:orgId` | Метрики дашборда |
| GET  | `/api/v1/conversations/:orgId` | Список разговоров |
| GET  | `/api/v1/conversations/:id/messages` | Сообщения разговора |
| POST | `/api/v1/knowledge/upload` | Загрузить документ в базу знаний |
| GET  | `/api/v1/knowledge/search?q=` | Поиск по базе знаний |
| GET/POST/PUT | `/api/v1/agents` | CRUD агентов |
| GET  | `/api/v1/recordings/:id/audio` | Presigned URL записи |
| GET  | `/api/v1/recordings/:id/transcript` | Транскрипт записи |

### Webhooks

| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/api/webhooks/whatsapp` | Входящие WhatsApp (Wazzup24) |
| POST | `/api/webhooks/telegram` | Обновления Telegram Bot |
| POST | `/api/webhooks/voximplant` | События звонков Voximplant |

### WebSocket

| Путь | Описание |
|------|---------|
| `WS /ws/voice?callId=&phone=&orgId=&protocol=vox-media-v1` | Авторизованный full-duplex media stream; заголовок `X-Voice-Token` обязателен |

---

## Архитектура

```
Входящее сообщение (WhatsApp/Telegram/Voice)
         │
         ▼
  session-manager.ts — найти/создать лид и разговор
         │
         ▼
  claude-client.ts — Tool Use Loop
    ├── search_knowledge() → pgvector RAG
    ├── update_lead()      → AmoCRM sync
    ├── book_meeting()     → schedule meeting
    └── send_whatsapp()    → follow-up
         │
         ▼
  Ответ отправляется обратно в канал
         │
         ▼ (async)
  classifier.ts (Claude Haiku) → обновить этап лида
```

Голосовой путь:

```text
Voximplant μ-law 8 kHz
        │
        ▼
Deepgram Flux ── cold-open fallback ──► AssemblyAI
        │
        ▼
Turn Manager / generation cancellation / barge-in
        │
        ├──► Fast Claude ───────┐
        ├──► Medium Claude ─────┼──► semantic commit ledger
        └──► Deep Claude (если нужен) ┘
                                      │
                                      ▼
                          Fish Audio streaming TTS
                                      │
                                      ▼
                         Voximplant playback + ACK
```

---

## Структура проекта

```
salesagent-ai/
├── src/
│   ├── index.ts              — Express сервер
│   ├── config.ts             — Конфиг с Zod-валидацией
│   ├── db.ts                 — PostgreSQL пул
│   ├── ai/
│   │   ├── claude-client.ts  — Claude с tool use loop
│   │   ├── gemini-live.ts    — Gemini Live WebSocket мост
│   │   └── tools.ts          — 4 инструмента
│   ├── rag/
│   │   ├── embeddings.ts     — Google text-embedding-004
│   │   ├── chunker.ts        — 500 токенов с overlap
│   │   └── search.ts         — pgvector поиск
│   ├── channels/
│   │   ├── whatsapp.ts       — Wazzup24
│   │   ├── telegram.ts       — Telegram Bot
│   │   └── voice.ts          — защищённый Voximplant media channel
│   ├── voice/
│   │   ├── configured-runtime.ts — composition root и runtime flag
│   │   ├── realtime-runtime.ts   — full-duplex pipeline
│   │   ├── turn-manager.ts       — endpointing/barge-in/cancellation
│   │   ├── orchestrator.ts       — fast/medium/deep orchestration
│   │   ├── models/               — Claude adapters
│   │   ├── providers/            — Deepgram, AssemblyAI и Fish
│   │   └── telephony/            — auth и Voximplant media protocol
│   ├── crm/
│   │   ├── amocrm.ts         — AmoCRM REST клиент
│   │   └── adapter.ts        — Унифицированный адаптер
│   ├── orchestrator/
│   │   ├── session-manager.ts — Жизненный цикл разговора
│   │   ├── classifier.ts      — Пост-диалоговая классификация
│   │   └── follow-up.ts       — Автоматические follow-up
│   ├── api/                  — REST эндпоинты
│   ├── analytics/            — Агрегация метрик
│   └── utils/                — Логгер, аудио конвертер
├── migrations/               — SQL миграции
├── admin/                    — React SPA
│   └── src/
│       ├── pages/            — Dashboard, Conversations, ...
│       └── components/       — Sidebar, MetricCard, ...
└── scripts/                  — Миграции, сидирование
```

---

## Деплой на Hetzner VPS

```bash
# 1. Клонировать репозиторий на сервер
git clone <repo> /opt/salesagent
cd /opt/salesagent

# 2. Заполнить .env
cp .env.example .env
nano .env

# 3. Запустить
docker-compose up -d --build

# 4. Применить миграции
docker-compose exec app npm run migrate:dev

# 5. Сидировать демо-данные
docker-compose exec app npm run seed

# 6. Зарегистрировать webhooks (после настройки домена)
curl -X POST https://api.wazzup24.com/v3/webhooks \
  -H "Authorization: Bearer $WAZZUP24_API_KEY" \
  -d '{"webhooksUri":"https://your-domain.com/api/webhooks/whatsapp"}'
```

---

## License

MIT
