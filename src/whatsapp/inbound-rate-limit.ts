import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getRedisConnection } from '../utils/redis';

export type WhatsAppRateLimitResult = Readonly<{
  allowed: boolean;
  notify: boolean;
  remaining: number;
}>;

type RedisRateLimitConnection = Readonly<{
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}>;

const INCREMENT_WITH_EXPIRY = `
local senderCurrent = redis.call('INCR', KEYS[1])
if senderCurrent == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local orgCurrent = redis.call('INCR', KEYS[2])
if orgCurrent == 1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
end
return { senderCurrent, orgCurrent }
`;

export async function checkWhatsAppInboundRateLimit(
  orgId: string,
  phone: string,
  redis: RedisRateLimitConnection = getRedisConnection()
): Promise<WhatsAppRateLimitResult> {
  const identity = createHash('sha256')
    .update(`${orgId}:${phone}`)
    .digest('hex')
    .slice(0, 24);
  const orgIdentity = createHash('sha256')
    .update(orgId)
    .digest('hex')
    .slice(0, 24);
  // A shared hash tag keeps both keys in one Redis Cluster slot. The Lua
  // script increments both counters and establishes their TTL atomically.
  const senderKey = `whatsapp:inbound-rate:{${orgIdentity}}:sender:${identity}`;
  const orgKey = `whatsapp:inbound-rate:{${orgIdentity}}:org`;

  try {
    const counters = await bounded(
      redis.eval(
        INCREMENT_WITH_EXPIRY,
        2,
        senderKey,
        orgKey,
        config.WHATSAPP_INBOUND_RATE_WINDOW_MS
      )
    );
    const [senderCurrent, orgCurrent] = parseCounters(counters);
    const senderAllowed =
      senderCurrent <= config.WHATSAPP_INBOUND_RATE_MAX_MESSAGES;
    const orgAllowed =
      orgCurrent <= config.WHATSAPP_INBOUND_ORG_RATE_MAX_MESSAGES;
    return {
      allowed: senderAllowed && orgAllowed,
      notify:
        (!senderAllowed &&
          senderCurrent === config.WHATSAPP_INBOUND_RATE_MAX_MESSAGES + 1) ||
        (!orgAllowed &&
          orgCurrent === config.WHATSAPP_INBOUND_ORG_RATE_MAX_MESSAGES + 1),
      remaining: Math.max(
        0,
        Math.min(
          config.WHATSAPP_INBOUND_RATE_MAX_MESSAGES - senderCurrent,
          config.WHATSAPP_INBOUND_ORG_RATE_MAX_MESSAGES - orgCurrent
        )
      ),
    };
  } catch {
    logger.warn('WhatsApp inbound rate limiter unavailable; failing closed', {
      orgId,
    });
    return {
      allowed: false,
      notify: false,
      remaining: 0,
    };
  }
}

function parseCounters(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Invalid WhatsApp rate limiter response');
  }
  const sender = Number(value[0]);
  const org = Number(value[1]);
  if (
    !Number.isSafeInteger(sender) ||
    sender < 1 ||
    !Number.isSafeInteger(org) ||
    org < 1
  ) {
    throw new Error('Invalid WhatsApp rate limiter counters');
  }
  return [sender, org];
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WhatsApp rate limiter timeout')),
      500
    );
    timer.unref();
    operation.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
