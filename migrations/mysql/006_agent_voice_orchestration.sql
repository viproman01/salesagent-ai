UPDATE agents
SET name = 'Алекс — Gemma 4 + DeepSeek V4 Pro',
    model_text = 'cerebras/gemma-4-31b',
    max_tokens = LEAST(max_tokens, 260),
    voice_config = JSON_SET(
      voice_config,
      '$.orchestration',
      JSON_OBJECT(
        'fastModel', 'cerebras/gemma-4-31b',
        'deepModel', 'deepseek/deepseek-v4-pro',
        'complexRouting', true
      )
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'a179a69b-2cd1-4318-9758-2354c8d87fad';
