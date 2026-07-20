export type VoximplantTransportMode = 'auto' | 'media' | 'legacy';

export type VoximplantInboundEvent =
  | Readonly<{
      type: 'start';
      sequenceNumber: number;
      customParameters: Record<string, string>;
    }>
  | Readonly<{
      type: 'audio';
      sequenceNumber?: number;
      timestampMs?: number;
      data: Buffer;
    }>
  | Readonly<{
      type: 'stop';
      sequenceNumber: number;
    }>
  | Readonly<{
      type: 'custom';
      name: string;
      payload: Record<string, unknown>;
    }>;

export class VoximplantProtocolError extends Error {
  constructor(
    public readonly code:
      | 'invalid_json'
      | 'invalid_message'
      | 'unsupported_format'
      | 'invalid_sequence'
      | 'payload_too_large'
      | 'backpressure',
    message: string
  ) {
    super(message);
    this.name = 'VoximplantProtocolError';
  }
}

export type VoximplantMediaTransportOptions = Readonly<{
  mode?: VoximplantTransportMode;
  frameBytes?: number;
  maxInboundPayloadBytes?: number;
  maxQueuedOutboundBytes?: number;
  send: (data: string | Buffer) => void;
}>;

/**
 * Codec/state machine for Voximplant's documented WebSocket media protocol.
 * It keeps a legacy raw-binary mode so existing calls can be migrated safely.
 */
export class VoximplantMediaTransport {
  private mode: VoximplantTransportMode;
  private readonly frameBytes: number;
  private readonly maxInboundPayloadBytes: number;
  private readonly maxQueuedOutboundBytes: number;
  private readonly sendFrame: (data: string | Buffer) => void;
  private lastInboundSequence = -1;
  private outboundSequence = 0;
  private outboundChunk = 0;
  private outboundBytes = 0;
  private outputStarted = false;
  private pendingOutput = Buffer.alloc(0);
  private finishRequestedWhileAuto = false;
  private playbackGeneration: number | undefined;

  constructor(options: VoximplantMediaTransportOptions) {
    this.mode = options.mode ?? 'auto';
    this.frameBytes = positiveInteger(options.frameBytes, 160, 'frameBytes');
    this.maxInboundPayloadBytes = positiveInteger(
      options.maxInboundPayloadBytes,
      64 * 1024,
      'maxInboundPayloadBytes'
    );
    this.maxQueuedOutboundBytes = positiveInteger(
      options.maxQueuedOutboundBytes,
      64 * 1024,
      'maxQueuedOutboundBytes'
    );
    this.sendFrame = options.send;
  }

  get transportMode(): VoximplantTransportMode {
    return this.mode;
  }

  accept(data: Buffer | string, isBinary: boolean): VoximplantInboundEvent {
    if (isBinary) {
      if (this.mode === 'media') {
        throw new VoximplantProtocolError(
          'invalid_message',
          'Binary frames are not valid after Voximplant media protocol start'
        );
      }
      this.activateMode('legacy');
      if (Buffer.byteLength(data) > this.maxInboundPayloadBytes) {
        throw new VoximplantProtocolError(
          'payload_too_large',
          'Voximplant audio frame exceeds the configured limit'
        );
      }
      return {
        type: 'audio',
        data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof data === 'string' ? data : data.toString('utf8')
      );
    } catch {
      throw new VoximplantProtocolError(
        'invalid_json',
        'Voximplant sent malformed JSON'
      );
    }
    if (!isRecord(parsed)) {
      throw new VoximplantProtocolError(
        'invalid_message',
        'Voximplant message must be an object'
      );
    }

    const customEvent = parsed['customEvent'];
    if (typeof customEvent === 'string' && customEvent) {
      return {
        type: 'custom',
        name: customEvent,
        payload: parsed,
      };
    }

    const event = parsed['event'];
    const sequenceNumber = requireSequence(parsed['sequenceNumber']);
    this.acceptSequence(sequenceNumber);

    if (event === 'start') {
      if (this.mode === 'legacy') {
        throw new VoximplantProtocolError(
          'invalid_message',
          'Voximplant media protocol cannot start after legacy audio'
        );
      }
      const start = requireRecord(parsed['start'], 'start');
      const format = requireRecord(start['mediaFormat'], 'start.mediaFormat');
      if (
        format['encoding'] !== 'audio/x-mulaw' ||
        format['sampleRate'] !== 8000 ||
        format['channels'] !== 1
      ) {
        throw new VoximplantProtocolError(
          'unsupported_format',
          'Voximplant media must be mono μ-law at 8000 Hz'
        );
      }
      this.activateMode('media');
      return {
        type: 'start',
        sequenceNumber,
        customParameters: stringRecord(start['customParameters']),
      };
    }

    if (event === 'media') {
      if (this.mode !== 'media') {
        throw new VoximplantProtocolError(
          'invalid_message',
          'Voximplant media arrived before a start event'
        );
      }
      const media = requireRecord(parsed['media'], 'media');
      const payload = media['payload'];
      if (typeof payload !== 'string' || !isStrictBase64(payload)) {
        throw new VoximplantProtocolError(
          'invalid_message',
          'Voximplant media payload must be valid base64'
        );
      }
      const audio = Buffer.from(payload, 'base64');
      if (audio.length > this.maxInboundPayloadBytes) {
        throw new VoximplantProtocolError(
          'payload_too_large',
          'Voximplant audio frame exceeds the configured limit'
        );
      }
      const timestamp = media['timestamp'];
      return {
        type: 'audio',
        sequenceNumber,
        ...(typeof timestamp === 'number' && Number.isFinite(timestamp)
          ? { timestampMs: timestamp }
          : {}),
        data: audio,
      };
    }

    if (event === 'stop') {
      return { type: 'stop', sequenceNumber };
    }

    throw new VoximplantProtocolError(
      'invalid_message',
      'Unsupported Voximplant media event'
    );
  }

