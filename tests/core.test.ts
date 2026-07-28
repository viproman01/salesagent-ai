import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSql } from '../src/db';
import { AGENT_TOOLS } from '../src/ai/tools';
import { createOpenRouterRequestBody, openRouterTools } from '../src/ai/openrouter';
import { getRotatedKeyIndexes, selectReadyKeyIndexes } from '../src/ai/cerebras';
import { formatModelReference, parseModelReference } from '../src/ai/chat-provider';
import { secretsMatch } from '../src/middleware/webhookAuth';
import { createSttRequestBody, detectAudioFormat } from '../src/ai/openrouter-stt';
import { assessVoiceComplexity, buildFastVoiceContext } from '../src/orchestrator/voice-dual-model';
import { parseClassifierResponse } from '../src/orchestrator/classifier';
import { MOMMY_VOICE_ID, starterVoiceConfig } from '../src/agents/starter';
import { createCartesiaTtsRequest } from '../src/ai/cartesia';

test('compileSql preserves numbered parameter order and repeated values', () => {
  const compiled = compileSql(
    'INSERT INTO example (a, b, c, d) VALUES ($2, $1, $2, $3::jsonb)',
    ['first', 'second', '{"ok":true}']
  );

  assert.equal(compiled.statement, 'INSERT INTO example (a, b, c, d) VALUES (?, ?, ?, ?)');
  assert.deepEqual(compiled.values, ['second', 'first', 'second', '{"ok":true}']);
});

test('compileSql rejects references to missing parameters', () => {
  assert.throws(
    () => compileSql('SELECT $2', ['only-one']),
    /Missing SQL parameter \$2/
  );
});

test('webhook secret comparison rejects missing and mismatched secrets', () => {
  assert.equal(secretsMatch(undefined, 'secret'), false);
  assert.equal(secretsMatch('wrong', 'secret'), false);
  assert.equal(secretsMatch('secret', 'secret'), true);
});

test('OpenRouter receives the canonical tool schemas', () => {
  assert.equal(openRouterTools.length, AGENT_TOOLS.length);
  const meeting = openRouterTools.find(tool => tool.function.name === 'book_meeting');
  assert.ok(meeting);
  assert.deepEqual(meeting.function.parameters.required, ['title', 'datetime_utc']);
  assert.ok('datetime_utc' in (meeting.function.parameters.properties as Record<string, unknown>));
  assert.ok(!('datetime' in (meeting.function.parameters.properties as Record<string, unknown>)));
});

