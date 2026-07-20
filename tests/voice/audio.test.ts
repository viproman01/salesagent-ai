import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pcm16ToUlaw,
  pcm16ToUlawAtSampleRate,
} from '../../src/utils/audio';

function pcm16(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer;
}

test('Fish 8 kHz PCM is μ-law encoded without accidental 4 kHz downsampling', () => {
  const input = pcm16([0, 1000, -1000, 2000, -2000, 3000, -3000, 0]);
  const output = pcm16ToUlawAtSampleRate(input, 8000);

  assert.equal(output.length, 8);
});

test('legacy Gemini converter remains equivalent to explicit 16 kHz conversion', () => {
  const input = pcm16([0, 0, 1000, 1000, -1000, -1000, 2000, 2000]);

  assert.deepEqual(
    pcm16ToUlaw(input),
    pcm16ToUlawAtSampleRate(input, 16000)
  );
  assert.equal(pcm16ToUlaw(input).length, 4);
});

test('PCM conversion rejects malformed samples and invalid sample rates', () => {
  assert.throws(
    () => pcm16ToUlawAtSampleRate(Buffer.from([1]), 8000),
    /complete 16-bit samples/
  );
  assert.throws(
    () => pcm16ToUlawAtSampleRate(Buffer.alloc(2), 7999),
    />= 8000/
  );
});
