#!/usr/bin/env node
/**
 * scripts/voximplant-setup-http.mjs
 *
 * Настраивает Voximplant для HTTP-callback режима (работает с Vercel):
 *   1. Создаёт/находит приложение "salesagent"
 *   2. Загружает HTTP-сценарий (voximplant/scenario-http.js)
 *   3. Создаёт правило с custom_data = Vercel URL
 *
 * Запуск: node scripts/voximplant-setup-http.mjs
 * Требует: VOXIMPLANT_ACCOUNT_ID и VOXIMPLANT_API_KEY в .env
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import querystring from 'querystring';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

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

const ACCOUNT_ID  = process.env.VOXIMPLANT_ACCOUNT_ID;
const API_KEY     = process.env.VOXIMPLANT_API_KEY;
const APP_NAME    = process.env.VOXIMPLANT_APP_NAME || 'salesagent';
const VERCEL_URL  = process.env.WEBHOOK_BASE_URL || 'https://salesagent-ai.vercel.app';
const VOICE_URL   = VERCEL_URL + '/api/voice';

if (!ACCOUNT_ID || !API_KEY) {
  console.error('\n❌  Заполни VOXIMPLANT_ACCOUNT_ID и VOXIMPLANT_API_KEY в .env\n');
  console.log('Как получить:');
  console.log('  1. Зарегистрируйся на https://voximplant.com');
  console.log('  2. Settings → API Access → Account ID + API Key\n');
  process.exit(1);
}

// ─── Voximplant API helper ────────────────────────────────────────────────────
async function voxCall(method, params = {}) {
  const body = querystring.stringify({ account_id: ACCOUNT_ID, api_key: API_KEY, ...params });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.voximplant.com',
      path:     `/platform_api/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Bad JSON: ' + data)); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Основной поток ───────────────────────────────────────────────────────────
console.log('\n🔧 Настройка Voximplant (HTTP-callback режим)...');
console.log(`   Vercel URL: ${VERCEL_URL}`);
console.log(`   Voice API:  ${VOICE_URL}\n`);

// 1. Проверяем аккаунт
const account = await voxCall('GetAccountInfo');
if (account.error) {
  console.error('❌  Ошибка API:', account.error.msg);
  process.exit(1);
}
console.log(`✅ Аккаунт: ${account.result.account_name} (${account.result.account_email})`);

// 2. Приложение
let appId;
const apps = await voxCall('GetApplications', { application_name: APP_NAME });
if (apps.result?.length > 0) {
  appId = apps.result[0].application_id;
  console.log(`✅ Приложение "${APP_NAME}" (id=${appId})`);
} else {
  const newApp = await voxCall('AddApplication', { application_name: APP_NAME });
  if (newApp.error) { console.error('❌', newApp.error.msg); process.exit(1); }
  // AddApplication returns result:1, fetch actual ID via GetApplications
  const created = await voxCall('GetApplications', { application_name: APP_NAME });
  appId = created.result?.[0]?.application_id;
  console.log(`✅ Приложение "${APP_NAME}" создано (id=${appId})`);
}

// 3. Загружаем HTTP-сценарий
const scenarioPath = resolve(ROOT, 'voximplant/scenario-http.js');
if (!existsSync(scenarioPath)) { console.error('❌  scenario-http.js не найден'); process.exit(1); }
const scenarioCode = readFileSync(scenarioPath, 'utf8');
const SCENARIO_NAME = 'salesagent_http';

let scenarioId;
const scenarios = await voxCall('GetScenarios', { scenario_name: SCENARIO_NAME });
if (scenarios.result?.length > 0) {
  scenarioId = scenarios.result[0].scenario_id;
  await voxCall('SetScenarioInfo', { scenario_id: scenarioId, scenario_script: scenarioCode });
  console.log(`✅ Сценарий "${SCENARIO_NAME}" обновлён (id=${scenarioId})`);
} else {
  const s = await voxCall('AddScenario', { scenario_name: SCENARIO_NAME, scenario_script: scenarioCode });
  if (s.error) { console.error('❌', s.error.msg); process.exit(1); }
  const createdScenario = await voxCall('GetScenarios', { scenario_name: SCENARIO_NAME });
  scenarioId = createdScenario.result?.[0]?.scenario_id;
  console.log(`✅ Сценарий "${SCENARIO_NAME}" создан (id=${scenarioId})`);
}

// 4. Правило маршрутизации
const RULE_NAME = 'inbound_http_ai';
const rules = await voxCall('GetRules', { application_id: appId, rule_name: RULE_NAME });
if (rules.result?.length > 0) {
  // Обновляем custom_data с актуальным URL
  await voxCall('SetRuleInfo', {
    rule_id:     rules.result[0].rule_id,
    custom_data: VERCEL_URL,
  });
  console.log(`✅ Правило "${RULE_NAME}" обновлено с URL: ${VERCEL_URL}`);
} else {
  const r = await voxCall('AddRule', {
    application_id: appId,
    rule_name:      RULE_NAME,
    rule_pattern:   '.*',
    scenario_id:    scenarioId,
    is_inbound:     1,
    custom_data:    VERCEL_URL,
  });
  if (r.error) { console.error('❌', r.error.msg); process.exit(1); }
  console.log(`✅ Правило "${RULE_NAME}" создано`);
}

// 5. Номера телефонов
const numbers = await voxCall('GetPhoneNumbers', { application_id: appId });
if (numbers.result?.length > 0) {
  console.log('\n📞 Привязанные номера:');
  for (const n of numbers.result) console.log(`   +${n.phone_number} (${n.phone_region_name})`);
} else {
  console.log('\n⚠️  Нет привязанных номеров. Нужно купить:');
  console.log('   1. https://manage.voximplant.com → Numbers → Buy new number');
  console.log(`   2. Привяжи к приложению "${APP_NAME}"\n`);
  const available = await voxCall('SearchPhoneNumbers', { country_code: 'KZ', count: 5 });
  if (available.result?.length > 0) {
    console.log('   Доступные KZ номера:');
    for (const n of available.result) console.log(`   +${n.phone_number} — ${n.phone_price} $/мес`);
    console.log('\n   Купить: node scripts/buy-number.mjs +НОМЕР');
  }
}

console.log('\n✅  Voximplant настроен!');
console.log('   Архитектура: Клиент → Voximplant ASR → POST /api/voice → Gemini → TTS');
console.log(`   API URL: ${VOICE_URL}`);
console.log('\n   Следующий шаг: купи номер телефона в Voximplant и позвони!\n');
