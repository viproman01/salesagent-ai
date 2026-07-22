import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';

export type VoiceWebSocketIdentity = Readonly<{
  sessionId: string;
  orgId: string;
  phone: string;
}>;

export type VoiceWebSocketAuthorization =
  | Readonly<{ ok: true; identity: VoiceWebSocketIdentity }>
  | Readonly<{
      ok: false;
      code: 'configuration' | 'unauthorized' | 'invalid_request';
    }>;

export function authorizeVoiceWebSocketRequest(
  req: IncomingMessage,
  expectedOrgId: string | undefined,
  expectedToken: string | undefined
): VoiceWebSocketAuthorization {
  const orgId = expectedOrgId?.trim();
  const token = expectedToken?.trim();
  if (!orgId || !token || token.length < 32) {
    return { ok: false, code: 'configuration' };
  }

  const suppliedToken = singleHeader(req.headers['x-voice-token']);
  if (!suppliedToken || !isVoiceTokenValid(suppliedToken, token)) {
    return { ok: false, code: 'unauthorized' };
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://voice.internal');
  } catch {
    return { ok: false, code: 'invalid_request' };
  }
  if (url.pathname !== '/ws/voice') {
    return { ok: false, code: 'invalid_request' };
  }

  const requestedOrgId = url.searchParams.get('orgId');
  if (requestedOrgId !== orgId) {
    return { ok: false, code: 'unauthorized' };
  }

  const sessionId = url.searchParams.get('callId')?.trim() ?? '';
  const phone = url.searchParams.get('phone')?.trim() ?? '';
  if (
    !/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId) ||
    !/^\+?[0-9]{3,24}$/.test(phone)
  ) {
    return { ok: false, code: 'invalid_request' };
  }

  return {
    ok: true,
    identity: {
      sessionId,
      orgId,
      phone,
    },
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string'
    ? value
    : Array.isArray(value) && value.length === 1
      ? value[0]
      : undefined;
}

export function isVoiceTokenValid(
  supplied: string | undefined,
  expected: string | undefined
): boolean {
  if (!supplied || !expected) return false;
  const left = supplied;
  const right = expected;
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
