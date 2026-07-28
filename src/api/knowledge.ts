import { Router } from 'express';
import multer from 'multer';
import { requireAuth, type JwtPayload } from './auth';
import { logger } from '../utils/logger';
import { chunkText, extractPdfText, extractCsvText } from '../rag/chunker';
import { generateEmbeddingsBatch } from '../rag/embeddings';
import { replaceKnowledgeChunks, deleteKnowledgeByFile, searchKnowledge } from '../rag/search';
import pool from '../db';

export const knowledgeRouter = Router();

// Хранилище файлов в памяти (до 50MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/csv', 'text/plain', 'text/markdown'];
    cb(null, allowed.includes(file.mimetype) || file.originalname.endsWith('.md'));
  },
});

// POST /api/v1/knowledge/upload
knowledgeRouter.post('/upload', requireAuth, upload.single('file'), async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;

  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const { originalname, mimetype, buffer } = req.file;
  const category = (req.body['category'] as string | undefined) ?? 'general';

  logger.info('Knowledge upload started', {
    orgId:    user.orgId,
    filename: originalname,
    size:     buffer.length,
  });

  // Извлекаем текст
  let text: string;
  if (mimetype === 'application/pdf') {
    text = await extractPdfText(buffer);
  } else if (mimetype === 'text/csv') {
    text = extractCsvText(buffer.toString('utf-8'));
  } else {
    text = buffer.toString('utf-8');
  }

  if (!text.trim()) {
    res.status(422).json({ error: 'Could not extract text from file' });
    return;
  }

  // Чанкуем текст
  const chunks = chunkText(text);
  logger.info('Text chunked', { orgId: user.orgId, chunks: chunks.length });

  // Генерируем embeddings пакетами
  const embeddings = await generateEmbeddingsBatch(chunks.map(c => c.content));

  // Атомарно заменяем старую версию только после успешных embeddings.
  await replaceKnowledgeChunks(
    user.orgId,
    originalname,
    chunks.map((chunk, i) => ({
      content:     chunk.content,
      embedding:   embeddings[i]!,
      category,
      chunk_index: chunk.index,
      token_count: chunk.tokenEstimate,
    }))
  );

  logger.info('Knowledge uploaded', { orgId: user.orgId, filename: originalname, chunks: chunks.length });

  res.json({
    filename: originalname,
    chunks:   chunks.length,
    category,
    message:  `Загружено ${chunks.length} фрагментов из файла "${originalname}"`,
  });
});

// GET /api/v1/knowledge/search?q=query
knowledgeRouter.get('/search', requireAuth, async (req, res): Promise<void> => {
  const user  = (req as typeof req & { user: JwtPayload }).user;
  const rawQ = req.query['q'];
  const query = Array.isArray(rawQ) ? String(rawQ[0] ?? '') : String(rawQ ?? '');

  if (!query.trim()) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  const results = await searchKnowledge(user.orgId, query, 5);
  res.json({ results, query });
});

// GET /api/v1/knowledge — список загруженных файлов
knowledgeRouter.get('/', requireAuth, async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;

  const result = await pool.query(
    `SELECT
       source_file,
       category,
       COUNT(*) AS chunk_count,
       SUM(token_count) AS total_tokens,
       MAX(created_at) AS uploaded_at
     FROM knowledge_chunks
     WHERE org_id = $1
     GROUP BY source_file, category
     ORDER BY MAX(created_at) DESC`,
    [user.orgId]
  );

  res.json({ files: result.rows });
});

// DELETE /api/v1/knowledge/:filename
knowledgeRouter.delete('/:filename', requireAuth, async (req, res): Promise<void> => {
  const user     = (req as typeof req & { user: JwtPayload }).user;
  const filename = decodeURIComponent(String(req.params['filename'] ?? ''));

  await deleteKnowledgeByFile(user.orgId, filename);
  res.json({ message: `Файл "${filename}" удалён из базы знаний` });
});
