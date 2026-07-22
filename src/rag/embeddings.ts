import {
  GoogleGenAI,
  type EmbedContentParameters,
  type EmbedContentResponse,
} from '@google/genai';
import { config } from '../config';
import { logger } from '../utils/logger';

export const EMBEDDING_OUTPUT_DIMENSIONALITY = 768;
export const DOCUMENT_EMBEDDING_TASK = 'RETRIEVAL_DOCUMENT';
export const QUERY_EMBEDDING_TASK = 'RETRIEVAL_QUERY';

export interface EmbeddingModelsClient {
  embedContent(
    parameters: EmbedContentParameters
  ): Promise<EmbedContentResponse>;
}

export interface EmbeddingClient {
  models: EmbeddingModelsClient;
}

interface EmbeddingGeneratorOptions {
  client: EmbeddingClient;
  model: string;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface EmbeddingGenerator {
  generateDocument(text: string): Promise<number[]>;
  generateQuery(query: string): Promise<number[]>;
  generateDocumentsBatch(
    texts: string[],
    batchSize?: number,
    delayMs?: number
  ): Promise<number[][]>;
}

type RetrievalTask =
  | typeof DOCUMENT_EMBEDDING_TASK
  | typeof QUERY_EMBEDDING_TASK;

function validateTexts(texts: readonly string[]): void {
  if (texts.some(text => text.trim().length === 0)) {
    throw new Error('Embedding input must not be empty');
  }
}

function extractEmbeddings(
  response: EmbedContentResponse,
  expectedCount: number
): number[][] {
  const embeddings = response.embeddings;
  if (!embeddings || embeddings.length !== expectedCount) {
    throw new Error(
      `Google embeddings returned ${embeddings?.length ?? 0} vectors; expected ${expectedCount}`
    );
  }

  return embeddings.map((embedding, index) => {
    const values = embedding.values;
    if (!values || values.length !== EMBEDDING_OUTPUT_DIMENSIONALITY) {
      throw new Error(
        `Google embedding ${index} has ${values?.length ?? 0} dimensions; expected ${EMBEDDING_OUTPUT_DIMENSIONALITY}`
      );
    }
    return values;
  });
}

export function createEmbeddingGenerator(
  options: EmbeddingGeneratorOptions
): EmbeddingGenerator {
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise(resolve => setTimeout(resolve, milliseconds)));

  async function embed(
    texts: readonly string[],
    taskType: RetrievalTask
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    validateTexts(texts);

    const response = await options.client.models.embedContent({
      model: options.model,
      // Gemini Embedding 2 aggregates a string[] into one embedding. Explicit
      // Content objects request one independent vector per knowledge chunk.
      contents: texts.map(text => ({ parts: [{ text }] })),
      config: {
        taskType,
        outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONALITY,
      },
    });

    return extractEmbeddings(response, texts.length);
  }

  return {
    async generateDocument(text: string): Promise<number[]> {
      return (await embed([text], DOCUMENT_EMBEDDING_TASK))[0]!;
    },

    async generateQuery(query: string): Promise<number[]> {
      return (await embed([query], QUERY_EMBEDDING_TASK))[0]!;
    },

    async generateDocumentsBatch(
      texts: string[],
      batchSize = 5,
      delayMs = 200
    ): Promise<number[][]> {
      if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error('Embedding batch size must be a positive integer');
      }
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error('Embedding batch delay must be non-negative');
      }

      const results: number[][] = [];
      for (let index = 0; index < texts.length; index += batchSize) {
        const batch = texts.slice(index, index + batchSize);
        results.push(...(await embed(batch, DOCUMENT_EMBEDDING_TASK)));

        if (index + batchSize < texts.length) {
          await delay(delayMs);
        }
        logger.debug(
          `Embeddings: ${Math.min(index + batchSize, texts.length)}/${texts.length}`
        );
      }
      return results;
    },
  };
}

let defaultGenerator: EmbeddingGenerator | undefined;

function getDefaultGenerator(): EmbeddingGenerator {
  defaultGenerator ??= createEmbeddingGenerator({
    client: new GoogleGenAI({ apiKey: config.GOOGLE_API_KEY }),
    model: config.GEMINI_EMBED_MODEL,
  });
  return defaultGenerator;
}

/** Generate a 768-dimensional document embedding for ingestion. */
export async function generateEmbedding(text: string): Promise<number[]> {
  return getDefaultGenerator().generateDocument(text);
}

/** Generate a 768-dimensional query embedding for semantic search. */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  return getDefaultGenerator().generateQuery(query);
}

/** Generate document embeddings in rate-limit-friendly batches. */
export async function generateEmbeddingsBatch(
  texts: string[],
  batchSize = 5,
  delayMs = 200
): Promise<number[][]> {
  return getDefaultGenerator().generateDocumentsBatch(
    texts,
    batchSize,
    delayMs
  );
}
