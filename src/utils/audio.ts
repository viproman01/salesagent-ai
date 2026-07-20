/**
 * Audio conversion utilities: μ-law ↔ PCM16
 * Voximplant sends μ-law 8kHz, Gemini Live expects PCM16 16kHz
 */

// μ-law таблица декодирования (256 значений)
const ULAW_DECODE_TABLE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xff;
    const sign   = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    ULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
})();

/**
 * Convert μ-law 8kHz buffer to PCM16 16kHz buffer
 * Simple linear interpolation for upsampling 8kHz → 16kHz
 */
export function ulawToPcm16(ulawBuffer: Buffer): Buffer {
  const inputSamples = ulawBuffer.length;
  // 8kHz → 16kHz: каждый отсчёт дублируется (простой вариант)
  const outputSamples = inputSamples * 2;
  const output = Buffer.allocUnsafe(outputSamples * 2); // Int16 = 2 bytes

  for (let i = 0; i < inputSamples; i++) {
    const sample = ULAW_DECODE_TABLE[ulawBuffer[i]!];
    const offset = i * 4;
    // Дублируем каждый отсчёт для апсэмплинга 8→16 кГц
    output.writeInt16LE(sample!, offset);
    output.writeInt16LE(sample!, offset + 2);
  }
  return output;
}

/**
 * Convert PCM16 16kHz to μ-law 8kHz
 * Downsample by taking every 2nd sample
 */
export function pcm16ToUlaw(pcm16Buffer: Buffer): Buffer {
  return pcm16ToUlawAtSampleRate(pcm16Buffer, 16000);
}

/**
 * Convert mono PCM16 at the supplied sample rate to μ-law 8 kHz.
 * Fish Audio can already emit 8 kHz PCM, in which case no downsampling occurs.
 */
export function pcm16ToUlawAtSampleRate(
  pcm16Buffer: Buffer,
  sampleRateHz: number
): Buffer {
  if (pcm16Buffer.length % 2 !== 0) {
    throw new Error('PCM16 buffer must contain complete 16-bit samples');
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8000) {
    throw new Error('PCM16 input sample rate must be an integer >= 8000 Hz');
  }

  const inputSamples = pcm16Buffer.length / 2;
  const outputSamples = Math.floor((inputSamples * 8000) / sampleRateHz);
  const output = Buffer.allocUnsafe(outputSamples);

  for (let i = 0; i < outputSamples; i++) {
    const inputIndex = Math.min(
      inputSamples - 1,
      Math.floor((i * sampleRateHz) / 8000)
    );
    const sample = pcm16Buffer.readInt16LE(inputIndex * 2);
    output[i] = linearToUlaw(sample);
  }
  return output;
}

function linearToUlaw(sample: number): number {
  const BIAS = 0x84;
  const MAX  = 32767;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}

/**
 * Convert PCM16 buffer to base64 string for Gemini Live API
 */
export function pcm16ToBase64(pcm16Buffer: Buffer): string {
  return pcm16Buffer.toString('base64');
}

/**
 * Convert base64 PCM16 from Gemini to Buffer
 */
export function base64ToPcm16(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}
