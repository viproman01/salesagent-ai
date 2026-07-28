import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, BookOpenCheck, Bot, Check, ChevronRight, CircleHelp, Database,
  FileText, KeyRound, MessageSquare, Mic, Moon, Phone, Radio, ServerCog, ShieldCheck,
  Sparkles, Sun, Upload, Users, X
} from 'lucide-react';
import api from '../api';

interface ProviderStatus {
  database: boolean;
  openrouter: boolean;
  openrouterStt: boolean;
  sttModel: string;
  sttFallbackModel: string;
  cerebras: boolean;
  cerebrasKeyCount: number;
  fishAudio: boolean;
  cartesia: boolean;
  cartesiaModel: string;
  defaultVoice: boolean;
  voiceWebhookSecret: boolean;
  https: boolean;
  redis: boolean;
  voximplant: boolean;
  whatsapp: boolean;
  telegram: boolean;
  storage: boolean;
}

const setupSteps = [
  { number: '01', title: 'Создайте организацию', text: 'Регистрация создаёт организацию, администратора и пробную подписку.', href: '#registration' },
  { number: '02', title: 'Подключите AI и голос', text: 'Добавьте OpenRouter/Cerebras и выберите Cartesia Sonic 3.5 или Fish Audio.', href: '#providers' },
  { number: '03', title: 'Загрузите знания', text: 'Добавьте товары, цены, доставку и ответы на частые вопросы.', href: '#knowledge' },
  { number: '04', title: 'Создайте агента', text: 'Задайте роль, модель, голос и включите канал voice.', href: '#agent-fields' },
  { number: '05', title: 'Проверьте текст', text: 'Сначала убедитесь в корректных ответах через чат и RAG-поиск.', href: '#chat' },
  { number: '06', title: 'Запустите тест звонка', text: 'Выберите голосового агента, начните звонок и произнесите реплику.', href: '#voice-test' },
] as const;

const environmentRows = [
  ['OPENROUTER_API_KEY', 'Секретный API-ключ OpenRouter. Нужен для всех ответов агента и embeddings.', 'Обязательно'],
  ['OPENROUTER_DEFAULT_MODEL', 'Модель по умолчанию. У конкретного агента её можно заменить произвольным ID.', 'Рекомендуется openrouter/auto'],
  ['OPENROUTER_STT_MODEL', 'Модель распознавания речи через OpenRouter Audio Transcriptions.', 'deepgram/nova-3'],
  ['OPENROUTER_STT_FALLBACK_MODEL', 'Резервная STT-модель при лимите или временной ошибке Nova-3.', 'openai/whisper-large-v3-turbo'],
  ['CEREBRAS_API_KEYS', 'Один или несколько ключей Cerebras через запятую. Запросы распределяются по кругу; при лимите используется следующий ключ.', 'Для быстрых моделей'],
  ['CEREBRAS_DEFAULT_MODEL', 'Модель Cerebras для fallback, когда выбранный OpenRouter временно недоступен.', 'Рекомендуется gemma-4-31b'],
  ['CEREBRAS_FALLBACK_OPENROUTER_MODEL', 'Модель OpenRouter, если исчерпаны все Cerebras-ключи.', 'Рекомендуется openrouter/auto'],
  ['VOICE_FAST_MODEL', 'Основная модель голосового диалога. Для минимальной задержки используется Cerebras Gemma 4 31B.', 'cerebras/gemma-4-31b'],
  ['VOICE_DEEP_MODEL', 'Фоновая модель для сложных расчётов, сравнений и анализа рисков.', 'deepseek/deepseek-v4-pro'],
  ['VOICE_DEEP_MAX_TOKENS / TIMEOUT_MS', 'Бюджет рассуждения и таймаут фонового анализа. Быстрый разговор в это время не блокируется.', '2400 / 60000'],
  ['FISH_AUDIO_API_KEY', 'Секретный ключ Fish Audio для синтеза речи. Это не ID голоса.', 'Обязательно для звука'],
  ['FISH_AUDIO_DEFAULT_VOICE_ID', 'ID/reference ID голоса Fish Audio по умолчанию.', 'Необязательно'],
  ['CARTESIA_API_KEY', 'Секретный серверный ключ Cartesia для потокового TTS. Никогда не вводится в поле Voice ID.', 'Рекомендуется для минимальной задержки'],
  ['CARTESIA_MODEL', 'Модель синтеза Cartesia. Sonic 3.5 поддерживает русский и потоковый MP3.', 'sonic-3.5'],
  ['CARTESIA_DEFAULT_VOICE_ID', 'Русский голос Cartesia по умолчанию. Для Mommy используется Natalya — Soothing Guide.', 'UUID голоса'],
  ['VOICE_WEBHOOK_SECRET', 'Общий длинный секрет приложения и сценария Voximplant.', 'Обязательно для телефонии'],
  ['PUBLIC_BASE_URL', 'Публичный HTTPS-адрес приложения без завершающего слеша.', 'Обязательно для телефонии'],
  ['CLOUDFLARE_TUNNEL_MODE', '`quick` запускает временный URL; `named` использует постоянный Cloudflare Tunnel.', 'Для production: named'],
  ['CLOUDFLARE_TUNNEL_TOKEN', 'Секретный токен постоянного Named Tunnel. Не показывается в панели.', 'Для named tunnel'],
  ['MYSQL_URL', 'Строка подключения MySQL/MariaDB. Хранит пользователей, агентов и диалоги.', 'Обязательно'],
  ['REDIS_URL', 'Redis для очередей классификации и follow-up. Значение memory отключает фоновые workers.', 'Для production'],
  ['WAZZUP24_API_KEY / CHANNEL_ID / WEBHOOK_SECRET', 'Три значения для приёма и отправки WhatsApp через Wazzup24.', 'Только WhatsApp'],
  ['TELEGRAM_BOT_TOKEN / WEBHOOK_SECRET', 'Токен BotFather и секрет проверки входящих Telegram webhook.', 'Только Telegram'],
  ['VOXIMPLANT_ACCOUNT_ID / API_KEY', 'Доступ Voximplant для настоящих телефонных звонков.', 'Только телефония'],
  ['S3_ENDPOINT / ACCESS_KEY / SECRET_KEY', 'S3-совместимое хранилище записей звонков.', 'Для записей'],
] as const;

