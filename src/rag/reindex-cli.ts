import { Pool } from 'pg';
import { config } from '../config';
import { generateEmbeddingsBatch } from './embeddings';
import { reindexKnowledgeEmbeddings } from './reindex';

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  try {
    const result = await reindexKnowledgeEmbeddings({
      pool,
      model: config.GEMINI_EMBED_MODEL,
      generateDocuments: generateEmbeddingsBatch,
    });
    process.stdout.write(
      `Embedding reindex complete: chunks=${result.chunksUpdated} batches=${result.batchesCompleted}\n`
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main().catch(() => {
  process.stderr.write('Embedding reindex failed\n');
  process.exitCode = 1;
});
