import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AGENT_TOOLS, type ToolContext } from './tools';
import { searchKnowledge } from '../rag/search';
import { updateLeadStage } from '../crm/adapter';
import { sendWhatsAppMessage } from '../channels/whatsapp';
import pool from '../db';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
}

/**
 * Главный метод — получить ответ Claude с tool use loop.
 * Загружает последние 20 сообщений как историю разговора.
 */
export async function getAgentResponse(
  systemPrompt: string,
  userMessage: string,
  context: ToolContext
): Promise<AgentResponse> {
  const startTime = Date.now();

  // Загружаем историю разговора (последние 20 сообщений)
  const history = await loadConversationHistory(context.conversationId, 20);

  // Формируем messages array
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const toolsUsed: string[] = [];
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;
  let finalText = '';

  // Tool use loop: продолжаем пока stop_reason = 'tool_use'
  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      tools: AGENT_TOOLS,
      messages,
    });

    totalInputTokens  += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'end_turn') {
      // Собираем финальный текст
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // Добавляем ответ ассистента с tool_use blocks в историю
      messages.push({ role: 'assistant', content: response.content });

      // Выполняем все инструменты
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        toolsUsed.push(block.name);
        logger.debug('Tool call', { tool: block.name, input: block.input, ...context });

        let result: unknown;
        try {
          result = await executeTool(block.name, block.input as Record<string, unknown>, context);
        } catch (err) {
          result = { error: String(err) };
          logger.error('Tool execution failed', { tool: block.name, error: err });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      // Добавляем результаты инструментов и продолжаем цикл
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Неожиданный stop_reason — прерываем
    logger.warn('Unexpected stop_reason', { stop_reason: response.stop_reason });
    break;
  }

  const latencyMs = Date.now() - startTime;

  return {
    text: finalText,
    toolsUsed,
    tokensInput:  totalInputTokens,
    tokensOutput: totalOutputTokens,
    latencyMs,
  };
}

/**
 * Загружает последние N сообщений разговора из БД
 */
async function loadConversationHistory(
  conversationId: string,
  limit: number
): Promise<Anthropic.MessageParam[]> {
  const result = await pool.query(
    `SELECT role, content
     FROM messages
     WHERE conversation_id = $1
       AND role IN ('user','assistant')
       AND content IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit]
  );

  // Возвращаем в хронологическом порядке
  return result.rows
    .reverse()
    .map(row => ({ role: row.role as 'user' | 'assistant', content: row.content as string }));
}

/**
 * Исполнитель инструментов
 */
async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  switch (name) {
    case 'search_knowledge': {
      const query = input['query'] as string;
      const chunks = await searchKnowledge(ctx.orgId, query, 3);
      if (chunks.length === 0) {
        return { results: [], message: 'Информация не найдена в базе знаний' };
      }
      return {
        results: chunks.map(c => ({
          content:  c.content,
          category: c.category,
          source:   c.source_file,
          score:    Math.round(c.similarity * 100) / 100,
        })),
      };
    }

    case 'update_lead': {
      const stage = input['stage'] as string;
      const notes = input['notes'] as string | undefined;
      if (ctx.leadId) {
        await updateLeadStage(ctx.orgId, ctx.leadId, stage, notes);
      }
      return { success: true, stage, message: `Лид переведён на этап: ${stage}` };
    }

    case 'book_meeting': {
      const datetime = input['datetime'] as string;
      const type = input['type'] as string;
      // Сохраняем встречу в метаданных лида
      if (ctx.leadId) {
        await pool.query(
          `UPDATE leads
           SET metadata = metadata || $1::jsonb,
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify({ meeting: { datetime, type, bookedAt: new Date().toISOString() } }), ctx.leadId]
        );
      }
      return {
        success: true,
        datetime,
        type,
        message: `Встреча типа "${type}" запланирована на ${datetime}`,
      };
    }

    case 'send_whatsapp': {
      const text = input['text'] as string;
      if (ctx.phone) {
        await sendWhatsAppMessage(ctx.phone, text);
      }
      return { success: true, message: 'Сообщение отправлено в WhatsApp' };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