const agentFields = [
  ['Имя агента', 'Отображаемое имя менеджера: например, «Айгуль». Не влияет на провайдера модели.'],
  ['AI-провайдер и модель', 'Выберите Cerebras или OpenRouter, затем модель из выпадающего каталога. Можно ввести точный ID вручную. Для голосовых продаж рекомендуются Gemma 4 31B или другая модель с tools.'],
  ['TTS-провайдер и голос', 'Cartesia Sonic 3.5 рекомендуется для минимальной задержки; доступны русские женские и мужские голоса. Fish Audio остаётся альтернативой и автоматическим резервом. Voice ID — это UUID/ID голоса, не API-ключ.'],
  ['STT через OpenRouter', 'Модель распознавания выбранного микрофона. По умолчанию deepgram/nova-3; используется существующий OPENROUTER_API_KEY.'],
  ['Пауза конца реплики', 'После такой паузы запись автоматически отправляется на распознавание. Рекомендуется 900–1500 мс.'],
  ['Каналы', 'whatsapp — сообщения Wazzup24; telegram — Telegram Bot; voice — браузерный тест и Voximplant. Для теста звонка обязательно отметьте voice.'],
  ['Температура', '0 даёт стабильные и строгие ответы; 0.6–0.8 подходит продажам; 1 добавляет вариативность, но повышает риск неточностей.'],
  ['Макс. токенов', 'Максимальная длина одного ответа. Для короткого голосового диалога обычно достаточно 256–700, для подробного чата — 700–1500.'],
  ['Системный промпт', 'Роль, тон общения, правила продажи, ограничения и момент вызова инструментов. Фактические цены лучше хранить в базе знаний, а не в промпте.'],
  ['Активность', 'После создания агент активен. «Деактивировать» скрывает его из новых диалогов, но сохраняет историю.'],
] as const;

