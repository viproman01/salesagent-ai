import { getRedisConnection } from './redis';
import { generateEmbedding } from '../rag/embeddings';
import * as crypto from 'crypto';

const EMBEDDING_CACHE_TTL = 86400;

function hashText(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

export async function getCachedEmbedding(text: string) {
  const redis = getRedisConnection();
  const cacheKey = `embedding:${hashText(text)}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  const embedding = await generateEmbedding(text);
  await redis.setex(cacheKey, EMBEDDING_CACHE_TTL, JSON.stringify(embedding));

  return embedding;
}

export async function clearEmbeddingCache(text: string) {
  const redis = getRedisConnection();
  const cacheKey = `embedding:${hashText(text)}`;
  await redis.del(cacheKey);
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
