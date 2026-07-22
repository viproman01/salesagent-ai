import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { EMBEDDING_OUTPUT_DIMENSIONALITY } from '../../src/rag/embeddings';
import { reindexKnowledgeEmbeddings } from '../../src/rag/reindex';

type StoredChunk = {
  id: string;
  content: string;
  embedding: string | null;
  embeddingModel: string | null;
};

class FakeClient {
  readonly queries: Array<{
    text: string;
    values: readonly unknown[];
  }> = [];
  releaseCalls = 0;

  constructor(
    readonly chunks: StoredChunk[],
    private readonly lockAvailable = true
  ) {}

  async query(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: any[]; rowCount: number | null }> {
    this.queries.push({ text, values });
    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ acquired: this.lockAvailable }], rowCount: 1 };
    }
    if (text.includes('SELECT id, content')) {
      const model = String(values[0]);
      const limit = Number(values[1]);
      const rows = this.chunks
        .filter(
          chunk =>
            chunk.embedding === null || chunk.embeddingModel !== model
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(({ id, content }) => ({ id, content }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('UPDATE knowledge_chunks')) {
      const id = String(values[0]);
      const embedding = String(values[1]);
      const model = String(values[2]);
      const chunk = this.chunks.find(candidate => candidate.id === id);
      if (
        !chunk ||
        (chunk.embedding !== null && chunk.embeddingModel === model)
      ) {
        return { rows: [], rowCount: 0 };
      }
      chunk.embedding = embedding;
      chunk.embeddingModel = model;
      return { rows: [], rowCount: 1 };
    }
    if (
      text === 'BEGIN' ||
      text === 'COMMIT' ||
      text === 'ROLLBACK' ||
      text.includes('pg_advisory_unlock')
    ) {
      return { rows: [], rowCount: null };
    }
    throw new Error('Unexpected fake database query');
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

function fakePool(client: FakeClient): Pick<Pool, 'connect'> {
  return {
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>;
}

function vector(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_OUTPUT_DIMENSIONALITY },
    (_, index) => seed + index / 10_000
  );
}

describe('knowledge embedding reindex', () => {
  it('rebuilds only missing/incompatible chunks and is idempotent', async () => {
    const model = 'gemini-embedding-2';
    const client = new FakeClient([
      {
        id: 'a',
        content: 'first private chunk',
        embedding: '[0.1]',
        embeddingModel: 'text-embedding-004',
      },
      {
        id: 'b',
        content: 'second private chunk',
        embedding: null,
        embeddingModel: null,
      },
      {
        id: 'c',
        content: 'already current',
        embedding: '[0.3]',
        embeddingModel: model,
      },
    ]);
    const generated: string[][] = [];
    const generateDocuments = async (
      texts: string[],
      batchSize?: number,
      delayMs?: number
    ): Promise<number[][]> => {
      generated.push(texts);
      assert.equal(batchSize, 2);
      assert.equal(delayMs, 0);
      return texts.map((_, index) => vector(index + 1));
    };

    const first = await reindexKnowledgeEmbeddings({
      pool: fakePool(client),
      model,
      generateDocuments,
      databaseBatchSize: 1,
      providerBatchSize: 2,
      providerDelayMs: 0,
    });

    assert.deepEqual(first, { chunksUpdated: 2, batchesCompleted: 2 });
    assert.deepEqual(generated, [
      ['first private chunk'],
      ['second private chunk'],
    ]);
    assert.deepEqual(
      client.chunks.map(chunk => chunk.embeddingModel),
      [model, model, model]
    );

    const callsBeforeRetry = generated.length;
    const second = await reindexKnowledgeEmbeddings({
      pool: fakePool(client),
      model,
      generateDocuments,
      databaseBatchSize: 1,
      providerBatchSize: 2,
      providerDelayMs: 0,
    });

    assert.deepEqual(second, { chunksUpdated: 0, batchesCompleted: 0 });
    assert.equal(generated.length, callsBeforeRetry);
    assert.equal(client.releaseCalls, 2);
  });

  it('refuses concurrent jobs before sending content to the provider', async () => {
    const client = new FakeClient([], false);
    let providerCalls = 0;

    await assert.rejects(
      reindexKnowledgeEmbeddings({
        pool: fakePool(client),
        model: 'gemini-embedding-2',
        generateDocuments: async () => {
          providerCalls += 1;
          return [];
        },
      }),
      /already running/u
    );

    assert.equal(providerCalls, 0);
    assert.equal(client.releaseCalls, 1);
  });
});
