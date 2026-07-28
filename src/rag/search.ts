import { randomUUID } from 'crypto';
import pool from '../db';
import { logger } from '../utils/logger';
import { generateQueryEmbedding } from './embeddings';
import { config } from '../config';

export interface KnowledgeChunk { id: string; content: string; category: string | null; source_file: string | null; similarity: number; }

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

export async function searchKnowledge(orgId: string, query: string, topK = 3, threshold = 0.65): Promise<KnowledgeChunk[]> {
  const queryEmbedding = await generateQueryEmbedding(query);
  const result = await pool.query<{ id: string; content: string; category: string | null; source_file: string | null; embedding: number[] | string | null }>(
    `SELECT id, content, category, source_file, embedding
     FROM knowledge_chunks
     WHERE org_id = $1 AND embedding IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [orgId, config.RAG_MAX_CANDIDATES]
  );
  const matches = result.rows.flatMap(row => {
    const embedding = typeof row.embedding === 'string' ? JSON.parse(row.embedding) as number[] : row.embedding;
    if (!Array.isArray(embedding)) return [];
    const similarity = cosine(queryEmbedding, embedding);
    return similarity >= threshold ? [{ id: row.id, content: row.content, category: row.category, source_file: row.source_file, similarity }] : [];
  }).sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  logger.debug('Knowledge search', { orgId, results: matches.length });
  return matches;
}

export async function saveKnowledgeChunks(orgId: string, chunks: Array<{ content: string; embedding: number[]; category?: string; source_file?: string; chunk_index: number; token_count?: number }>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.beginTransaction();
    for (const chunk of chunks) await client.query(
      `INSERT INTO knowledge_chunks (id, org_id, content, embedding, category, source_file, chunk_index, token_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), orgId, chunk.content, JSON.stringify(chunk.embedding), chunk.category ?? null, chunk.source_file ?? null, chunk.chunk_index, chunk.token_count ?? null]
    );
    await client.commit();
  } catch (error) { await client.rollback(); throw error; }
  finally { client.release(); }
}

export async function replaceKnowledgeChunks(
  orgId: string,
  sourceFile: string,
  chunks: Array<{ content: string; embedding: number[]; category?: string; chunk_index: number; token_count?: number }>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.beginTransaction();
    await client.query(
      'DELETE FROM knowledge_chunks WHERE org_id = $1 AND source_file = $2',
      [orgId, sourceFile]
    );
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO knowledge_chunks (id, org_id, content, embedding, category, source_file, chunk_index, token_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(), orgId, chunk.content, JSON.stringify(chunk.embedding),
          chunk.category ?? null, sourceFile, chunk.chunk_index, chunk.token_count ?? null,
        ]
      );
    }
    await client.commit();
  } catch (error) {
    await client.rollback();
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteKnowledgeByFile(orgId: string, sourceFile: string): Promise<void> {
  await pool.query('DELETE FROM knowledge_chunks WHERE org_id = $1 AND source_file = $2', [orgId, sourceFile]);
}