const sections = [
  {
    title: 'Дашборд',
    icon: Users,
    text: 'Сводка за 30 дней. «Лиды» — уникальные клиенты; «Разговоры» — сессии; «Конверсия» — доля закрытых успешных лидов; «Ср. ответ» — средняя задержка. Воронка показывает этапы CRM, график — активность по дням, полоса плана — расход лимита сообщений.',
  },
  {
    title: 'Чат с агентом',
    icon: MessageSquare,
    text: 'Текстовая песочница для проверки поведения до звонка. Сообщения создают настоящие лиды и разговоры. «Новый разговор» сбрасывает браузерную сессию. Нужен хотя бы один настроенный AI-провайдер: Cerebras или OpenRouter.',
  },
  {
    title: 'Разговоры',
    icon: Radio,
    text: 'Журнал WhatsApp, Telegram и voice. Фильтр «Канал» ограничивает источник, «Статус» — состояние сессии. Клиент — имя/телефон, этап — состояние лида, статус — состояние разговора, «Сообщ.» — число реплик. Нажмите строку, чтобы увидеть сообщения, tool calls и задержки.',
  },
  {
    title: 'Записи',
    icon: Mic,
    text: 'Аудио реальных звонков, транскрипты и маркеры. Пустой экран означает, что запись ещё не загружена в S3 или телефония не подключена. Качество — вычисленная оценка диалога, а не качество аудиофайла.',
  },
  {
    title: 'База знаний',
    icon: FileText,
    text: 'Документы превращаются в фрагменты и embeddings. Категория помогает организовать источник: «Товары», «Цены», «Доставка», FAQ или общее. «Тест поиска» показывает, какие фрагменты получит агент. Удаление файла удаляет все его фрагменты.',
  },
  {
    title: 'Агенты',
    icon: Bot,
    text: 'Создание и настройка продавцов. «Тест агента» отправляет настоящую реплику через выбранную модель и инструменты. Кнопка корзины деактивирует, а не стирает историю.',
  },
  {
    title: 'Тест звонка',
    icon: Phone,
    text: 'После зелёной трубки браузер держит микрофон открытым и сам определяет конец реплики. Deepgram распознаёт речь, Gemma 4 на Cerebras отвечает сразу, а сложные вопросы параллельно проверяет DeepSeek V4 Pro. Cartesia Sonic 3.5 или Fish Audio начинает потоковую озвучку в ближайшую безопасную паузу. При сбое выбранного TTS backend использует второй провайдер. Если разговор уже сменил тему, глубокий результат не перебивает клиента. Во время звонка нужны только mute и красная трубка. Нужен HTTPS.',
  },
] as const;

