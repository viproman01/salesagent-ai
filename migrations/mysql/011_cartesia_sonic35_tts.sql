ALTER TABLE voice_sessions
  ADD COLUMN IF NOT EXISTS tts_provider VARCHAR(20) NOT NULL DEFAULT 'fish' AFTER deep_llm_model,
  ADD COLUMN IF NOT EXISTS tts_model VARCHAR(100) NOT NULL DEFAULT 's2.1-pro-free' AFTER tts_provider;

UPDATE agents
SET voice_config = JSON_SET(
      voice_config,
      '$.provider', 'cartesia',
      '$.model', 'sonic-3.5',
      '$.voiceId', '779673f3-895f-4935-b6b5-b031dc78b319'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE name = 'Mommy'
  AND is_active = true;
