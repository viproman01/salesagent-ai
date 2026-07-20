import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../utils/logger';

const genai = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
const embeddingModel = genai.getGenerativeModel({ model: config.GEMINI_EMBED_MODEL });

/**
 * Генерировать embedding вектор (768 измерений) для текста
 * Используется Google text-embedding-004
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const result = await embeddingModel.embedContent({
    content: { parts: [{ text }], role: 'user' },
    taskType: 'RETRIEVAL_DOCUMENT' as any,
  });
  return result.embedding.values;
}

/**
 * Генерировать embedding для поискового запроса
 * (другой taskType — RETRIEVAL_QUERY)
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const result = await embeddingModel.embedContent({
    content: { parts: [{ text: query }], role: 'user' },
    taskType: 'RETRIEVAL_QUERY' as any,
  });
  return result.embedding.values;
}

/**
 * Пакетная генерация embeddings (с задержкой для rate limit)
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  batchSize = 5,
  delayMs = 200
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(t => generateEmbedding(t)));
    results.push(...batchResults);
    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    logger.debug(`Embeddings: ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
  }
  return results;
}
