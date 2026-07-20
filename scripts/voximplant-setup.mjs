#!/usr/bin/env node
/**
 * scripts/voximplant-setup.mjs
 *
 * Автоматически настраивает Voximplant через Management API:
 *   1. Создаёт приложение "salesagent"
 *   2. Загружает VoxEngine сценарий
 *   3. Создаёт правило маршрутизации входящих звонков
 *
 * Запуск: node scripts/voximplant-setup.mjs
 * Требует: VOXIMPLANT_ACCOUNT_ID и VOXIMPLANT_API_KEY в .env
 */

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import querystring from 'querystring';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const require   = createRequire(import.meta.url);

// ─── Загружаем .env ───────────────────────────────────────────────────────────
const envPath = resolve(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

const ACCOUNT_ID = process.env.VOXIMPLANT_ACCOUNT_ID;
const API_KEY    = process.env.VOXIMPLANT_API_KEY;
const APP_NAME   = process.env.VOXIMPLANT_APP_NAME || 'salesagent';
const RULE_NAME  = process.env.VOXIMPLANT_RULE_NAME || 'inbound_ai';
const WEBHOOK    = process.env.WEBHOOK_BASE_URL || '';
const VOICE_ORG_ID = process.env.VOICE_DEFAULT_ORG_ID || '';
const VOICE_WS_AUTH_TOKEN = process.env.VOICE_WS_AUTH_TOKEN || '';
let webhookUrl;
try {
  webhookUrl = WEBHOOK ? new URL(WEBHOOK) : undefined;
} catch {
  console.error('\n❌  WEBHOOK_BASE_URL должен быть корректным URL.\n');
  process.exit(1);
}
const VOICE_WS_URL = webhookUrl
  ? `wss://${webhookUrl.host}/ws/voice`
  : 'wss://example.invalid/ws/voice';

if (!ACCOUNT_ID || !API_KEY) {
  console.error('\n❌  Заполни VOXIMPLANT_ACCOUNT_ID и VOXIMPLANT_API_KEY в .env\n');
  console.log('Как получить:');
  console.log('  1. Зарегистрируйся на https://voximplant.com');
  console.log('  2. Перейди в Settings → API Access');
  console.log('  3. Скопируй Account ID и API Key в .env\n');
  process.exit(1);
}
if (!WEBHOOK || !VOICE_ORG_ID || VOICE_WS_AUTH_TOKEN.length < 32) {
  console.error(
    '\n❌  Для безопасного voice WebSocket нужны WEBHOOK_BASE_URL, ' +
    'VOICE_DEFAULT_ORG_ID и VOICE_WS_AUTH_TOKEN (минимум 32 символа).\n'
  );
  process.exit(1);
}
if (webhookUrl?.protocol !== 'https:') {
  console.error('\n❌  WEBHOOK_BASE_URL должен использовать https://\n');
  process.exit(1);
}

// ─── Voximplant API helper ────────────────────────────────────────────────────
async function voxCall(method, params = {}) {
  const body = querystring.stringify({
    account_id:  ACCOUNT_ID,
    api_key:     API_KEY,
    ...params,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.voximplant.com',
      path:     `/platform_api/${method}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Bad JSON: ' + data)); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function requireApiResponse(method, response) {
  if (!response || typeof response !== 'object') {
    throw new Error(`${method}: empty API response`);
  }
  if (response.error) {
    throw new Error(
      `${method}: ${response.error.msg || response.error.message || 'API error'}`
    );
  }
  return response;
}

function requireMutation(method, response) {
  const checked = requireApiResponse(method, response);
  if (checked.result !== 1) {
    throw new Error(`${method}: expected result=1`);
  }
  return checked;
}

function requirePositiveId(method, value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${method}: missing ${field}`);
  }
  return id;
}

// ─── Основной поток ───────────────────────────────────────────────────────────
console.log('\n🔧 Настройка Voximplant...\n');

// 1. Проверяем аккаунт
const account = requireApiResponse(
  'GetAccountInfo',
  await voxCall('GetAccountInfo')
);
console.log(`✅ Аккаунт: ${account.result.account_name} (${account.result.account_email})`);

// 2. Создаём/находим приложение
let appId;
const apps = requireApiResponse(
  'GetApplications',
  await voxCall('GetApplications', { application_name: APP_NAME })
);
const existingApp = apps.result?.find(
  application => application.application_name === APP_NAME
);
if (existingApp) {
  appId = requirePositiveId(
    'GetApplications',
    existingApp.application_id,
    'application_id'
  );
  console.log(`✅ Приложение "${APP_NAME}" уже существует (id=${appId})`);
} else {
  const newApp = requireMutation(
    'AddApplication',
    await voxCall('AddApplication', { application_name: APP_NAME })
  );
  appId = requirePositiveId(
    'AddApplication',
    newApp.application_id,
    'application_id'
  );
  console.log(`✅ Приложение "${APP_NAME}" создано (id=${appId})`);
}

// 3. Загружаем сценарий
const scenarioPath = resolve(ROOT, 'voximplant/scenario.js');
if (!existsSync(scenarioPath)) {
  console.error('❌  Файл сценария не найден:', scenarioPath);
  process.exit(1);
}

const scenarioCode = readFileSync(scenarioPath, 'utf8')
  .replaceAll('__SALESAGENT_WS_URL_JSON__', JSON.stringify(VOICE_WS_URL))
  .replaceAll('__VOICE_ORG_ID_JSON__', JSON.stringify(VOICE_ORG_ID))
  .replaceAll(
    '__VOICE_WS_AUTH_TOKEN_JSON__',
    JSON.stringify(VOICE_WS_AUTH_TOKEN)
  );
const SCENARIO_NAME = 'salesagent_main';

// Проверяем существующие сценарии
let scenarioId;
const scenarios = requireApiResponse(
  'GetScenarios',
  await voxCall('GetScenarios', {
    application_id: appId,
    scenario_name: SCENARIO_NAME,
  })
);
const existingScenario = scenarios.result?.find(
  scenario =>
    scenario.scenario_name === SCENARIO_NAME &&
    Number(scenario.application_id) === appId
);
if (existingScenario) {
  scenarioId = requirePositiveId(
    'GetScenarios',
    existingScenario.scenario_id,
    'scenario_id'
  );
  // Обновляем код
  requireMutation(
    'SetScenarioInfo',
    await voxCall('SetScenarioInfo', {
      scenario_id: scenarioId,
      scenario_script: scenarioCode,
    })
  );
  console.log(`✅ Сценарий "${SCENARIO_NAME}" обновлён (id=${scenarioId})`);
} else {
  const newScenario = requireMutation(
    'AddScenario',
    await voxCall('AddScenario', {
      application_id: appId,
      scenario_name: SCENARIO_NAME,
      scenario_script: scenarioCode,
    })
  );
  scenarioId = requirePositiveId(
    'AddScenario',
    newScenario.scenario_id,
    'scenario_id'
  );
  console.log(`✅ Сценарий "${SCENARIO_NAME}" загружен (id=${scenarioId})`);
}

// 4. Создаём правило маршрутизации входящих
const rules = requireApiResponse(
  'GetRules',
  await voxCall('GetRules', {
    application_id: appId,
    rule_name: RULE_NAME,
    with_scenarios: true,
  })
);

let ruleId;
const existingRule = rules.result?.find(
  rule => rule.rule_name === RULE_NAME
);
if (existingRule) {
  ruleId = requirePositiveId(
    'GetRules',
    existingRule.rule_id,
    'rule_id'
  );
  console.log(`✅ Правило "${RULE_NAME}" уже существует`);
} else {
  const newRule = requireMutation(
    'AddRule',
    await voxCall('AddRule', {
      application_id: appId,
      rule_name: RULE_NAME,
      rule_pattern: '.*',
      scenario_id: scenarioId,
    })
  );
  ruleId = requirePositiveId('AddRule', newRule.rule_id, 'rule_id');
  console.log(`✅ Правило "${RULE_NAME}" создано (id=${ruleId})`);
}

// BindScenario is idempotent and repairs an existing rule that points to an
// older/missing scenario.
requireMutation(
  'BindScenario',
  await voxCall('BindScenario', {
    application_id: appId,
    rule_id: ruleId,
    scenario_id: scenarioId,
    bind: true,
  })
);
console.log(`✅ Сценарий ${scenarioId} привязан к правилу ${ruleId}`);

// 5. Показываем список номеров
const numbers = requireApiResponse(
  'GetPhoneNumbers',
  await voxCall('GetPhoneNumbers', { application_id: appId })
);
if (numbers.result?.length > 0) {
  console.log('\n📞 Привязанные номера:');
  for (const n of numbers.result) {
    console.log(`   +${n.phone_number} (${n.phone_region_name})`);
  }
} else {
  console.log('\n⚠️  Нет привязанных номеров. Нужно купить:');
  console.log('   1. Зайди в https://manage.voximplant.com');
  console.log('   2. Numbers → Buy new number');
  console.log('   3. Выбери Казахстан (+7) или Россию (+7)');
  console.log(`   4. Привяжи к приложению "${APP_NAME}"\n`);

  // Показываем доступные казахстанские номера
  console.log('Поиск доступных KZ номеров...');
  const available = requireApiResponse(
    'SearchPhoneNumbers',
    await voxCall('SearchPhoneNumbers', {
      country_code: 'KZ',
      count: 5,
    })
  );
  if (available.result?.length > 0) {
    console.log('Доступные номера:');
    for (const n of available.result) {
      console.log(`   +${n.phone_number} — ${n.phone_price} $/мес`);
    }
    console.log('\nКупить через API: node scripts/buy-number.mjs +НОМЕР');
  }
}

console.log('\n✅  Voximplant настроен! Теперь:');
console.log('   1. Убедись что туннель запущен: node scripts/start-tunnel.mjs');
console.log('   2. Позвони на номер Voximplant — AI ответит');
console.log('   3. Логи звонка: /tmp/server.log или pm2 logs\n');
