UPDATE agents
SET voice_config = JSON_SET(
      voice_config,
      '$.stt',
      COALESCE(
        JSON_EXTRACT(voice_config, '$.stt'),
        JSON_OBJECT(
          'provider', 'openrouter',
          'model', 'deepgram/nova-3',
          'language', 'ru'
        )
      ),
      '$.vad',
      JSON_OBJECT(
        'silenceMs', 650,
        'maxUtteranceSeconds', 30
      )
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'a179a69b-2cd1-4318-9758-2354c8d87fad';
