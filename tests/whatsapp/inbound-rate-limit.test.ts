import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../../src/config';
import { checkWhatsAppInboundRateLimit } from '../../src/whatsapp/inbound-rate-limit';

class FakeRedis {
  readonly counters = new Map<string, number>();
  readonly expirations = new Map<string, number>();
  evalCalls = 0;

  async eval(
    _script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<readonly [number, number]> {
    assert.equal(numberOfKeys, 2);
    this.evalCalls += 1;
    const senderKey = String(args[0]);
    const orgKey = String(args[1]);
    const milliseconds = Number(args[2]);
    const sender = (this.counters.get(senderKey) ?? 0) + 1;
    const org = (this.counters.get(orgKey) ?? 0) + 1;
    this.counters.set(senderKey, sender);
    this.counters.set(orgKey, org);
    if (sender === 1) this.expirations.set(senderKey, milliseconds);
    if (org === 1) this.expirations.set(orgKey, milliseconds);
    return [sender, org];
  }
}

describe('WhatsApp inbound rate limit', () => {
  it('limits one sender and notifies only on the first rejected message', async () => {
    const redis = new FakeRedis();
    for (let index = 0; index < config.WHATSAPP_INBOUND_RATE_MAX_MESSAGES; index++) {
      const result = await checkWhatsAppInboundRateLimit(
        '11111111-1111-4111-8111-111111111111',
        '77001234567',
        redis
      );
      assert.equal(result.allowed, true);
    }
    const rejected = await checkWhatsAppInboundRateLimit(
      '11111111-1111-4111-8111-111111111111',
      '77001234567',
      redis
    );
    const repeated = await checkWhatsAppInboundRateLimit(
      '11111111-1111-4111-8111-111111111111',
      '77001234567',
      redis
    );
    assert.deepEqual(
      { allowed: rejected.allowed, notify: rejected.notify },
      { allowed: false, notify: true }
    );
    assert.deepEqual(
      { allowed: repeated.allowed, notify: repeated.notify },
      { allowed: false, notify: false }
    );
    assert.ok(redis.expirations.size >= 2);
    assert.equal(
      redis.evalCalls,
      config.WHATSAPP_INBOUND_RATE_MAX_MESSAGES + 2
    );
  });

  it('enforces a tenant-wide burst ceiling across distinct contacts', async () => {
    const redis = new FakeRedis();
    let last = { allowed: true, notify: false, remaining: 0 };
    for (
      let index = 0;
      index <= config.WHATSAPP_INBOUND_ORG_RATE_MAX_MESSAGES;
      index++
    ) {
      last = await checkWhatsAppInboundRateLimit(
        '22222222-2222-4222-8222-222222222222',
        `7700${String(index).padStart(7, '0')}`,
        redis
      );
    }
    assert.equal(last.allowed, false);
    assert.equal(last.notify, true);
  });

  it('fails closed without exposing sender identity when Redis is unavailable', async () => {
    const result = await checkWhatsAppInboundRateLimit(
      '33333333-3333-4333-8333-333333333333',
      '77007654321',
      {
        eval: async () => { throw new Error('private redis details'); },
      }
    );
    assert.equal(result.allowed, false);
    assert.equal(result.notify, false);
    assert.equal(result.remaining, 0);
  });

  it('fails closed on malformed atomic script results', async () => {
    const result = await checkWhatsAppInboundRateLimit(
      '44444444-4444-4444-8444-444444444444',
      '77001112233',
      { eval: async () => ['not-a-counter'] }
    );
    assert.equal(result.allowed, false);
    assert.equal(result.notify, false);
    assert.equal(result.remaining, 0);
  });
});
