import WebSocket from 'ws';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ulawToPcm16, pcm16ToUlaw, pcm16ToBase64, base64ToPcm16 } from '../utils/audio';
import { GEMINI_TOOL_DECLARATIONS, type ToolContext } from './tools';
import { searchKnowledge } from '../rag/search';
import { updateLeadStage } from '../crm/adapter';
import pool from '../db';

type BridgeEvent =
  | { type: 'audio'; data: Buffer }
  | { type: 'transcript'; text: string; isFinal: boolean }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'error'; error: string }
  | { type: 'close' };

export type BridgeEventHandler = (event: BridgeEvent) => void;

/**
 * GeminiLiveVoiceBridge — WebSocket-мост между Voximplant и Gemini Live API.
 * Принимает аудио в формате μ-law 8kHz от Voximplant,
 * конвертирует в PCM16 16kHz для Gemini и наоборот.
 */
export class GeminiLiveVoiceBridge {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private audioQueue: Buffer[] = [];
  private onEvent: BridgeEventHandler;
  private context: ToolContext;
  private systemPrompt: string;

  constructor(systemPrompt: string, context: ToolContext, onEvent: BridgeEventHandler) {
    this.systemPrompt = systemPrompt;
    this.context      = context;
    this.onEvent      = onEvent;
  }

  /**
   * Подключиться к Gemini Live WebSocket API
   */
  async connect(): Promise<void> {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.GOOGLE_API_KEY}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info('Gemini Live: WebSocket connected', this.context);
        this.sendSetupMessage();
        this.isConnected = true;
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleServerMessage(data.toString());
      });

      this.ws.on('error', (err: Error) => {
        logger.error('Gemini Live: WebSocket error', { error: err.message, ...this.context });
        this.onEvent({ type: 'error', error: err.message });
        reject(err);
      });

      this.ws.on('close', () => {
        logger.info('Gemini Live: WebSocket closed', this.context);
        this.isConnected = false;
        this.onEvent({ type: 'close' });
      });
    });
  }

  /**
   * Отправить setup-сообщение с настройками модели
   */
  private sendSetupMessage(): void {
    const setupMsg = {
      setup: {
        model: `models/${config.GEMINI_LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO', 'TEXT'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Aoede' },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: this.systemPrompt }],
        },
        tools: [GEMINI_TOOL_DECLARATIONS],
      },
    };
    this.ws?.send(JSON.stringify(setupMsg));
  }

  /**
   * Принять аудио от Voximplant (μ-law 8kHz) и переслать в Gemini (PCM16 16kHz)
   */
  sendAudio(ulawChunk: Buffer): void {
    if (!this.isConnected || !this.ws) {
      this.audioQueue.push(ulawChunk);
      return;
    }

    const pcm16 = ulawToPcm16(ulawChunk);
    const base64 = pcm16ToBase64(pcm16);

    const realtimeInput = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: base64,
        }],
      },
    };
    this.ws.send(JSON.stringify(realtimeInput));
  }

  /**
   * Обработать входящее сообщение от Gemini Live
   */
  private handleServerMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      logger.warn('Gemini Live: invalid JSON message');
      return;
    }

    // Аудио-ответ
    const serverContent = msg['serverContent'] as Record<string, unknown> | undefined;
    if (serverContent) {
      const modelTurn = serverContent['modelTurn'] as Record<string, unknown> | undefined;
      if (modelTurn?.['parts']) {
        const parts = modelTurn['parts'] as Array<Record<string, unknown>>;
        for (const part of parts) {
          // Аудио
          if (part['inlineData']) {
            const inlineData = part['inlineData'] as Record<string, unknown>;
            const pcm16 = base64ToPcm16(inlineData['data'] as string);
            const ulaw  = pcm16ToUlaw(pcm16);
            this.onEvent({ type: 'audio', data: ulaw });
          }
          // Текстовый транскрипт
          if (part['text']) {
            this.onEvent({
              type: 'transcript',
              text: part['text'] as string,
              isFinal: !!(serverContent['turnComplete'] as boolean | undefined),
            });
          }
        }
      }
    }

    // Tool call
    const toolCall = msg['toolCall'] as Record<string, unknown> | undefined;
    if (toolCall?.['functionCalls']) {
      const calls = toolCall['functionCalls'] as Array<Record<string, unknown>>;
      for (const call of calls) {
        this.handleToolCall(
          call['id'] as string,
          call['name'] as string,
          call['args'] as Record<string, unknown>
        );
      }
    }
  }

  /**
   * Выполнить tool call и вернуть результат обратно в Gemini
   */
  private async handleToolCall(
    callId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<void> {
    this.onEvent({ type: 'tool_call', name, args });

    let result: unknown;
    try {
      result = await this.executeTool(name, args);
    } catch (err) {
      result = { error: String(err) };
    }

    // Возвращаем результат инструмента
    const toolResponse = {
      toolResponse: {
        functionResponses: [{
          id: callId,
          name,
          response: { output: JSON.stringify(result) },
        }],
      },
    };
    this.ws?.send(JSON.stringify(toolResponse));
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'search_knowledge': {
        const chunks = await searchKnowledge(this.context.orgId, args['query'] as string, 3);
        return { results: chunks.map(c => ({ content: c.content, category: c.category })) };
      }
      case 'update_lead': {
        if (this.context.leadId) {
          await updateLeadStage(this.context.orgId, this.context.leadId, args['stage'] as string, args['notes'] as string | undefined);
        }
        return { success: true };
      }
      case 'book_meeting': {
        if (this.context.leadId) {
          await pool.query(
            `UPDATE leads SET metadata = metadata || $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify({ meeting: { datetime: args['datetime'], type: args['type'] } }), this.context.leadId]
          );
        }
        return { success: true };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  /**
   * Отправить текстовое сообщение (для тестирования)
   */
  sendText(text: string): void {
    const msg = {
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    };
    this.ws?.send(JSON.stringify(msg));
  }

  /**
   * Завершить разговор
   */
  disconnect(): void {
    this.ws?.close();
  }
}
