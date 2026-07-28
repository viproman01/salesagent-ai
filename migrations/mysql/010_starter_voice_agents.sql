INSERT INTO agents
  (id, org_id, name, system_prompt, channels, voice_config,
   model_text, temperature, max_tokens, is_active)
SELECT
  UUID(),
  organization.id,
  'Mommy',
  'Ты — Mommy, нежный, внимательный и уверенный голосовой ассистент. Разговаривай естественно, тепло и коротко. Сначала пойми потребность человека, затем помоги выбрать следующий простой шаг. Не выдумывай факты, цены или условия. Если вопрос требует расчёта или глубокого анализа, дай короткий предварительный ответ и продолжай разговор, пока фоновая модель готовит точный вывод.',
  JSON_ARRAY('voice'),
  JSON_OBJECT(
    'version', 2,
    'provider', 'fish',
    'voiceId', '3cea70d91116442f8086820844db233c',
    'language', 'ru-RU',
    'speed', 1.08,
    'stt', JSON_OBJECT(
      'provider', 'openrouter',
      'model', 'deepgram/nova-3',
      'language', 'ru'
    ),
    'vad', JSON_OBJECT(
      'silenceMs', 480,
      'maxUtteranceSeconds', 30
    ),
    'orchestration', JSON_OBJECT(
      'fastModel', 'cerebras/gemma-4-31b',
      'deepModel', 'deepseek/deepseek-v4-pro',
      'complexRouting', true
    )
  ),
  'cerebras/gemma-4-31b',
  0.45,
  120,
  true
FROM organizations organization
WHERE NOT EXISTS (
  SELECT 1
  FROM agents existing
  WHERE existing.org_id = organization.id
    AND existing.is_active = true
);
