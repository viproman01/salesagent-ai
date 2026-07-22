# SalesAgent AI

**AI-платформа для автоматизации продаж**: голосовые звонки, WhatsApp/Telegram, автоматическое управление CRM для SMB-бизнеса в Казахстане и России.

## Технологический стек

| Компонент   | Технология |
|-------------|-----------|
| Backend     | Node.js 20 + Express + TypeScript |
| Database    | PostgreSQL 16 + pgvector |
| Cache/Queue | Redis + BullMQ |
| AI Voice    | Deepgram Flux → Cerebras/Claude fast + Claude medium/deep → Fish Audio |
| Voice fallback | AssemblyAI Streaming (cold STT) + Gemini Live (runtime rollback) |
| AI Text     | Cerebras Gemma (primary) + Gemini Flash Lite (fallback) |
| Classifier  | Claude Haiku |
| Телефония   | Voximplant |
| WhatsApp    | Direct WhatsApp Web session (Baileys, QR pairing) |
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

Требуется Docker Compose v2.17 или новее (команда `docker compose`).

```bash
docker compose up --build -d
docker compose ps
```

Перед запуском вне локальной машины обязательно замените
`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `S3_ACCESS_KEY` и `S3_SECRET_KEY` в
`.env`. Порты PostgreSQL, Redis и MinIO в Compose публикуются
только на `127.0.0.1`.

Compose ожидает готовности PostgreSQL с доступным pgvector и MinIO, затем:

- применяет только активные миграции `NNN_*.sql` (архивные `_old_*.sql`
  игнорируются);
- создаёт buckets `recordings` и `knowledge`, если их ещё нет;
- запускает backend только после успешных миграций и подготовки buckets.

Миграции повторно проверяются при каждом `docker compose up`, поэтому новые
версии схемы применяются и к уже существующему volume `pgdata`.

Сервисы:
- **Backend API**: http://localhost:3000
- **Admin UI**:    http://localhost:5173
- **MinIO Console**: http://localhost:9001 (minioadmin/minioadmin)
- **PostgreSQL**: localhost:5432

Проверка готовности инфраструктуры и журналы одноразовых init-сервисов:

```bash
docker compose ps
docker compose logs migrate minio-init
```

### 3. Применение миграций и сидирование

```bash
# Установка зависимостей
npm install

# Compose применяет их автоматически; для запуска с host:
npm run migrate:dev

# Тестовые данные (org + agent "Айгуль" + база знаний + лиды)
npm run seed
```

Если задан `VOICE_DEFAULT_ORG_ID`, seed использует его для demo-организации,
чтобы локальный voice WebSocket и активный агент относились к одному tenant.

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
| `CEREBRAS_API_KEYS` | Ключи Cerebras через запятую для опционального fast-слоя |
| `GOOGLE_API_KEY` | Ключ Google AI (Gemini + Embeddings) |
| `TEXT_CHAT_ENABLED` | Включает автоматические ответы веб-чата и WhatsApp |
| `TEXT_CHAT_CEREBRAS_MODEL` | Основная быстрая текстовая модель |
| `TEXT_CHAT_GEMINI_MODEL` | Резервная текстовая модель |
| `VOICE_RUNTIME` | `pipeline` для нового контура, `gemini` для rollback |
| `VOICE_LLM_FAST_PROVIDER` | `cerebras` для Gemma fast-слоя или `anthropic` для rollback |
| `VOICE_DEFAULT_ORG_ID` | Единственный разрешённый tenant для voice WebSocket |
| `VOICE_WS_AUTH_TOKEN` | Общий секрет Voximplant ↔ backend, минимум 32 символа |
| `DEEPGRAM_API_KEY` | Основной streaming STT (Flux multilingual) |
| `ASSEMBLYAI_API_KEY` | Опциональный cold fallback STT |
| `FISH_API_KEY` | Ключ Fish Audio streaming TTS |
| `FISH_TTS_REFERENCE_ID` | ID разрешённого клона/голоса Fish Audio |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `WHATSAPP_AUTH_DIR` | Каталог локальных ключей связанного устройства (не добавлять в git) |
| `WHATSAPP_INBOUND_RATE_MAX_MESSAGES` | Лимит входящих сообщений одного контакта за окно |
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
- Fast Cerebras Gemma (opt-in) и medium Claude запускаются параллельно;
  при ошибке fast-слой откатывается на Claude Haiku. Deep Claude
  запускается только при высокой сложности или явной эскалации.
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
| PATCH | `/api/v1/conversations/:id/reply-mode` | Переключить WhatsApp между AI и оператором |
| POST | `/api/v1/conversations/:id/replies` | Ответ оператора в существующий входящий WhatsApp-диалог |
| POST | `/api/v1/chat` | Автоматический веб-чат с сохранением истории |
| GET | `/api/v1/chat/status` | Фактическая готовность AI и активного webchat-агента |
| GET | `/api/v1/chat/:sessionId/history` | История текущей пользовательской webchat-сессии |
| GET/POST | `/api/v1/whatsapp/status`, `/api/v1/whatsapp/connect` | Статус и QR-подключение WhatsApp |
| POST | `/api/v1/knowledge/upload` | Загрузить документ в базу знаний |
| GET  | `/api/v1/knowledge/search?q=` | Поиск по базе знаний |
| GET/POST/PUT | `/api/v1/agents` | CRUD агентов |
| GET  | `/api/v1/recordings/:id/audio` | Presigned URL записи |
| GET  | `/api/v1/recordings/:id/transcript` | Транскрипт записи |

### Webhooks

| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/api/webhooks/telegram` | Обновления Telegram Bot |
| POST | `/api/webhooks/voximplant` | События звонков Voximplant |

