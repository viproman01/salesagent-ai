import { config } from '../config';

interface EmbeddingResponse { data?: Array<{ embedding?: number[] }>; error?: { message?: string }; }

export async function generateEmbedding(text: string, inputType: 'search_document' | 'search_query' = 'search_document'): Promise<number[]> {
  if (!config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, model: config.OPENROUTER_EMBEDDING_MODEL, input_type: inputType }),
  });
  const payload = await response.json() as EmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!response.ok || !embedding) throw new Error(`OpenRouter embeddings: ${payload.error?.message ?? response.statusText}`);
  return embedding;
}

export async function generateQueryEmbedding(query: string): Promise<number[]> { return generateEmbedding(query, 'search_query'); }

export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  if (!config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const batches: number[][] = [];
  for (let index = 0; index < texts.length; index += 16) {
    const input = texts.slice(index, index + 16);
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, model: config.OPENROUTER_EMBEDDING_MODEL, input_type: 'search_document' }),
    });
    const payload = await response.json() as EmbeddingResponse;
    if (!response.ok || !payload.data?.every(item => Array.isArray(item.embedding))) throw new Error(`OpenRouter embeddings: ${payload.error?.message ?? response.statusText}`);
    batches.push(...payload.data.map(item => item.embedding!));
  }
  return batches;
}
