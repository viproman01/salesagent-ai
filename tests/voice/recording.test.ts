import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedCallRecording } from '../../src/voice/recording';

test('keeps recording memory bounded without affecting later appends', () => {
  const recording = new BoundedCallRecording(5);
  recording.append(Buffer.from([1, 2, 3]));
  recording.append(Buffer.from([4, 5, 6, 7]));
  recording.append(Buffer.from([8]));

  assert.equal(recording.byteLength, 5);
  assert.equal(recording.truncated, true);
  assert.deepEqual(recording.toBuffer(), Buffer.from([1, 2, 3, 4, 5]));
});
