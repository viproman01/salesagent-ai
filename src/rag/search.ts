import pool from '../db';
import { generateQueryEmbedding } from './embeddings';
import { logger } from '../utils/logger';

export interface KnowledgeChunk {
  id: string;
  content: string;
  category: string | null;
  source_file: string | null;
  similarity: number;
}

/**
 * Поиск по базе знаний через pgvector cosine similarity
 * @param orgId  — ID организации (изоляция данных)
 * @param query  — поисковый запрос
 * @param topK   — количество результатов (по умолчанию 3)
 * @param threshold — минимальный порог сходства (0..1)
 */
export async function searchKnowledge(
  orgId: string,
  query: string,
  topK = 3,
  threshold = 0.65
): Promise<KnowledgeChunk[]> {
  const embedding = await generateQueryEmbedding(query);
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await pool.query<KnowledgeChunk>(
    `SELECT * FROM match_knowledge($1::vector, $2, $3, $4)`,
    [embeddingStr, topK, orgId, threshold]
  );

  logger.debug('Knowledge search', {
    orgId, query, results: result.rows.length
  });

  return result.rows;
}

/**
 * Сохранить чанки с embeddings в БД
 */
export async function saveKnowledgeChunks(
  orgId: string,
  chunks: Array<{
    content: string;
    embedding: number[];
    category?: string;
    source_file?: string;
    chunk_index: number;
    token_count?: number;
  }>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const chunk of chunks) {
      const embeddingStr = `[${chunk.embedding.join(',')}]`;
      await client.query(
        `INSERT INTO knowledge_chunks
           (org_id, content, embedding, category, source_file, chunk_index, token_count)
         VALUES ($1, $2, $3::vector, $4, $5, $6, $7)`,
        [
          orgId, chunk.content, embeddingStr,
          chunk.category ?? null, chunk.source_file ?? null,
          chunk.chunk_index, chunk.token_count ?? null,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Удалить все чанки файла (при повторной загрузке)
 */
export async function deleteKnowledgeByFile(orgId: string, sourceFile: string): Promise<void> {
  await pool.query(
    'DELETE FROM knowledge_chunks WHERE org_id = $1 AND source_file = $2',
    [orgId, sourceFile]
  );
}
