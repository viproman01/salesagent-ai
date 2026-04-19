/**
 * Text chunker: splits documents into overlapping chunks
 * Chunk size: ~500 tokens (~2000 chars), overlap: ~50 tokens (~200 chars)
 */
import pdfParse from 'pdf-parse';

const CHUNK_SIZE   = 2000; // символов ≈ 500 токенов
const CHUNK_OVERLAP = 200; // символов ≈ 50 токенов

export interface TextChunk {
  content: string;
  index: number;
  tokenEstimate: number;
}

/**
 * Разбить текст на чанки с перекрытием
 */
export function chunkText(text: string): TextChunk[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  const chunks: TextChunk[] = [];
  let pos = 0;
  let index = 0;

  while (pos < normalized.length) {
    let end = pos + CHUNK_SIZE;

    // Стараемся разрезать по границе предложения или абзаца
    if (end < normalized.length) {
      // Ищем ближайший конец предложения до end
      const sentenceEnd = normalized.lastIndexOf('.', end);
      const paraEnd     = normalized.lastIndexOf('\n\n', end);
      const breakPoint  = Math.max(sentenceEnd, paraEnd);
      if (breakPoint > pos + CHUNK_SIZE / 2) {
        end = breakPoint + 1;
      }
    } else {
      end = normalized.length;
    }

    const content = normalized.slice(pos, end).trim();
    if (content.length > 50) { // пропускаем слишком короткие чанки
      chunks.push({
        content,
        index,
        tokenEstimate: Math.ceil(content.length / 4),
      });
      index++;
    }

    // Следующий чанк начинается с учётом overlap
    pos = Math.max(pos + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
}

/**
 * Извлечь текст из PDF-буфера
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text;
}

/**
 * Извлечь текст из CSV (простой парсер)
 */
export function extractCsvText(csv: string): string {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';

  const headers = lines[0]!.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    return headers.map((h, i) => `${h}: ${values[i] ?? ''}`).join(', ');
  });

  return rows.join('\n');
}
