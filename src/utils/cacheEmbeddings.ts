import { getRedisConnection } from './redis';
import {
  DOCUMENT_EMBEDDING_TASK,
  EMBEDDING_OUTPUT_DIMENSIONALITY,
  QUERY_EMBEDDING_TASK,
  generateEmbedding,
  generateQueryEmbedding,
} from '../rag/embeddings';
import { config } from '../config';
import * as crypto from 'crypto';

const EMBEDDING_CACHE_TTL = 86400;

function hashText(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

type EmbeddingCacheTask =
  | typeof DOCUMENT_EMBEDDING_TASK
  | typeof QUERY_EMBEDDING_TASK;

function cacheKey(text: string, task: EmbeddingCacheTask): string {
  return [
    'embedding',
    config.GEMINI_EMBED_MODEL,
    EMBEDDING_OUTPUT_DIMENSIONALITY,
    task,
    hashText(text),
  ].join(':');
}

async function getCachedEmbeddingForTask(
  text: string,
  task: EmbeddingCacheTask
): Promise<number[]> {
  const redis = getRedisConnection();
  const key = cacheKey(text, task);
  const cached = await redis.get(key);

  if (cached) {
    return JSON.parse(cached) as number[];
  }

  const embedding =
    task === QUERY_EMBEDDING_TASK
      ? await generateQueryEmbedding(text)
      : await generateEmbedding(text);
  await redis.setex(key, EMBEDDING_CACHE_TTL, JSON.stringify(embedding));

  return embedding;
}

export async function getCachedEmbedding(text: string): Promise<number[]> {
  return getCachedEmbeddingForTask(text, DOCUMENT_EMBEDDING_TASK);
}

export async function getCachedQueryEmbedding(
  text: string
): Promise<number[]> {
  return getCachedEmbeddingForTask(text, QUERY_EMBEDDING_TASK);
}

export async function clearEmbeddingCache(text: string) {
  const redis = getRedisConnection();
  await redis.del(
    cacheKey(text, DOCUMENT_EMBEDDING_TASK),
    cacheKey(text, QUERY_EMBEDDING_TASK)
  );
}

export async function clearAllEmbeddingCache() {
  const redis = getRedisConnection();
  const keys = await redis.keys('embedding:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export async function getEmbeddingCacheStats() {
  const redis = getRedisConnection();
  const keys = await redis.keys('embedding:*');
  return {
    cachedEmbeddings: keys.length,
    estimatedMemory: `${(keys.length * 3 / 1024).toFixed(2)} MB`
  };
}
