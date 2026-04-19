#!/usr/bin/env node
/**
 * scripts/buy-number.mjs
 *
 * Покупает номер телефона в Voximplant и привязывает к приложению "salesagent".
 *
 * Запуск: node scripts/buy-number.mjs [country_code] [category]
 *   node scripts/buy-number.mjs KZ MOBILE    ← KZ мобильный ($6.32/мес)
 *   node scripts/buy-number.mjs US GEOGRAPHIC ← US номер ($1.5/мес + $1.5 setup)
 *   node scripts/buy-number.mjs              ← по умолчанию: KZ MOBILE
 *
 * Требует: VOXIMPLANT_ACCOUNT_ID и VOXIMPLANT_API_KEY в .env
 * Баланс: минимум $10 на счёте (пополнить: https://manage.voximplant.com → Billing)
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

const ACCOUNT_ID = process.env.VOXIMPLANT_ACCOUNT_ID;
const API_KEY    = process.env.VOXIMPLANT_API_KEY;
const APP_NAME   = process.env.VOXIMPLANT_APP_NAME || 'salesagent';

const COUNTRY  = (process.argv[2] || 'KZ').toUpperCase();
const CATEGORY = (process.argv[3] || 'MOBILE').toUpperCase();

if (!ACCOUNT_ID || !API_KEY) {
  console.error('❌  Нет VOXIMPLANT_ACCOUNT_ID или VOXIMPLANT_API_KEY в .env');
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

console.log(`\n📞 Покупка номера ${COUNTRY} ${CATEGORY}...\n`);

// 1. Проверяем баланс
const account = await voxCall('GetAccountInfo');
if (account.error) { console.error('❌', account.error.msg); process.exit(1); }
const balance = account.result.balance;
console.log(`💰 Баланс: $${balance} ${account.result.currency}`);

if (balance < 3) {
  console.error('\n❌  Недостаточно средств (нужно минимум $3-7).');
  console.error('   Пополни баланс: https://manage.voximplant.com → Billing → Add funds');
  process.exit(1);
}

// 2. Проверяем категории
const cats = await voxCall('GetPhoneNumberCategories', { country_code: COUNTRY });
const cat = cats.result?.[0]?.phone_categories?.find(c => c.phone_category_name === CATEGORY);
if (!cat) {
  console.error(`❌  Категория ${CATEGORY} не найдена для ${COUNTRY}`);
  console.log('Доступные:', cats.result?.[0]?.phone_categories?.map(c => c.phone_category_name));
  process.exit(1);
}
console.log(`📋 ${COUNTRY} ${CATEGORY}: $${cat.phone_price}/мес + $${cat.phone_installation_price} установка`);

// 3. Проверяем регионы
const regions = await voxCall('GetPhoneNumberRegions', { country_code: COUNTRY, phone_category_name: CATEGORY });

let phone_region_id = null;
if (regions.result?.length > 0) {
  phone_region_id = regions.result[0].phone_region_id;
  console.log(`📍 Регион: ${regions.result[0].phone_region_name} (id=${phone_region_id})`);
}

// 4. Получаем список номеров
const numberParams = { country_code: COUNTRY, phone_category_name: CATEGORY, count: 5 };
if (phone_region_id) numberParams.phone_region_id = phone_region_id;

const available = await voxCall('GetNewPhoneNumbers', numberParams);
if (available.error) {
  console.error('❌  Ошибка получения номеров:', available.error.msg);
  process.exit(1);
}
if (!available.result?.length) {
  console.error('❌  Нет доступных номеров');
  process.exit(1);
}

const chosen = available.result[0];
console.log(`\n✅ Выбран номер: +${chosen.phone_number}`);

// 5. Покупаем
const buyParams = { phone_number: chosen.phone_number };
if (phone_region_id) buyParams.phone_region_id = phone_region_id;

const bought = await voxCall('AttachPhoneNumber', buyParams);
if (bought.error) {
  console.error('❌  Ошибка покупки:', bought.error.msg);
  console.error('   Полный ответ:', JSON.stringify(bought));
  process.exit(1);
}
console.log(`✅ Номер +${chosen.phone_number} куплен!`);

// 6. Привязываем к приложению
const apps = await voxCall('GetApplications', { application_name: APP_NAME });
const appId = apps.result?.[0]?.application_id;
if (!appId) {
  console.error(`⚠️  Приложение "${APP_NAME}" не найдено — запусти сначала voximplant-setup-http.mjs`);
  process.exit(1);
}

// Получаем ID только что купленного номера
const myNumbers = await voxCall('GetPhoneNumbers', {});
const myNum = myNumbers.result?.find(n => n.phone_number === chosen.phone_number);
if (myNum) {
  const bind = await voxCall('BindPhoneNumberToApplication', {
    phone_id:       myNum.phone_id,
    application_id: appId,
  });
  if (bind.error) {
    console.error('⚠️  Ошибка привязки:', bind.error.msg);
  } else {
    console.log(`✅ Номер привязан к приложению "${APP_NAME}" (id=${appId})`);
  }
}

console.log('\n🎉 Готово! Теперь можно позвонить:');
console.log(`   +${chosen.phone_number}`);
console.log('\n   Архитектура: Клиент → Voximplant ASR → POST /api/voice → Gemma AI → TTS\n');
