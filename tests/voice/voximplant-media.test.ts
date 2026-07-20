import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VoximplantMediaTransport,
  VoximplantProtocolError,
} from '../../src/voice/telephony/voximplant-media';

test('parses documented Voximplant start, media and stop frames', () => {
  const sent: Array<string | Buffer> = [];
  const transport = new VoximplantMediaTransport({
    send: (data) => sent.push(data),
  });

  const start = transport.accept(
    JSON.stringify({
      event: 'start',
      sequenceNumber: 0,
      start: {
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
        customParameters: { callId: 'call-1' },
      },
    }),
    false
  );
  const media = transport.accept(
    JSON.stringify({
      event: 'media',
      sequenceNumber: 1,
      media: {
        chunk: 1,
        timestamp: 20,
        payload: Buffer.from([1, 2, 3]).toString('base64'),
      },
    }),
    false
  );
  const stop = transport.accept(
    JSON.stringify({ event: 'stop', sequenceNumber: 2, stop: {} }),
    false
  );

  assert.deepEqual(start, {
    type: 'start',
    sequenceNumber: 0,
    customParameters: { callId: 'call-1' },
  });
  assert.deepEqual(media, {
    type: 'audio',
    sequenceNumber: 1,
    timestampMs: 20,
    data: Buffer.from([1, 2, 3]),
  });
  assert.deepEqual(stop, { type: 'stop', sequenceNumber: 2 });
  assert.equal(transport.transportMode, 'media');
  assert.deepEqual(sent, []);
});

test('rejects unsupported codecs, malformed base64 and replayed sequences', () => {
  const transport = new VoximplantMediaTransport({ send: () => undefined });
  assert.throws(
    () =>
      transport.accept(
        JSON.stringify({
          event: 'start',
          sequenceNumber: 0,
          start: {
            mediaFormat: {
              encoding: 'audio/pcm',
              sampleRate: 16000,
              channels: 1,
            },
          },
        }),
        false
      ),
    (error: unknown) =>
      error instanceof VoximplantProtocolError &&
      error.code === 'unsupported_format'
  );

  const valid = new VoximplantMediaTransport({ send: () => undefined });
  valid.accept(
    JSON.stringify({
      event: 'start',
      sequenceNumber: 0,
      start: {
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
      },
    }),
    false
  );
  assert.throws(
    () =>
      valid.accept(
        JSON.stringify({
          event: 'media',
          sequenceNumber: 1,
          media: { payload: '***=' },
        }),
        false
      ),
    (error: unknown) =>
      error instanceof VoximplantProtocolError &&
      error.code === 'invalid_message'
  );
  assert.throws(
    () =>
      valid.accept(
        JSON.stringify({ event: 'stop', sequenceNumber: 0, stop: {} }),
        false
      ),
    (error: unknown) =>
      error instanceof VoximplantProtocolError &&
      error.code === 'invalid_sequence'
  );
});

test('writes 20 ms μ-law media frames and flushes the final partial frame', () => {
  const sent: string[] = [];
  const transport = new VoximplantMediaTransport({
    mode: 'media',
    send: (data) => sent.push(String(data)),
  });

  transport.sendAudio(Buffer.alloc(400, 7));
  assert.equal(sent.length, 3);
  transport.finishOutput();
  assert.equal(sent.length, 5);

  const messages = sent.map(
    (frame) => JSON.parse(frame) as Record<string, unknown>
  );
  assert.equal(messages[0]?.['event'], 'start');
  const media = messages.filter((message) => message['event'] === 'media');
  assert.deepEqual(
    media.map((message) =>
      Buffer.from(
        (message['media'] as Record<string, string>)['payload']!,
        'base64'
      ).length
    ),
    [160, 160, 80]
  );
  assert.equal(messages[4]?.['event'], 'stop');
});

test('barge-in discards pending audio and emits a clear-media control event', () => {
  const sent: string[] = [];
  const transport = new VoximplantMediaTransport({
    mode: 'media',
    send: (data) => sent.push(String(data)),
  });

  transport.sendAudio(Buffer.alloc(80, 1));
  transport.clearPlayback(4, 'barge-in');
  transport.sendAudio(Buffer.alloc(160, 2));

  const messages = sent.map(
    (frame) => JSON.parse(frame) as Record<string, unknown>
  );
  const clear = messages.find(
    (message) => message['customEvent'] === 'clear_media_buffer'
  );
  assert.deepEqual(clear, {
    customEvent: 'clear_media_buffer',
    generation: 4,
    reason: 'barge-in',
  });
  const media = messages.filter((message) => message['event'] === 'media');
  assert.equal(media.length, 1);
  assert.deepEqual(
    Buffer.from(
      (media[0]?.['media'] as Record<string, string>)['payload']!,
      'base64'
    ),
    Buffer.alloc(160, 2)
  );
});

test('legacy mode remains raw binary compatible', () => {
  const sent: Array<string | Buffer> = [];
  const transport = new VoximplantMediaTransport({
    mode: 'legacy',
    send: (data) => sent.push(data),
  });
  const incoming = transport.accept(Buffer.from([1, 2]), true);
  transport.sendAudio(Buffer.from([3, 4]));

  assert.deepEqual(incoming, {
    type: 'audio',
    data: Buffer.from([1, 2]),
  });
  assert.deepEqual(sent, [Buffer.from([3, 4])]);
});

test('queues early assistant audio until the inbound protocol is known', () => {
  const sent: string[] = [];
  const transport = new VoximplantMediaTransport({
    send: data => sent.push(String(data)),
  });

  transport.sendAudio(Buffer.alloc(200, 9));
  transport.finishOutput();
  assert.deepEqual(sent, []);

  transport.accept(
    JSON.stringify({
      event: 'start',
      sequenceNumber: 0,
      start: {
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
      },
    }),
    false
  );

  const messages = sent.map(
    frame => JSON.parse(frame) as Record<string, unknown>
  );
  assert.deepEqual(
    messages.map(message => message['event']),
    ['start', 'media', 'media', 'stop']
  );
});

test('bounds assistant audio queued before protocol start', () => {
  const transport = new VoximplantMediaTransport({
    maxQueuedOutboundBytes: 8,
    send: () => undefined,
  });
  transport.sendAudio(Buffer.alloc(8));
  assert.throws(
    () => transport.sendAudio(Buffer.alloc(1)),
    (error: unknown) =>
      error instanceof VoximplantProtocolError &&
      error.code === 'payload_too_large'
  );
});