test('Cerebras key order rotates and never repeats a key in one request', () => {
  assert.deepEqual(getRotatedKeyIndexes(5, 0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(getRotatedKeyIndexes(5, 3, 5), [3, 4, 0, 1, 2]);
  assert.deepEqual(getRotatedKeyIndexes(5, 4, 2), [4, 0]);
  assert.deepEqual(getRotatedKeyIndexes(0, 0, 5), []);
});

test('Cerebras probes the earliest key instead of failing when every key is cooling down', () => {
  const cooldowns = new Map([[0, 5_000], [1, 3_000], [2, 4_000]]);
  assert.deepEqual(selectReadyKeyIndexes([0, 1, 2], cooldowns, 1_000), [1]);
  assert.deepEqual(selectReadyKeyIndexes([0, 1, 2], cooldowns, 4_500), [1, 2]);
});

test('model references preserve OpenRouter IDs and namespace Cerebras IDs', () => {
  assert.deepEqual(parseModelReference('deepseek/deepseek-v4-flash'), {
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
  });
  assert.deepEqual(parseModelReference('cerebras/gemma-4-31b'), {
    provider: 'cerebras',
    model: 'gemma-4-31b',
  });
  assert.equal(formatModelReference('openrouter', 'openrouter/auto'), 'openrouter/auto');
  assert.equal(formatModelReference('cerebras', 'gemma-4-31b'), 'cerebras/gemma-4-31b');
});

test('OpenRouter STT request uses deepgram/nova-3 and raw base64 audio', () => {
  const audio = Buffer.from('RIFFxxxxWAVEvoice');
  const body = createSttRequestBody(audio, 'wav', 'deepgram/nova-3', 'ru') as {
    model: string;
    input_audio: { data: string; format: string };
    language: string;
  };
  assert.equal(body.model, 'deepgram/nova-3');
  assert.equal(body.language, 'ru');
  assert.equal(body.input_audio.format, 'wav');
  assert.equal(Buffer.from(body.input_audio.data, 'base64').toString(), audio.toString());
});

test('audio signature validation rejects spoofed MIME types', () => {
  const wav = Buffer.from('RIFFxxxxWAVEvoice');
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
  assert.equal(detectAudioFormat('audio/wav', wav), 'wav');
  assert.equal(detectAudioFormat('audio/webm;codecs=opus', webm), 'webm');
  assert.equal(detectAudioFormat('audio/wav', Buffer.from('not-wave')), null);
  assert.equal(detectAudioFormat('application/octet-stream', wav), null);
});

test('voice complexity routing keeps simple dialogue fast and escalates hard questions', () => {
  assert.equal(assessVoiceComplexity('Здравствуйте, сколько это стоит?').complex, false);
  const complex = assessVoiceComplexity(
    'Проанализируй риски интеграции и рассчитай окупаемость по нескольким вариантам'
  );
  assert.equal(complex.complex, true);
  assert.ok(complex.score >= 3);
  assert.ok(complex.reasons.includes('analysis'));
  assert.match(buildFastVoiceContext({ complexity: complex }), /фоновому эксперту/);
});

test('DeepSeek background requests prefer throughput and high reasoning', () => {
  const body = createOpenRouterRequestBody(
    'deepseek/deepseek-v4-pro',
    [{ role: 'user', content: 'Сложный вопрос' }],
    {
      temperature: 0.2,
      maxTokens: 1200,
      tools: false,
      providerSort: 'throughput',
      reasoningEffort: 'high',
    }
  );
  assert.equal(body['model'], 'deepseek/deepseek-v4-pro');
  assert.deepEqual(body['provider'], { sort: 'throughput', allow_fallbacks: true });
  assert.deepEqual(body['reasoning'], { effort: 'high', exclude: true });
});

test('classifier accepts plain or fenced JSON and validates the stage', () => {
  const valid = {
    stage: 'interested',
    confidence: 0.85,
    sentiment: 'positive',
    key_signals: ['спросил цену'],
    objections: [],
    next_action: 'отправить предложение',
    summary: 'Клиент заинтересован.',
  };
  assert.deepEqual(parseClassifierResponse(JSON.stringify(valid)), valid);
  assert.deepEqual(
    parseClassifierResponse(`Краткий результат:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``),
    valid
  );
  assert.equal(
    parseClassifierResponse(JSON.stringify({ ...valid, stage: 'invented-stage' })),
    null
  );
});

test('classifier ignores incomplete JSON instead of throwing', () => {
  assert.equal(
    parseClassifierResponse('{"stage":"contacted","confidence":0.8'),
    null
  );
});

test('starter agent is immediately ready for the complete voice pipeline', () => {
  const voice = starterVoiceConfig() as {
    provider: string;
    model: string;
    voiceId: string;
    speed: number;
    stt: { model: string };
    vad: { silenceMs: number };
    orchestration: { fastModel: string; deepModel: string; complexRouting: boolean };
  };
  assert.equal(voice.provider, 'cartesia');
  assert.equal(voice.model, 'sonic-3.5');
  assert.equal(voice.voiceId, MOMMY_VOICE_ID);
  assert.equal(voice.stt.model, 'deepgram/nova-3');
  assert.equal(voice.orchestration.fastModel, 'cerebras/gemma-4-31b');
  assert.equal(voice.orchestration.deepModel, 'deepseek/deepseek-v4-pro');
  assert.equal(voice.orchestration.complexRouting, true);
  assert.equal(voice.vad.silenceMs, 480);
});

test('Cartesia Sonic 3.5 request streams Russian MP3 with a voice ID', () => {
  const body = createCartesiaTtsRequest('Здравствуйте!', MOMMY_VOICE_ID, 'sonic-3.5') as {
    model_id: string;
    transcript: string;
    voice: { mode: string; id: string };
    output_format: { container: string; sample_rate: number; bit_rate: number };
    language: string;
  };
  assert.equal(body.model_id, 'sonic-3.5');
  assert.equal(body.voice.mode, 'id');
  assert.equal(body.voice.id, MOMMY_VOICE_ID);
  assert.equal(body.output_format.container, 'mp3');
  assert.equal(body.output_format.sample_rate, 44_100);
  assert.equal(body.language, 'ru');
});
