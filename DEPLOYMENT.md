# Развёртывание SalesAgent AI

Цель этого руководства — запустить один production-процесс, открыть панель, создать агента и безопасно подключить внешние каналы.

## 1. Требования

- Node.js 20 или новее;
- MySQL 8 или совместимая MariaDB;
- публичный порт;
- OpenRouter API key и/или Cerebras API keys для ответов агента;
- Cartesia API key для минимальной задержки и/или Fish Audio API key для озвучивания;
- HTTPS для настоящих телефонных звонков и webhook-провайдеров;
- Redis и S3 — по необходимости.

## 2. Сборка

```bash
npm install
npm --prefix admin install
npm run typecheck
npm test
npm run build
npm --prefix admin run build
```

Production entrypoint:

```text
app.js
```

Он запускает собранный backend. Готовая админ-панель обслуживается тем же Express-процессом.

## 3. Минимальное окружение

```dotenv
NODE_ENV=production
PORT=3000
APP_BUILD_ID=release-2026-07-28
API_BASE_URL=https://sales.example.com
PUBLIC_BASE_URL=https://sales.example.com
FRONTEND_URL=https://sales.example.com
AUTO_MIGRATE=true

JWT_SECRET=случайная-строка-минимум-32-символа
MYSQL_URL=mysql://user:url_encoded_password@host:3306/database
REDIS_URL=memory

OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_DEFAULT_MODEL=openrouter/auto
OPENROUTER_STT_MODEL=deepgram/nova-3
OPENROUTER_STT_FALLBACK_MODEL=openai/whisper-large-v3-turbo
OPENROUTER_STT_LANGUAGE=ru
CEREBRAS_API_KEYS=csk-key-1,csk-key-2
CEREBRAS_DEFAULT_MODEL=gemma-4-31b
CEREBRAS_FALLBACK_OPENROUTER_MODEL=openrouter/auto

FISH_AUDIO_API_KEY=...
FISH_AUDIO_DEFAULT_VOICE_ID=
VOICE_WEBHOOK_SECRET=другой-случайный-секрет-минимум-24-символа
ALLOW_INSECURE_VOICE_WEBHOOK=false
```

`FISH_AUDIO_API_KEY` — секрет доступа. `FISH_AUDIO_DEFAULT_VOICE_ID` — идентификатор голоса. Это разные значения.

## 4. Миграции

```bash
npm run migrate:dev
```

Команда применяет только ещё не выполненные SQL-миграции и записывает их имена в служебную таблицу. Повторный запуск безопасен. При `AUTO_MIGRATE=true` тот же механизм выполняется до старта HTTP-сервера.

## 5. Serverix / Pterodactyl без SSH

Загрузите проект по SFTP, включая:

- `app.js`;
- `package.json` и lockfile;
- backend bundle;
- admin bundle;
- миграции;
- `.env`.

В Startup укажите:

```text
Main file: app.js
```

После изменения backend bundle, зависимостей или `.env` нужен Restart. После изменения только статического admin bundle процесс обычно продолжит работать, но Restart всё равно рекомендуется для однозначного release-состояния.

Права `.env`:

```text
600
```

Не используйте путь к вложенному `server.js`: ограничение Pterodactyl на длину Main file и текущая структура проекта рассчитаны на корневой `app.js`.

## 6. HTTPS

`sslip.io` сопоставляет IP с доменным именем, но не выдаёт сертификат и не создаёт reverse proxy. Let’s Encrypt должен быть настроен владельцем ingress/proxy или панелью хостинга.

Если у контейнера нет доступа к входящим портам `80/443`, можно включить временный Cloudflare Quick Tunnel:

```dotenv
CLOUDFLARE_TUNNEL_MODE=quick
```

После запуска доверенный адрес записывается в `https-url.txt` и возвращается маршрутом `GET /https-url`. Он работает без SSH, собственного домена и открытых входящих портов, но меняется после каждого Restart. Для постоянного production-адреса используйте named Cloudflare Tunnel со своим доменом либо reverse proxy хостинга.

Для постоянного Cloudflare hostname:

```dotenv
CLOUDFLARE_TUNNEL_MODE=named
CLOUDFLARE_TUNNEL_TOKEN=секретный-токен-из-Cloudflare-Zero-Trust
PUBLIC_BASE_URL=https://voice.example.com
FRONTEND_URL=https://voice.example.com
WEBHOOK_BASE_URL=https://voice.example.com
```

В Cloudflare настройте Public Hostname на локальный сервис `http://127.0.0.1:PORT`. Токен хранится только в `.env`.

Без HTTPS:

- панель может открываться по HTTP;
- логины и JWT передаются без шифрования;
- браузер может запретить микрофон;
- production endpoint `/api/voice` возвращает `426`;
- внешний Voximplant сценарий не считается готовым.

Не включайте `ALLOW_INSECURE_VOICE_WEBHOOK=true` для постоянной production-работы.

## 7. Распознавание речи через OpenRouter

