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
import crypto from 'crypto';
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
const WEBHOOK    = process.env.WEBHOOK_BASE_URL || '';

if (!ACCOUNT_ID || !API_KEY) {
  console.error('\n❌  Заполни VOXIMPLANT_ACCOUNT_ID и VOXIMPLANT_API_KEY в .env\n');
  console.log('Как получить:');
  console.log('  1. Зарегистрируйся на https://voximplant.com');
  console.log('  2. Перейди в Settings → API Access');
  console.log('  3. Скопируй Account ID и API Key в .env\n');
  process.exit(1);
}

// ─── Voximplant API helper ────────────────────────────────────────────────────
async function voxCall(method, params = {}) {
  // Подпись: MD5(account_id + api_key)
  const apiSig = crypto.createHash('md5')
    .update(ACCOUNT_ID + API_KEY)
    .digest('hex');

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

// ─── Основной поток ───────────────────────────────────────────────────────────
console.log('\n🔧 Настройка Voximplant...\n');

// 1. Проверяем аккаунт
const account = await voxCall('GetAccountInfo');
if (account.error) {
  console.error('❌  Ошибка API:', account.error.msg);
  process.exit(1);
}
console.log(`✅ Аккаунт: ${account.result.account_name} (${account.result.account_email})`);

// 2. Создаём/находим приложение
let appId;
const apps = await voxCall('GetApplications', { application_name: APP_NAME });
if (apps.result?.length > 0) {
  appId = apps.result[0].application_id;
  console.log(`✅ Приложение "${APP_NAME}" уже существует (id=${appId})`);
} else {
  const newApp = await voxCall('AddApplication', { application_name: APP_NAME });
  if (newApp.error) {
    console.error('❌  Ошибка создания приложения:', newApp.error.msg);
    process.exit(1);
  }
  appId = newApp.result.application_id;
  console.log(`✅ Приложение "${APP_NAME}" создано (id=${appId})`);
}

// 3. Загружаем сценарий
const scenarioPath = resolve(ROOT, 'voximplant/scenario.js');
if (!existsSync(scenarioPath)) {
  console.error('❌  Файл сценария не найден:', scenarioPath);
  process.exit(1);
}

const scenarioCode = readFileSync(scenarioPath, 'utf8');
const SCENARIO_NAME = 'salesagent_main';

// Проверяем существующие сценарии
let scenarioId;
const scenarios = await voxCall('GetScenarios', { scenario_name: SCENARIO_NAME });
if (scenarios.result?.length > 0) {
  scenarioId = scenarios.result[0].scenario_id;
  // Обновляем код
  await voxCall('SetScenarioInfo', {
    scenario_id:   scenarioId,
    scenario_script: scenarioCode,
  });
  console.log(`✅ Сценарий "${SCENARIO_NAME}" обновлён (id=${scenarioId})`);
} else {
  const newScenario = await voxCall('AddScenario', {
    scenario_name:   SCENARIO_NAME,
    scenario_script: scenarioCode,
  });
  if (newScenario.error) {
    console.error('❌  Ошибка загрузки сценария:', newScenario.error.msg);
    process.exit(1);
  }
  scenarioId = newScenario.result.scenario_id;
  console.log(`✅ Сценарий "${SCENARIO_NAME}" загружен (id=${scenarioId})`);
}

// 4. Создаём правило маршрутизации входящих
const RULE_NAME = 'inbound_ai';
const rules = await voxCall('GetRules', {
  application_id: appId,
  rule_name:      RULE_NAME,
});

if (rules.result?.length > 0) {
  console.log(`✅ Правило "${RULE_NAME}" уже существует`);
} else {
  const newRule = await voxCall('AddRule', {
    application_id: appId,
    rule_name:      RULE_NAME,
    rule_pattern:   '.*',           // все входящие звонки
    scenario_id:    scenarioId,
    is_inbound:     1,
    custom_data:    WEBHOOK ? `wss://${new URL(WEBHOOK).host}/ws/voice` : '',
  });
  if (newRule.error) {
    console.error('❌  Ошибка создания правила:', newRule.error.msg);
    process.exit(1);
  }
  console.log(`✅ Правило "${RULE_NAME}" создано (id=${newRule.result.rule_id})`);
}

// 5. Показываем список номеров
const numbers = await voxCall('GetPhoneNumbers', { application_id: appId });
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
  const available = await voxCall('SearchPhoneNumbers', {
    country_code: 'KZ',
    count:        5,
  });
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
