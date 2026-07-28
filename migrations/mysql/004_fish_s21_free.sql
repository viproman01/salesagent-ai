ALTER TABLE agents
  MODIFY COLUMN model_voice VARCHAR(100) NOT NULL DEFAULT 's2.1-pro-free';

UPDATE agents
SET model_voice = 's2.1-pro-free'
WHERE model_voice = 's2-pro';
