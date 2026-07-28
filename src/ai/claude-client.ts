import pool from '../db';
import { logger } from '../utils/logger';
import { chatCompletion } from './chat-provider';
import type { ChatMessage } from './openrouter';
import { executeTool, type ToolContext } from './tools';

export interface AgentResponse { text: string; toolsUsed: string[]; tokensInput: number; tokensOutput: number; latencyMs: number; }

export async function getAgentResponse(
  systemPrompt: string,
  userMessage: string,
  context: ToolContext,
  options: {
    model: string;
    temperature: number;
    maxTokens: number;
    systemContext?: string;
  }
): Promise<AgentResponse> {
  const started = Date.now();
  const history = await pool.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM messages
     WHERE conversation_id = $1 AND role IN ('user','assistant') AND content IS NOT NULL
     ORDER BY created_at DESC, id DESC LIMIT 21`,
    [context.conversationId]
  );
  const historyRows = [...history.rows];
  if (historyRows[0]?.role === 'user' && historyRows[0].content === userMessage) {
    historyRows.shift();
  }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: options.systemContext
        ? `${systemPrompt}\n\nКОНТЕКСТ ТЕКУЩЕЙ РЕПЛИКИ:\n${options.systemContext}`
        : systemPrompt,
    },
    ...historyRows.slice(0, 20).reverse().map(row => ({ role: row.role, content: row.content })),
    { role: 'user', content: userMessage },
  ];
  const toolsUsed: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let loop = 0; loop < 4; loop++) {
    const result = await chatCompletion(options.model, messages, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      tools: true,
    });
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    if (result.toolCalls.length === 0) {
      return { text: result.text, toolsUsed, tokensInput: inputTokens, tokensOutput: outputTokens, latencyMs: Date.now() - started };
    }
    messages.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: result.toolCalls.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    });
    for (const call of result.toolCalls) {
      toolsUsed.push(call.name);
      let output: string;
      try { output = await executeTool(call.name, call.arguments, context); }
      catch (error) { output = `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
      messages.push({ role: 'tool', content: output, tool_call_id: call.id });
    }
  }
  logger.warn('AI tool loop limit reached', { conversationId: context.conversationId });
  return { text: 'Извините, не удалось завершить запрос. Попробуйте ещё раз.', toolsUsed, tokensInput: inputTokens, tokensOutput: outputTokens, latencyMs: Date.now() - started };
}
