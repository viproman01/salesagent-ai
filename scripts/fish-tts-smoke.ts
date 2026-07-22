import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import path from 'path';
import { createConfiguredFishTtsProvider } from '../src/voice/providers/configured';
import type { TtsSessionEvent } from '../src/voice/providers/tts';

const outputPath = path.resolve(
  process.env.FISH_TTS_SMOKE_OUTPUT ?? '/tmp/fish-tts-smoke.wav'
);
const text =
  process.env.FISH_TTS_SMOKE_TEXT ??
  'Здравствуйте! Это короткая проверка потокового голоса Fish Audio.';

async function main(): Promise<void> {
  const provider = createConfiguredFishTtsProvider();
  const abortController = new AbortController();
  const audioChunks: Buffer[] = [];
  const turn = Object.freeze({
    callId: `smoke-${randomUUID()}`,
    conversationId: `smoke-${randomUUID()}`,
    turnId: randomUUID(),
    generation: 1,
  });

  const abort = () => abortController.abort('SIGINT');
  process.once('SIGINT', abort);

  try {
    const session = await provider.open({
      turn,
      signal: abortController.signal,
      onEvent: (event: TtsSessionEvent) => {
        if (event.type === 'audio') audioChunks.push(event.data);
        if (event.type === 'session_started') {
          console.log(`Fish TTS connected in ${event.connectMs} ms`);
        }
        if (event.type === 'audio' && event.firstAudioMs !== undefined) {
          console.log(`First audio received in ${event.firstAudioMs} ms`);
        }
      },
    });

    await session.write({
      kind: 'committed',
      turn,
      sequence: 0,
      text,
    });
    await session.flush();
    const terminal = await session.finish();
    if (terminal.status !== 'completed') {
      throw new Error(`Fish TTS smoke test ended with status ${terminal.status}`);
    }

    const pcm = Buffer.concat(audioChunks);
    await writeFile(
      outputPath,
      pcm16MonoToWav(pcm, provider.outputFormat.sampleRateHz)
    );
    console.log(
      `Saved ${terminal.audioBytes} PCM bytes in ${terminal.audioChunks} chunks to ${outputPath}`
    );
  } finally {
    process.removeListener('SIGINT', abort);
  }
}

function pcm16MonoToWav(pcm: Buffer, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRateHz * 2;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Fish TTS smoke test failed: ${message}`);
  process.exitCode = 1;
});