  sendAudio(audio: Buffer, generation?: number): void {
    if (audio.length === 0) return;
    if (
      generation !== undefined &&
      Number.isInteger(generation) &&
      generation >= 0 &&
      generation !== this.playbackGeneration
    ) {
      this.playbackGeneration = generation;
      this.sendCustomEvent('playback_generation', { generation });
    }
    if (this.mode === 'legacy') {
      this.sendFrame(Buffer.from(audio));
      return;
    }
    if (this.mode === 'auto') {
      if (
        this.pendingOutput.length + audio.length >
        this.maxQueuedOutboundBytes
      ) {
        throw new VoximplantProtocolError(
          'payload_too_large',
          'Voximplant outbound audio queue exceeds the configured limit'
        );
      }
      this.pendingOutput =
        this.pendingOutput.length === 0
          ? Buffer.from(audio)
          : Buffer.concat([this.pendingOutput, audio]);
      return;
    }

    this.ensureOutputStarted();
    this.pendingOutput =
      this.pendingOutput.length === 0
        ? Buffer.from(audio)
        : Buffer.concat([this.pendingOutput, audio]);
    while (this.pendingOutput.length >= this.frameBytes) {
      const frame = this.pendingOutput.subarray(0, this.frameBytes);
      this.pendingOutput = Buffer.from(
        this.pendingOutput.subarray(this.frameBytes)
      );
      this.sendMediaFrame(frame);
    }
  }

  finishOutput(): void {
    if (this.mode === 'auto') {
      this.finishRequestedWhileAuto = true;
      return;
    }
    if (this.mode !== 'media' || !this.outputStarted) return;
    if (this.pendingOutput.length > 0) {
      this.sendMediaFrame(this.pendingOutput);
      this.pendingOutput = Buffer.alloc(0);
    }
    this.sendJson({
      event: 'stop',
      sequenceNumber: this.outboundSequence++,
      stop: {
        mediaInfo: {
          bytesSent: this.outboundBytes,
          duration: this.outboundBytes / 8000,
        },
      },
    });
    this.outputStarted = false;
    this.outboundChunk = 0;
    this.outboundBytes = 0;
  }

  clearPlayback(generation: number, reason: string): void {
    this.playbackGeneration = generation;
    this.pendingOutput = Buffer.alloc(0);
    this.finishRequestedWhileAuto = false;
    if (this.mode === 'media' && this.outputStarted) {
      this.sendJson({
        event: 'stop',
        sequenceNumber: this.outboundSequence++,
        stop: {
          mediaInfo: {
            bytesSent: this.outboundBytes,
            duration: this.outboundBytes / 8000,
          },
        },
      });
      this.outputStarted = false;
      this.outboundChunk = 0;
      this.outboundBytes = 0;
    }
    this.sendJson({
      customEvent: 'clear_media_buffer',
      generation,
      reason,
    });
  }

  sendCustomEvent(
    name: string,
    payload: Readonly<Record<string, unknown>>
  ): void {
    if (!name.trim()) {
      throw new VoximplantProtocolError(
        'invalid_message',
        'Voximplant custom event name is required'
      );
    }
    this.sendJson({
      ...payload,
      customEvent: name,
    });
  }

  private ensureOutputStarted(): void {
    if (this.outputStarted) return;
    this.outputStarted = true;
    this.outboundChunk = 0;
    this.outboundBytes = 0;
    this.sendJson({
      event: 'start',
      sequenceNumber: this.outboundSequence++,
      start: {
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
        customParameters: {
          direction: 'assistant',
        },
      },
    });
  }

  private activateMode(mode: Exclude<VoximplantTransportMode, 'auto'>): void {
    if (this.mode === mode) return;
    if (this.mode !== 'auto') {
      throw new VoximplantProtocolError(
        'invalid_message',
        'Voximplant transport mode cannot change during a call'
      );
    }

    const queued = this.pendingOutput;
    const shouldFinish = this.finishRequestedWhileAuto;
    this.pendingOutput = Buffer.alloc(0);
    this.finishRequestedWhileAuto = false;
    this.mode = mode;
    if (queued.length > 0) this.sendAudio(queued);
    if (shouldFinish) this.finishOutput();
  }

  private sendMediaFrame(audio: Buffer): void {
    const timestamp = Math.floor(this.outboundBytes / 8);
    this.outboundBytes += audio.length;
    this.sendJson({
      event: 'media',
      sequenceNumber: this.outboundSequence++,
      media: {
        chunk: ++this.outboundChunk,
        timestamp,
        payload: audio.toString('base64'),
      },
    });
  }

  private sendJson(message: Record<string, unknown>): void {
    this.sendFrame(JSON.stringify(message));
  }

  private acceptSequence(sequenceNumber: number): void {
    if (sequenceNumber <= this.lastInboundSequence) {
      throw new VoximplantProtocolError(
        'invalid_sequence',
        'Voximplant sequence numbers must increase monotonically'
      );
    }
    this.lastInboundSequence = sequenceNumber;
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function requireSequence(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new VoximplantProtocolError(
      'invalid_sequence',
      'Voximplant sequenceNumber must be a non-negative integer'
    );
  }
  return value as number;
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new VoximplantProtocolError(
      'invalid_message',
      `Voximplant ${label} must be an object`
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return false;
  if (value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value
  );
}
