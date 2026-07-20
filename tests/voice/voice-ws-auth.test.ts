import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'http';
import { authorizeVoiceWebSocketRequest } from '../../src/voice/telephony/voice-ws-auth';

const TOKEN = 'a-secure-voice-token-with-more-than-32-characters';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

function request(
  url: string,
  token: string | null = TOKEN
): IncomingMessage {
  return {
    url,
    headers: token ? { 'x-voice-token': token } : {},
  } as IncomingMessage;
}

test('authorizes only the configured tenant and signed Voximplant request', () => {
  const result = authorizeVoiceWebSocketRequest(
    request(
      `/ws/voice?callId=call-1&phone=%2B77010000000&orgId=${ORG_ID}`
    ),
    ORG_ID,
    TOKEN
  );
  assert.deepEqual(result, {
    ok: true,
    identity: {
      sessionId: 'call-1',
      orgId: ORG_ID,
      phone: '+77010000000',
    },
  });
});

test('rejects missing or incorrect credentials before tenant lookup', () => {
  const url =
    `/ws/voice?callId=call-1&phone=%2B77010000000&orgId=${ORG_ID}`;
  assert.equal(
    authorizeVoiceWebSocketRequest(request(url, null), ORG_ID, TOKEN).ok,
    false
  );
  assert.equal(
    authorizeVoiceWebSocketRequest(request(url, `${TOKEN}x`), ORG_ID, TOKEN).ok,
    false
  );
  assert.equal(
    authorizeVoiceWebSocketRequest(
      request(url),
      '22222222-2222-4222-8222-222222222222',
      TOKEN
    ).ok,
    false
  );
});

test('rejects unsafe paths and malformed call identity fields', () => {
  assert.equal(
    authorizeVoiceWebSocketRequest(
      request(`/other?callId=call-1&phone=7701&orgId=${ORG_ID}`),
      ORG_ID,
      TOKEN
    ).ok,
    false
  );
  assert.equal(
    authorizeVoiceWebSocketRequest(
      request(
        `/ws/voice?callId=../../secret&phone=not-a-phone&orgId=${ORG_ID}`
      ),
      ORG_ID,
      TOKEN
    ).ok,
    false
  );
});