function StatusBadge({ ready, label }: { ready: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
      ready
        ? 'border-green-200 bg-green-50 text-green-700'
        : 'border-red-200 bg-red-50 text-red-700'
    }`}>
      {ready ? <Check size={15} /> : <X size={15} />}
      <span>{label}</span>
    </div>
  );
}

function FieldTable({ rows }: { rows: readonly (readonly [string, string, string?])[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      {rows.map(([name, description, note], index) => (
        <div key={name} className={`grid gap-2 p-4 md:grid-cols-[220px_1fr_180px] ${index ? 'border-t border-gray-100' : ''}`}>
          <code className="break-words text-xs font-semibold text-brand-700">{name}</code>
          <p className="text-sm leading-6 text-gray-600">{description}</p>
          {note ? <span className="text-xs font-medium text-gray-400 md:text-right">{note}</span> : null}
        </div>
      ))}
    </div>
  );
}

export default function Help() {
  const { data: status, isLoading } = useQuery<ProviderStatus>({
    queryKey: ['provider-status'],
    queryFn: () => api.get('/providers/status').then(response => response.data as ProviderStatus),
    staleTime: 60_000,
  });
  const orgId = localStorage.getItem('orgId') ?? 'ваш-org-id';
  const origin = window.location.origin;

  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <header className="relative overflow-hidden rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
        <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-brand-100/70 blur-3xl dark:bg-brand-900/30" />
        <div className="relative max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-700">
            <BookOpenCheck size={14} /> Центр знаний
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-5xl">От регистрации до первого звонка</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-gray-600">
            Полная инструкция по SalesAgent AI: что настроить на сервере, как подготовить знания,
            создать продавца и проверить разговор голосом.
          </p>
        </div>
      </header>

      <section id="status" className="scroll-mt-6">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Проверка сервера</p>
            <h2 className="mt-1 text-2xl font-bold text-gray-900">Готовность интеграций</h2>
          </div>
          <span className="text-xs text-gray-400">{isLoading ? 'Проверяем…' : 'Без показа секретов'}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatusBadge ready={status?.database ?? false} label="База данных" />
          <StatusBadge ready={status?.openrouter ?? false} label="OpenRouter" />
          <StatusBadge ready={status?.openrouterStt ?? false} label={`STT ${status?.sttModel ?? 'не настроен'}`} />
          <StatusBadge ready={status?.cerebras ?? false} label={`Cerebras (${status?.cerebrasKeyCount ?? 0})`} />
          <StatusBadge ready={status?.fishAudio ?? false} label="Fish Audio" />
          <StatusBadge ready={status?.cartesia ?? false} label={`Cartesia ${status?.cartesiaModel ?? 'Sonic 3.5'}`} />
          <StatusBadge ready={status?.https ?? false} label="HTTPS" />
          <StatusBadge ready={status?.voximplant ?? false} label="Voximplant" />
          <StatusBadge ready={status?.whatsapp ?? false} label="WhatsApp" />
          <StatusBadge ready={status?.telegram ?? false} label="Telegram" />
          <StatusBadge ready={status?.storage ?? false} label="Хранилище записей" />
        </div>
        {!isLoading && status && ((!status.openrouter && !status.cerebras) || !status.https) ? (
          <div className="mt-4 flex gap-3 rounded-2xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-700">
            <AlertTriangle className="mt-0.5 shrink-0" size={18} />
            <p>
              {!status.openrouter && !status.cerebras ? 'Нужен OPENROUTER_API_KEY или хотя бы один ключ в CEREBRAS_API_KEYS. ' : ''}
              {!status.https ? 'Без HTTPS браузерный интерфейс доступен, но публичный Voximplant webhook намеренно заблокирован.' : ''}
            </p>
          </div>
        ) : null}
      </section>

      <section id="start" className="scroll-mt-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Правильный порядок</p>
        <h2 className="mt-1 text-2xl font-bold text-gray-900">Путь запуска</h2>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {setupSteps.map(step => (
            <a key={step.number} href={step.href} className="group flex gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-md">
              <span className="font-mono text-2xl font-bold text-brand-500">{step.number}</span>
              <span className="min-w-0">
                <span className="flex items-center justify-between font-semibold text-gray-900">
                  {step.title}<ChevronRight size={17} className="text-gray-300 transition group-hover:translate-x-1 group-hover:text-brand-500" />
                </span>
                <span className="mt-1 block text-sm leading-6 text-gray-500">{step.text}</span>
              </span>
            </a>
          ))}
        </div>
      </section>

      <section id="registration" className="scroll-mt-6 rounded-3xl border border-gray-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <KeyRound className="text-brand-500" />
          <h2 className="text-2xl font-bold text-gray-900">1. Регистрация и вход</h2>
        </div>
        <ol className="mt-5 space-y-3 text-sm leading-6 text-gray-600">
          <li><strong className="text-gray-900">Название организации</strong> — компания или проект. Оно объединяет всех агентов, лидов и документы.</li>
          <li><strong className="text-gray-900">Ваше имя</strong> — имя первого администратора.</li>
          <li><strong className="text-gray-900">Email</strong> — уникальный логин. Подтверждение почты сейчас не требуется.</li>
          <li><strong className="text-gray-900">Пароль</strong> — минимум 8 символов. Используйте уникальный пароль; текущий HTTP-сайт не подходит для повторно используемых паролей.</li>
        </ol>
      </section>

      <section id="providers" className="scroll-mt-6">
        <div className="mb-4 flex items-center gap-3">
          <ServerCog className="text-brand-500" />
          <div>
            <h2 className="text-2xl font-bold text-gray-900">2. Переменные окружения</h2>
            <p className="text-sm text-gray-500">Их задаёт владелец сервера в .env или панели хостинга. В интерфейсе секреты не показываются.</p>
          </div>
        </div>
        <FieldTable rows={environmentRows} />
        <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-700">
          <strong>Ключи хранятся только в окружении.</strong> Cerebras принимает список через запятую и автоматически
          распределяет запросы. API-ключи Cartesia/Fish Audio и voice ID — разные значения; в карточке агента указывается
          только голос из каталога или его UUID/ID.
        </div>
      </section>

      <section id="knowledge" className="scroll-mt-6 rounded-3xl border border-gray-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <Upload className="text-brand-500" />
          <h2 className="text-2xl font-bold text-gray-900">3. Подготовьте базу знаний</h2>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {[
            ['Что загрузить', 'Каталог, цены, остатки, доставку, гарантии, скрипты возражений и FAQ. Один документ — одна понятная тема.'],
            ['Как проверить', 'Введите реальный вопрос клиента в «Тест поиска». Нужный фрагмент должен быть среди первых результатов.'],
            ['Что не делать', 'Не храните меняющиеся цены только в системном промпте и не загружайте противоречащие друг другу версии документов.'],
          ].map(([title, text]) => (
            <div key={title} className="rounded-2xl bg-gray-50 p-4">
              <h3 className="font-semibold text-gray-900">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-gray-600">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="agent-fields" className="scroll-mt-6">
        <div className="mb-4 flex items-center gap-3">
          <Sparkles className="text-brand-500" />
          <div>
            <h2 className="text-2xl font-bold text-gray-900">4. Все поля агента</h2>
            <p className="text-sm text-gray-500">Для быстрого голосового теста отметьте voice и выберите Cerebras → Gemma 4 31B.</p>
          </div>
        </div>
        <FieldTable rows={agentFields} />
        <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-900 p-5 text-sm leading-6 text-gray-300">
          <p className="font-semibold text-white">Минимальный рабочий промпт</p>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-gray-300">{`Ты — менеджер по продажам компании [название].
Отвечай коротко и по-русски. Перед ответом о товарах,
ценах и доставке используй search_knowledge.
Не выдумывай факты. Если данных нет — уточни у клиента контакты.`}</pre>
        </div>
      </section>

      <section id="chat" className="scroll-mt-6 rounded-3xl border border-gray-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <MessageSquare className="text-brand-500" />
          <h2 className="text-2xl font-bold text-gray-900">5. Проверка текстом</h2>
        </div>
        <p className="mt-4 text-sm leading-6 text-gray-600">
          Спросите цену, доставку и задайте возражение. Проверьте факты, длину ответа и тон.
          Затем откройте «Разговоры»: там должны появиться реплики и вызовы инструментов.
          Исправляйте факты в базе знаний, а стиль — в системном промпте.
        </p>
      </section>

      <section id="voice-test" className="scroll-mt-6 rounded-3xl border border-brand-500 bg-brand-50 p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <Phone className="text-brand-600" />
          <h2 className="text-2xl font-bold text-gray-900">6. Тест голосового звонка</h2>
        </div>
        <ol className="mt-5 grid gap-3 text-sm leading-6 text-gray-700 md:grid-cols-2">
          <li className="rounded-xl bg-white p-4"><strong>1.</strong> Убедитесь, что Cerebras или OpenRouter, а также Cartesia или Fish Audio зелёные в проверке сервера.</li>
          <li className="rounded-xl bg-white p-4"><strong>2.</strong> Создайте активного агента с каналом <code>voice</code>.</li>
          <li className="rounded-xl bg-white p-4"><strong>3.</strong> Откройте «Тест звонка» и выберите агента.</li>
          <li className="rounded-xl bg-white p-4"><strong>4.</strong> Нажмите зелёную трубку и разрешите браузеру доступ к микрофону.</li>
          <li className="rounded-xl bg-white p-4"><strong>5.</strong> Просто говорите: пауза, отправка реплики и возобновление прослушивания работают автоматически.</li>
          <li className="rounded-xl bg-white p-4"><strong>6.</strong> Завершите красной трубкой и проверьте созданный разговор.</li>
        </ol>
        <p className="mt-4 text-xs leading-5 text-gray-500">
          Микрофон может быть заблокирован браузером на обычном HTTP. Ручной ввод остаётся доступен.
          Для настоящего телефонного номера нужны Voximplant, HTTPS и сценарий с VOICE_WEBHOOK_SECRET.
        </p>
      </section>

      <section id="screens" className="scroll-mt-6">
        <div className="mb-4 flex items-center gap-3">
          <CircleHelp className="text-brand-500" />
          <h2 className="text-2xl font-bold text-gray-900">Справочник по разделам</h2>
        </div>
        <div className="space-y-3">
          {sections.map(({ title, icon: Icon, text }) => (
            <details key={title} className="group rounded-2xl border border-gray-200 bg-white">
              <summary className="flex cursor-pointer list-none items-center gap-3 p-5 font-semibold text-gray-900">
                <Icon size={18} className="text-brand-500" />
                {title}
                <ChevronRight size={17} className="ml-auto text-gray-400 transition group-open:rotate-90" />
              </summary>
              <p className="border-t border-gray-100 px-5 py-4 text-sm leading-7 text-gray-600">{text}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="channels" className="scroll-mt-6 rounded-3xl border border-gray-200 bg-white p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <ShieldCheck className="text-brand-500" />
          <h2 className="text-2xl font-bold text-gray-900">Внешние каналы и безопасность</h2>
        </div>
        <div className="mt-5 space-y-4 text-sm leading-6 text-gray-600">
          <p><strong className="text-gray-900">Ваш ID организации:</strong> <code className="rounded bg-gray-100 px-2 py-1">{orgId}</code></p>
          <p><strong className="text-gray-900">WhatsApp webhook:</strong> <code className="break-all">{origin}/api/webhooks/whatsapp/{orgId}</code>. Wazzup24 должен передавать настроенный секрет.</p>
          <p><strong className="text-gray-900">Telegram webhook:</strong> <code className="break-all">{origin}/api/webhooks/telegram/{orgId}</code>. В setWebhook укажите тот же secret_token.</p>
          <p><strong className="text-gray-900">Voximplant:</strong> публичный endpoint <code className="break-all">{origin}/api/voice</code> принимает только HTTPS и заголовок X-Voice-Secret.</p>
        </div>
      </section>

      <section id="troubleshooting" className="scroll-mt-6">
        <div className="mb-4 flex items-center gap-3">
          <Database className="text-brand-500" />
          <h2 className="text-2xl font-bold text-gray-900">Если что-то не работает</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {[
            ['Белый экран', 'Сделайте Ctrl+Shift+R. Если /health не отвечает, проверьте процесс и Main file app.js.'],
            ['Агент не отвечает', 'Проверьте OPENROUTER_API_KEY, точность model ID и наличие средств/квоты у провайдера.'],
            ['Есть текст, но нет голоса', 'Проверьте ключ выбранного TTS: CARTESIA_API_KEY или FISH_AUDIO_API_KEY, voice ID и квоту. При сбое система попробует второй настроенный провайдер.'],
            ['Нет агента в списке звонка', 'Откройте агента, включите channel voice, убедитесь, что он активен, и сохраните.'],
            ['Поиск ничего не находит', 'Загрузите документ, дождитесь embeddings и проверьте запрос в «Тест поиска».'],
            ['Микрофон не включается', 'Разрешите доступ в браузере. На HTTP используйте ручной ввод или сначала подключите HTTPS.'],
            ['Webhook возвращает 401/503', '401 — неверный секрет; 503 — соответствующий WEBHOOK_SECRET не задан на сервере.'],
            ['Публичный voice возвращает 426', 'Это защита: подключите TLS/HTTPS. Не включайте insecure webhook в production.'],
          ].map(([title, text]) => (
            <div key={title} className="rounded-2xl border border-gray-200 bg-white p-5">
              <h3 className="font-semibold text-gray-900">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-gray-600">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="flex flex-col gap-3 rounded-2xl bg-gray-900 p-5 text-sm text-gray-300 sm:flex-row sm:items-center sm:justify-between">
        <span>Тема сохраняется только в этом браузере.</span>
        <span className="flex items-center gap-2"><Sun size={15} /> Светлая <ChevronRight size={13} /> <Moon size={15} /> Тёмная</span>
      </footer>
    </div>
  );
}
