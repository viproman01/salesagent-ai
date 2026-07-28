import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, type JwtPayload } from './auth';
import { generateAgentTurn } from '../orchestrator/session-manager';
import { AppError } from '../middleware/errorHandler';

const chatSchema = z.object({
  agentId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
  sessionId: z.string().min(4).max(100),
});

export const chatRouter = Router();

chatRouter.post('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid chat request', details: parsed.error.issues });
    return;
  }
  const user = (req as Request & { user: JwtPayload }).user;
  let result;
  try {
    result = await generateAgentTurn({
      orgId: user.orgId,
      agentId: parsed.data.agentId,
      channel: 'chat',
      phone: `web-chat-${user.userId}-${parsed.data.sessionId}`,
      text: parsed.data.message,
      externalId: parsed.data.sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/OpenRouter|Cerebras|API_KEY|cooling down|fetch failed|aborted/i.test(message)) {
      throw new AppError(
        503,
        'AI-провайдер временно недоступен. Повторите запрос через несколько секунд.'
      );
    }
    throw error;
  }
  res.json({
    reply: result.text,
    conversationId: result.conversationId,
    toolsUsed: result.toolsUsed,
  });
});