`deepgram/nova-3` вызывается через тот же `OPENROUTER_API_KEY`. Отдельный ключ Deepgram не нужен. Браузер записывает выбранный микрофон до паузы, затем backend отправляет аудиофрагмент в `/api/v1/audio/transcriptions`.

При временной ошибке Nova-3 используется `OPENROUTER_STT_FALLBACK_MODEL`. Это turn-based STT: промежуточной транскрипции во время произнесения нет.

## 8. Cerebras и OpenRouter

В окружении можно одновременно настроить оба провайдера. `CEREBRAS_API_KEYS` принимает ключи через запятую:

```dotenv
CEREBRAS_API_KEYS=csk-key-1,csk-key-2,csk-key-3
```

Новые запросы Cerebras начинают с очередного ключа по кругу. При `401`, `403`, `429`, timeout или временной ошибке backend пробует следующий ключ. Если Cerebras недоступен полностью, запрос переходит на `CEREBRAS_FALLBACK_OPENROUTER_MODEL`. Если недоступен OpenRouter, используется `CEREBRAS_DEFAULT_MODEL`.

В карточке агента провайдер и модель выбираются из каталога. Cerebras хранится с префиксом:

```text
cerebras/gemma-4-31b
```

Для OpenRouter сохраняется обычный model ID:

```text
openrouter/auto
google/gemini-2.5-flash
anthropic/claude-sonnet-4
```

Доступность ID определяется живым каталогом выбранного провайдера. Для RAG и CRM-инструментов выбирайте модель с поддержкой tool calling.

## 9. Cartesia Sonic 3.5 и Fish Audio

Для минимальной задержки используйте Cartesia:

```env
CARTESIA_API_KEY=sk_car_...
CARTESIA_MODEL=sonic-3.5
CARTESIA_DEFAULT_VOICE_ID=779673f3-895f-4935-b6b5-b031dc78b319
```

Sonic 3.5 отдаёт MP3 потоком. В карточке агента можно выбрать любой русский голос Cartesia. Fish Audio сохраняется как второй выбираемый провайдер и автоматический fallback. API-ключи хранятся только в окружении; в `voiceId` записывается UUID/ID голоса.

Если оба провайдера синтеза недоступны, backend вернёт текст и пометит ответ как TTS fallback. Проверяйте квоту, корректность voice ID и логи провайдера.

## 10. Voximplant

Сценарий должен:

1. принять входящий звонок;
2. распознать речь;
3. отправить JSON на `https://ваш-домен/api/voice`;
4. передать `X-Voice-Secret`;
5. воспроизвести `audio_url` или использовать провайдерный TTS fallback;
6. повторять цикл до завершения звонка.

В custom data сценария задайте ID агента и тот же voice secret. Таймаут внешнего сценария должен учитывать задержку LLM и TTS.

## 11. WhatsApp и Telegram

WhatsApp URL:

```text
https://ваш-домен/api/webhooks/whatsapp/ORG_ID
```

Нужны `WAZZUP24_API_KEY`, `WAZZUP24_CHANNEL_ID` и `WAZZUP24_WEBHOOK_SECRET`.

Telegram URL:

```text
https://ваш-домен/api/webhooks/telegram/ORG_ID
```

Нужны `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET`. При вызове Telegram `setWebhook` передайте секрет как `secret_token`.

`ORG_ID` виден внутри раздела «Справка и настройка».

## 12. Redis и записи

`REDIS_URL=memory` подходит для первой проверки: фоновые workers отключены. Для очередей классификации и follow-up используйте постоянный Redis.

Для записей настройте S3-совместимые endpoint, access key, secret key, region и bucket. Без S3 разговоры работают, но экран записей будет пуст.

## 13. Проверка после запуска

```bash
curl -i https://ваш-домен/health
```

Ожидается `200` и JSON `{"status":"ok",...}`.

Затем:

1. откройте форму регистрации;
2. войдите;
3. откройте «Справка и настройка»;
4. убедитесь, что MySQL, хотя бы один AI-провайдер, Cartesia или Fish Audio и HTTPS зелёные;
5. загрузите небольшой документ;
6. создайте агента;
7. проверьте чат;
8. проверьте браузерный звонок;
9. только после этого подключайте внешние webhooks.

## 14. Диагностика

| Симптом | Причина или действие |
|---|---|
| Белый экран | Проверьте admin bundle, CSP и сделайте жёсткое обновление |
| Startup падает на env | Исправьте переменную, указанную в сообщении Zod |
| `401` webhook | Передан неверный секрет |
| `503` webhook | Соответствующий секрет не задан |
| `426` voice | Нужен HTTPS |
| Агент не отвечает | Нет ключей AI-провайдера, неверный model ID или исчерпаны квоты всех ключей |
| Есть текст, нет звука | Ключ выбранного Cartesia/Fish Audio, voice ID или квота; при наличии второго TTS он используется как fallback |
| Нет агента в voice test | Агент неактивен или не включён канал `voice` |
| Нет записей | Не настроено S3 или телефонный сценарий не загружает запись |

Секреты никогда не публикуйте в логах, документации, скриншотах или Git.
