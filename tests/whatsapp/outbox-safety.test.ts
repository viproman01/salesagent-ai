import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('WhatsApp outbox keeps network I/O outside transactions and gates cold outbound', async () => {
  const source = await readFile(
    path.resolve('src/whatsapp/outbox.ts'),
    'utf8'
  );

  const claimStart = source.indexOf('async function claimWhatsAppOutboxItem');
  const finalizeStart = source.indexOf('async function finalizeSentOutboxItem');
  const claimSource = source.slice(claimStart, finalizeStart);
  assert.doesNotMatch(claimSource, /sendWhatsAppMessage\s*\(/u);
  assert.match(source, /boundedSend\s*\(/u);
  assert.match(source, /state\.status !== 'active'/u);
  assert.match(source, /current_whatsapp_jid !== item\.reply_jid/u);
  assert.match(source, /INTERVAL '24 hours'/u);
});

test('WhatsApp outbox orders one active item per conversation by message sequence', async () => {
  const source = await readFile(
    path.resolve('src/whatsapp/outbox.ts'),
    'utf8'
  );

  assert.match(source, /prior_message\.sequence_id < candidate_message\.sequence_id/u);
  assert.match(source, /prior\.status IN \('pending', 'sending'\)/u);
  assert.match(source, /status = 'sending'[\s\S]*attempts >= \$1/u);
  assert.match(source, /export function isWhatsAppOutboxWorkerRunning/u);
});

test('WhatsApp follow-up uses a scheduling baseline and the policy outbox', async () => {
  const source = await readFile(
    path.resolve('src/orchestrator/follow-up.ts'),
    'utf8'
  );

  assert.doesNotMatch(source, /sendWhatsAppMessage/u);
  assert.match(source, /baselineSequenceId/u);
  assert.match(source, /newer\.sequence_id > \$4::bigint/u);
  assert.match(source, /enqueueWhatsAppReply/u);
  assert.match(source, /kind: 'follow_up'/u);
  assert.match(source, /requiredMode: 'ai'/u);
  assert.match(source, /requiredVersion: current\.mode_version/u);
});

test('WhatsApp controls are rate limited without delaying STOP state', async () => {
  const source = await readFile(
    path.resolve('src/orchestrator/session-manager.ts'),
    'utf8'
  );
  const processStart = source.indexOf('async function processWhatsAppTurn');
  const persistStart = source.indexOf('async function persistWhatsAppInbound');
  const processSource = source.slice(processStart, persistStart);

  assert.ok(processStart >= 0 && persistStart > processStart);
  assert.ok(
    processSource.indexOf('checkWhatsAppInboundRateLimit') <
      processSource.indexOf("prepared.action === 'control'")
  );
  assert.match(
    processSource,
    /rate\.notify && prepared\.action === 'generate'/u
  );
  assert.match(
    source.slice(persistStart, source.indexOf('async function applyControlCommand')),
    /command === 'stop'[\s\S]*applyControlCommand/u
  );
});

test('new WhatsApp conversations inherit lead opt-out and human handoff', async () => {
  const source = await readFile(
    path.resolve('src/orchestrator/session-manager.ts'),
    'utf8'
  );
  const createStart = source.indexOf('async function getOrCreateConversation');
  const createSource = source.slice(createStart);

  assert.match(createSource, /whatsappHumanHandoff/u);
  assert.match(createSource, /whatsappOptedOut/u);
  assert.match(createSource, /THEN 'operator'/u);
});
