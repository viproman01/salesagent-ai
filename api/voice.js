/**
 * api/voice.js — Vercel Serverless Function
 *
 * HTTP-callback endpoint для Voximplant.
 * Использует Google Gemini 2.5 Flash.
 *
 * POST /api/voice
 * Body: { session_id, phone, text, is_greeting, history: [{role, text}] }
 * Response: { text: "ответ AI" }
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const SYSTEM = `Ты — Айгуль, консультант цветочного магазина "Цветочный мир" в Алматы.
Правила: отвечай кратко (1-2 предложения), говори по-русски, без эмодзи и списков.
Помогай выбрать букет, уточняй повод и бюджет.
Ассортимент: розы от 2000 тг, тюльпаны от 1500 тг, хризантемы от 1800 тг, готовые букеты от 5000 тг.`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { text = '', is_greeting = false, history = [] } = req.body || {};

  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM,
      generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
    });

    // Строим историю чата
    let contents;

    if (is_greeting || history.length === 0) {
      contents = [{ role: 'user', parts: [{ text: 'Клиент позвонил. Поздоровайся и предложи помощь.' }] }];
    } else {
      // Конвертируем историю + текущий вопрос
      const historyContents = history.slice(-10).map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      }));
      contents = [...historyContents, { role: 'user', parts: [{ text }] }];
    }

    const result  = await model.generateContent({ contents });
    const raw     = result.response.text().trim();

    // Убираем лишние артефакты: "Айгуль:", кавычки и т.д.
    const cleaned = raw
      .replace(/^(Айгуль|AI|Assistant)\s*:/i, '')
      .replace(/^["«»]|["«»]$/g, '')
      .trim();

    console.log('[voice] response:', cleaned.slice(0, 100));
    return res.status(200).json({ text: cleaned || 'Чем могу помочь?', ok: true });

  } catch (err) {
    console.error('[voice] error:', err?.message?.slice(0, 200));
    return res.status(200).json({
      text: 'Извините, произошла техническая ошибка. Попробуйте позвонить позже.',
      ok: false,
      error: err?.message?.slice(0, 100),
    });
  }
};
