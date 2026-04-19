#!/usr/bin/env node
/**
 * scripts/start-tunnel.mjs
 *
 * Создаёт публичный HTTPS/WSS туннель через ngrok.
 * Нужен для Voximplant — он должен достучаться до нашего WebSocket.
 *
 * Запуск: node scripts/start-tunnel.mjs
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const require   = createRequire(import.meta.url);

// ─── Читаем порт и NGROK_AUTHTOKEN из .env ───────────────────────────────────
const envPath = resolve(ROOT, '.env');
let SERVER_PORT     = 3003;
let NGROK_AUTHTOKEN = '';

if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  const portMatch  = envContent.match(/^PORT=(\d+)/m);
  const tokenMatch = envContent.match(/^NGROK_AUTHTOKEN=(.+)/m);
  if (portMatch)  SERVER_PORT     = parseInt(portMatch[1]);
  if (tokenMatch) NGROK_AUTHTOKEN = tokenMatch[1].trim();
}

console.log(`\n🌐 Запуск ngrok туннеля для порта ${SERVER_PORT}...\n`);

const ngrok = require('@ngrok/ngrok');

// Конфиг ngrok
const config = {};
if (NGROK_AUTHTOKEN) {
  config.authtoken = NGROK_AUTHTOKEN;
}

let listener;
try {
  listener = await ngrok.forward({
    addr: SERVER_PORT,
    ...config,
  });
} catch (err) {
  if (err.message?.includes('auth') || err.message?.includes('token') || err.message?.includes('ERR_NGROK_4018')) {
    console.log('⚠️  ngrok требует токен аутентификации.');
    console.log('   Зарегистрируйся бесплатно: https://dashboard.ngrok.com/signup');
    console.log('   Скопируй токен → добавь в .env: NGROK_AUTHTOKEN=твой_токен');
    console.log('   Затем снова запусти: node scripts/start-tunnel.mjs\n');

    // Пробуем без токена (может не работать на новых версиях)
    console.log('Пробуем без токена...');
    try {
      listener = await ngrok.forward(SERVER_PORT);
    } catch(e2) {
      console.error('❌  ngrok не работает без токена:', e2.message);
      process.exit(1);
    }
  } else {
    throw err;
  }
}

const publicUrl   = listener.url();
const publicWsUrl = publicUrl.replace('https://', 'wss://');

console.log('┌─────────────────────────────────────────────────────────┐');
console.log('│  ✅  Туннель запущен!                                   │');
console.log('│                                                         │');
console.log(`│  HTTP:      ${publicUrl.padEnd(43)} │`);
console.log(`│  WebSocket: ${publicWsUrl.padEnd(43)} │`);
console.log('│                                                         │');
console.log('│  WebSocket endpoint для Voximplant:                     │');
console.log(`│  ${(publicWsUrl + '/ws/voice').padEnd(55)} │`);
console.log('└─────────────────────────────────────────────────────────┘\n');

// ─── Обновляем .env автоматически ────────────────────────────────────────────
if (existsSync(envPath)) {
  let envContent = readFileSync(envPath, 'utf8');
  if (envContent.includes('WEBHOOK_BASE_URL=')) {
    envContent = envContent.replace(/^WEBHOOK_BASE_URL=.*/m, `WEBHOOK_BASE_URL=${publicUrl}`);
  } else {
    envContent += `\nWEBHOOK_BASE_URL=${publicUrl}\n`;
  }
  writeFileSync(envPath, envContent);
  console.log(`📝 WEBHOOK_BASE_URL обновлён: ${publicUrl}`);
}

// ─── Обновляем Voximplant сценарий ───────────────────────────────────────────
const scenarioPath = resolve(ROOT, 'voximplant/scenario.js');
if (existsSync(scenarioPath)) {
  let scenario = readFileSync(scenarioPath, 'utf8');
  scenario = scenario.replace(
    /var SALESAGENT_WS_URL = .+;/,
    `var SALESAGENT_WS_URL = VoxEngine.customData() || '${publicWsUrl}/ws/voice';`
  );
  writeFileSync(scenarioPath, scenario);
  console.log(`📝 Voximplant сценарий обновлён\n`);
}

console.log('⚡ Туннель активен. Нажми Ctrl+C чтобы остановить.\n');
console.log('📋 Следующие шаги для тестирования звонков:');
console.log('   1. node scripts/voximplant-setup.mjs  ← настройка Voximplant');
console.log('   2. Купи номер в https://manage.voximplant.com → Numbers');
console.log('   3. Позвони на номер — AI Айгуль ответит!\n');

process.on('SIGINT', async () => {
  console.log('\n🛑 Закрываем туннель...');
  await ngrok.disconnect();
  process.exit(0);
});
