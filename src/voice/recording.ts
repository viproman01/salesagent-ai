/**
 * Keeps the optional call recording strictly bounded while live audio
 * processing continues even after the recording limit is reached.
 */
export class BoundedCallRecording {
  private readonly chunks: Buffer[] = [];
  private _byteLength = 0;
  private _truncated = false;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Recording limit must be a positive safe integer');
    }
  }

  get byteLength(): number {
    return this._byteLength;
  }

  get truncated(): boolean {
    return this._truncated;
  }

  append(audio: Buffer): void {
    if (audio.length === 0) return;
    const remaining = this.maxBytes - this._byteLength;
    if (remaining <= 0) {
      this._truncated = true;
      return;
    }

    const accepted =
      audio.length <= remaining ? audio : audio.subarray(0, remaining);
    this.chunks.push(Buffer.from(accepted));
    this._byteLength += accepted.length;
    if (accepted.length !== audio.length) this._truncated = true;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this._byteLength);
  }
}
