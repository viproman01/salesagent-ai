import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import {
  DOCUMENT_EMBEDDING_TASK,
  EMBEDDING_OUTPUT_DIMENSIONALITY,
  QUERY_EMBEDDING_TASK,
  createEmbeddingGenerator,
  type EmbeddingClient,
} from '../../src/rag/embeddings';

function vector(seed: number): number[] {
  return Array.from(
    { length: EMBEDDING_OUTPUT_DIMENSIONALITY },
    (_, index) => seed + index / 10_000
  );
}

function createClient(
  calls: EmbedContentParameters[]
): EmbeddingClient {
  return {
    models: {
      async embedContent(
        parameters: EmbedContentParameters
      ): Promise<EmbedContentResponse> {
        calls.push(parameters);
        const count = Array.isArray(parameters.contents)
          ? parameters.contents.length
          : 1;
        return {
          embeddings: Array.from({ length: count }, (_, index) => ({
            values: vector(index + 1),
          })),
        };
      },
    },
  };
}

describe('Google embedding generator', () => {
  it('uses Gemini Embedding 2 with 768 document dimensions', async () => {
    const calls: EmbedContentParameters[] = [];
    const generator = createEmbeddingGenerator({
      client: createClient(calls),
      model: 'gemini-embedding-2',
    });

    const result = await generator.generateDocument('Каталог букетов');

    assert.equal(result.length, EMBEDDING_OUTPUT_DIMENSIONALITY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model, 'gemini-embedding-2');
    assert.deepEqual(calls[0]?.contents, [
      { parts: [{ text: 'Каталог букетов' }] },
    ]);
    assert.deepEqual(calls[0]?.config, {
      taskType: DOCUMENT_EMBEDDING_TASK,
      outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONALITY,
    });
  });

  it('uses RETRIEVAL_QUERY for semantic-search queries', async () => {
    const calls: EmbedContentParameters[] = [];
    const generator = createEmbeddingGenerator({
      client: createClient(calls),
      model: 'gemini-embedding-2',
    });

    await generator.generateQuery('Сколько стоит букет?');

    assert.deepEqual(calls[0]?.config, {
      taskType: QUERY_EMBEDDING_TASK,
      outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONALITY,
    });
  });

  it('batches ingestion as RETRIEVAL_DOCUMENT and preserves order', async () => {
    const calls: EmbedContentParameters[] = [];
    const delays: number[] = [];
    const generator = createEmbeddingGenerator({
      client: createClient(calls),
      model: 'gemini-embedding-2',
      delay: async milliseconds => {
        delays.push(milliseconds);
      },
    });

    const result = await generator.generateDocumentsBatch(
      ['first', 'second', 'third'],
      2,
      25
    );

    assert.equal(result.length, 3);
    assert.deepEqual(calls.map(call => call.contents), [
      [
        { parts: [{ text: 'first' }] },
        { parts: [{ text: 'second' }] },
      ],
      [{ parts: [{ text: 'third' }] }],
    ]);
    assert.deepEqual(
      calls.map(call => call.config?.taskType),
      [DOCUMENT_EMBEDDING_TASK, DOCUMENT_EMBEDDING_TASK]
    );
    assert.deepEqual(delays, [25]);
  });

  it('rejects a provider vector with the wrong dimensionality', async () => {
    const client: EmbeddingClient = {
      models: {
        async embedContent(): Promise<EmbedContentResponse> {
          return { embeddings: [{ values: [0.1, 0.2] }] };
        },
      },
    };
    const generator = createEmbeddingGenerator({
      client,
      model: 'gemini-embedding-2',
    });

    await assert.rejects(
      generator.generateQuery('query'),
      /has 2 dimensions; expected 768/u
    );
  });
});
