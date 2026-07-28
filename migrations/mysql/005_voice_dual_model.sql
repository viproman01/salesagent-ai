ALTER TABLE voice_sessions
  ADD COLUMN deep_llm_model VARCHAR(200) NOT NULL DEFAULT 'deepseek/deepseek-v4-pro' AFTER llm_model;

CREATE TABLE IF NOT EXISTS voice_deep_tasks (
  id CHAR(36) PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  source_utterance_id CHAR(36) NOT NULL,
  question TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'processing',
  model VARCHAR(200) NOT NULL,
  answer TEXT NULL,
  delivered_text TEXT NULL,
  error_message VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  delivered_at TIMESTAMP NULL,
  CONSTRAINT fk_voice_deep_tasks_session
    FOREIGN KEY (session_id) REFERENCES voice_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_voice_deep_tasks_utterance
    FOREIGN KEY (source_utterance_id) REFERENCES voice_utterances(id) ON DELETE CASCADE,
  INDEX idx_voice_deep_tasks_session_status (session_id, status, created_at)
);

UPDATE agents
SET model_text = 'cerebras/gemma-4-31b',
    max_tokens = LEAST(max_tokens, 260),
    voice_config = JSON_SET(
      voice_config,
      '$.orchestration.fastModel', 'cerebras/gemma-4-31b',
      '$.orchestration.deepModel', 'deepseek/deepseek-v4-pro',
      '$.orchestration.complexRouting', true
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'a179a69b-2cd1-4318-9758-2354c8d87fad';