---

## Архитектура

```
Входящее сообщение (WhatsApp/Telegram/Voice)
         │
         ▼
  inbox dedupe → STOP/START/handoff → sender/org rate limit
         │
         ▼
  session-manager.ts → RAG → Cerebras/Gemini provider chain
         │
         ▼
  durable WhatsApp outbox → idempotent reactive reply
         │
         └── режим оператора сохраняет историю, но подавляет AI
```

### Безопасная автоматическая переписка

- Первый автоматический ответ и все служебные ответы прямо сообщают, что
  отвечает AI-ассистент.
- WhatsApp принимает только личные входящие сообщения. Группы, статусы,
  собственные сообщения и произвольная отправка по номеру игнорируются.
- Все исходящие проходят через durable outbox с идемпотентным ID, проверкой
  текущего режима, opt-out, сохранённого входящего JID, активного диалога и
  24-часового окна после последнего сообщения клиента.
- `STOP`, `/stop`, `СТОП`, «не пишите мне больше» отключают любые ответы;
  только входящая команда `СТАРТ` включает их снова. Команда `ОПЕРАТОР`
  сразу передаёт диалог человеку.
- START, передача оператору и служебные подтверждения подчиняются лимитам
  контакта/организации. Сам opt-out по STOP применяется до обращения к Redis,
  поэтому отказ или перегрузка лимитера не может снова включить ответы.
- Opt-out и передача оператору сохраняются на уровне контакта и наследуются
  новым 24-часовым WhatsApp-диалогом; AI не включается сам по таймеру.
- STOP/START/передача оператору имеют приоритет над долгим запросом к модели:
  уже генерируемый устаревший ответ будет отменён перед отправкой.
- История входящих, AI и оператора сохраняется с авторством и статусом
  доставки. Лимиты действуют на контакт, организацию, HTTP API и размер
  ограниченной входной очереди.

Прямое подключение через WhatsApp Web/Baileys удобно для локального пилота,
но не является официальным Business API. Используйте отдельный номер,
работайте только с входящими/согласившимися контактами и не запускайте
холодные или массовые рассылки. Для промышленного объёма следует заменить
транспорт на официальный WhatsApp Cloud API, сохранив текущие policy/outbox
слои.

OAuth callback amoCRM намеренно отвечает `404` и не читает authorization code,
пока не реализованы одноразовый `state` и серверный обмен кода. Не указывайте
этот URL как рабочий redirect URI до завершения отдельной OAuth-интеграции.

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
        ├──► Fast: Cerebras/Claude
        ├──► Medium: Claude
        └──► Deep: Claude (если нужен)
                    │
                    ▼
        semantic commit ledger
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
│   │   ├── whatsapp.ts       — direct WhatsApp bridge + inbound receipts
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

# 3. Запустить (миграции применятся автоматически)
docker compose up --build -d

# 4. При необходимости сидировать демо-данные до production-сборки
npm ci && npm run seed

# 5. Открыть панель → WhatsApp → «Подключить WhatsApp» и отсканировать QR
#    в WhatsApp: Настройки → Связанные устройства.
```

Локальная проверка полного WhatsApp-контура использует только loopback или
Docker-hostnames и откажется работать с production URL:

```bash
npm run build
NODE_ENV=test npm run test:e2e:whatsapp
```

---

## License

MIT
