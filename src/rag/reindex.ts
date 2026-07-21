import type { Pool } from 'pg';
import { EMBEDDING_OUTPUT_DIMENSIONALITY } from './embeddings';

const REINDEX_LOCK_NAME = 'salesagent-ai:knowledge-embedding-reindex';
const DEFAULT_DATABASE_BATCH_SIZE = 25;
const DEFAULT_PROVIDER_BATCH_SIZE = 5;
const DEFAULT_PROVIDER_DELAY_MS = 200;

type GenerateDocuments = (
  texts: string[],
  batchSize?: number,
  delayMs?: number
) => Promise<number[][]>;

type PendingChunk = Readonly<{
  id: string;
  content: string;
}>;

export type ReindexKnowledgeEmbeddingsOptions = Readonly<{
  pool: Pick<Pool, 'connect'>;
  model: string;
  generateDocuments: GenerateDocuments;
  databaseBatchSize?: number;
  providerBatchSize?: number;
  providerDelayMs?: number;
}>;

export type ReindexKnowledgeEmbeddingsResult = Readonly<{
  chunksUpdated: number;
  batchesCompleted: number;
}>;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function embeddingLiteral(values: readonly number[]): string {
  if (
    values.length !== EMBEDDING_OUTPUT_DIMENSIONALITY ||
    values.some(value => !Number.isFinite(value))
  ) {
    throw new Error(
      `Embedding must contain ${EMBEDDING_OUTPUT_DIMENSIONALITY} finite values`
    );
  }
  return `[${values.join(',')}]`;
}

/**
 * Rebuild every missing or model-incompatible knowledge embedding.
 *
 * The advisory lock prevents two jobs from paying to embed the same content.
 * Updates are guarded by the model so a concurrent current-model ingestion is
 * never overwritten. Re-running the job after success performs no API calls.
 */
export async function reindexKnowledgeEmbeddings(
  options: ReindexKnowledgeEmbeddingsOptions
): Promise<ReindexKnowledgeEmbeddingsResult> {
  const model = options.model.trim();
  if (!model) throw new Error('Embedding model must not be empty');

  const databaseBatchSize = positiveInteger(
    options.databaseBatchSize ?? DEFAULT_DATABASE_BATCH_SIZE,
    'Database batch size'
  );
  const providerBatchSize = positiveInteger(
    options.providerBatchSize ?? DEFAULT_PROVIDER_BATCH_SIZE,
    'Provider batch size'
  );
  const providerDelayMs = options.providerDelayMs ?? DEFAULT_PROVIDER_DELAY_MS;
  if (!Number.isFinite(providerDelayMs) || providerDelayMs < 0) {
    throw new Error('Provider delay must be non-negative');
  }

  const client = await options.pool.connect();
  let lockAcquired = false;
  let operationFailure: unknown;
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [REINDEX_LOCK_NAME]
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new Error('Knowledge embedding reindex is already running');
    }

    let chunksUpdated = 0;
    let batchesCompleted = 0;

    while (true) {
      const pending = await client.query<PendingChunk>(
        `SELECT id, content
         FROM knowledge_chunks
         WHERE embedding IS NULL
            OR embedding_model IS DISTINCT FROM $1
         ORDER BY id
         LIMIT $2`,
        [model, databaseBatchSize]
      );
      if (pending.rows.length === 0) break;

      const embeddings = await options.generateDocuments(
        pending.rows.map(row => row.content),
        providerBatchSize,
        providerDelayMs
      );
      if (embeddings.length !== pending.rows.length) {
        throw new Error('Embedding provider returned an unexpected batch size');
      }

      await client.query('BEGIN');
      try {
        for (let index = 0; index < pending.rows.length; index += 1) {
          const row = pending.rows[index]!;
          const embedding = embeddingLiteral(embeddings[index]!);
          const update = await client.query(
            `UPDATE knowledge_chunks
             SET embedding = $2::vector,
                 embedding_model = $3
             WHERE id = $1
               AND (
                 embedding IS NULL
                 OR embedding_model IS DISTINCT FROM $3
               )`,
            [row.id, embedding, model]
          );
          chunksUpdated += update.rowCount ?? 0;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      batchesCompleted += 1;
    }

    return { chunksUpdated, batchesCompleted };
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
          REINDEX_LOCK_NAME,
        ]);
      }
    } catch (unlockError) {
      if (operationFailure === undefined) throw unlockError;
    } finally {
      client.release();
    }
  }
}
