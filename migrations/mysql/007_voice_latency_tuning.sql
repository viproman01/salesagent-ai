UPDATE agents
SET voice_config = JSON_SET(
      voice_config,
      '$.speed', 1.05,
      '$.vad.silenceMs', 650
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'a179a69b-2cd1-4318-9758-2354c8d87fad';
