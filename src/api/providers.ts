import { Router, type Request, type Response } from 'express';
import { requireAuth } from './auth';
import { config } from '../config';
import { listCerebrasModels } from '../ai/cerebras';
import {
  CARTESIA_RUSSIAN_VOICES,
  listCartesiaRussianVoices,
} from '../ai/cartesia';

export const providersRouter = Router();

interface CatalogModel {
  id: string;
  name: string;
  supportsTools: boolean;
  recommended: boolean;
  capability?: 'chat' | 'stt';
  price?: string;
}

const RECOMMENDED_OPENROUTER_MODELS = new Set([
  'openrouter/auto',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
]);

async function listOpenRouterModels(query = ''): Promise<CatalogModel[]> {
  if (!config.OPENROUTER_API_KEY) return [];
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
  });
  if (!response.ok) throw new Error(`OpenRouter model catalog returned ${response.status}`);
  const payload = await response.json() as {
    data?: Array<{ id: string; name: string; supported_parameters?: string[] }>;
  };
  const normalizedQuery = query.trim().toLowerCase();
  return (payload.data ?? [])
    .filter(model =>
      !normalizedQuery
      || model.id.toLowerCase().includes(normalizedQuery)
      || model.name.toLowerCase().includes(normalizedQuery)
    )
    .map(model => ({
      id: model.id,
      name: model.name,
      supportsTools: model.supported_parameters?.includes('tools') ?? false,
      recommended: RECOMMENDED_OPENROUTER_MODELS.has(model.id),
    }))
    .sort((left, right) =>
      Number(right.recommended) - Number(left.recommended)
      || Number(right.supportsTools) - Number(left.supportsTools)
      || left.name.localeCompare(right.name)
    );
}

async function listOpenRouterSttModels(query = ''): Promise<CatalogModel[]> {
  if (!config.OPENROUTER_API_KEY) return [];
  const url = new URL('https://openrouter.ai/api/v1/models');
  url.searchParams.set('output_modalities', 'transcription');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
  });
  if (!response.ok) throw new Error(`OpenRouter STT catalog returned ${response.status}`);
  const payload = await response.json() as {
    data?: Array<{
      id: string;
      name: string;
      pricing?: { prompt?: string };
      architecture?: { output_modalities?: string[] };
    }>;
  };
  const normalizedQuery = query.trim().toLowerCase();
  return (payload.data ?? [])
    .filter(model => model.architecture?.output_modalities?.includes('transcription'))
    .filter(model =>
      !normalizedQuery
      || model.id.toLowerCase().includes(normalizedQuery)
      || model.name.toLowerCase().includes(normalizedQuery)
    )
    .map(model => ({
      id: model.id,
      name: model.name,
      supportsTools: false,
      recommended: model.id === config.OPENROUTER_STT_MODEL,
      capability: 'stt' as const,
      price: model.pricing?.prompt,
    }))
    .sort((left, right) =>
      Number(right.recommended) - Number(left.recommended) || left.name.localeCompare(right.name)
    );
}

providersRouter.get('/status', requireAuth, (req: Request, res: Response): void => {
  const publicUrl = config.PUBLIC_BASE_URL ?? config.API_BASE_URL;
  res.json({
    database: true,
    openrouter: Boolean(config.OPENROUTER_API_KEY),
    openrouterStt: Boolean(config.OPENROUTER_API_KEY),
    sttModel: config.OPENROUTER_STT_MODEL,
    sttFallbackModel: config.OPENROUTER_STT_FALLBACK_MODEL,
    cerebras: config.CEREBRAS_API_KEYS.length > 0,
    cerebrasKeyCount: config.CEREBRAS_API_KEYS.length,
    fishAudio: Boolean(config.FISH_AUDIO_API_KEY),
    fishModel: config.FISH_AUDIO_MODEL,
    cartesia: Boolean(config.CARTESIA_API_KEY),
    cartesiaModel: config.CARTESIA_MODEL,
    cartesiaDefaultVoice: config.CARTESIA_DEFAULT_VOICE_ID,
    voiceFastModel: config.VOICE_FAST_MODEL,
    voiceDeepModel: config.VOICE_DEEP_MODEL,
    defaultVoice: Boolean(config.FISH_AUDIO_DEFAULT_VOICE_ID),
    voiceWebhookSecret: Boolean(config.VOICE_WEBHOOK_SECRET),
    https: req.secure || publicUrl.startsWith('https://'),
    redis: config.REDIS_URL !== 'memory',
    voximplant: Boolean(config.VOXIMPLANT_ACCOUNT_ID && config.VOXIMPLANT_API_KEY),
    whatsapp: Boolean(config.WAZZUP24_API_KEY && config.WAZZUP24_CHANNEL_ID && config.WAZZUP24_WEBHOOK_SECRET),
    telegram: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_WEBHOOK_SECRET),
    storage: Boolean(config.S3_ENDPOINT && config.S3_ACCESS_KEY && config.S3_SECRET_KEY),
  });
});

providersRouter.get('/openrouter/stt-models', requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!config.OPENROUTER_API_KEY) {
    res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured' });
    return;
  }
  try {
    res.json({
      models: await listOpenRouterSttModels(String(req.query['q'] ?? '')),
      defaultModel: config.OPENROUTER_STT_MODEL,
      fallbackModel: config.OPENROUTER_STT_FALLBACK_MODEL,
    });
  } catch {
    res.status(502).json({ error: 'OpenRouter STT model catalog unavailable' });
  }
});

providersRouter.get('/openrouter/models', requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!config.OPENROUTER_API_KEY) {
    res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured' });
    return;
  }
  try {
    res.json({ models: await listOpenRouterModels(String(req.query['q'] ?? '')) });
  } catch {
    res.status(502).json({ error: 'OpenRouter model catalog unavailable' });
  }
});

providersRouter.get('/cerebras/models', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  if (config.CEREBRAS_API_KEYS.length === 0) {
    res.status(503).json({ error: 'CEREBRAS_API_KEYS is not configured' });
    return;
  }
  try {
    res.json({ models: await listCerebrasModels(), keyCount: config.CEREBRAS_API_KEYS.length });
  } catch {
    res.status(502).json({ error: 'Cerebras model catalog unavailable' });
  }
});

providersRouter.get('/models', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const [openrouterResult, cerebrasResult] = await Promise.allSettled([
    listOpenRouterModels(),
    listCerebrasModels(),
  ]);
  res.json({
    providers: [
      {
        id: 'cerebras',
        name: 'Cerebras',
        configured: config.CEREBRAS_API_KEYS.length > 0,
        keyCount: config.CEREBRAS_API_KEYS.length,
        models: cerebrasResult.status === 'fulfilled' ? cerebrasResult.value : [],
        catalogAvailable: cerebrasResult.status === 'fulfilled',
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        configured: Boolean(config.OPENROUTER_API_KEY),
        keyCount: config.OPENROUTER_API_KEY ? 1 : 0,
        models: openrouterResult.status === 'fulfilled' ? openrouterResult.value : [],
        catalogAvailable: openrouterResult.status === 'fulfilled',
      },
    ],
  });
});

providersRouter.get('/fish/voices', requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!config.FISH_AUDIO_API_KEY) {
    res.status(503).json({ error: 'FISH_AUDIO_API_KEY is not configured' });
    return;
  }
  const page = Math.max(1, Math.min(100, Number(req.query['page'] ?? 1)));
  const response = await fetch(`https://api.fish.audio/model?page_size=50&page_number=${page}`, { headers: { Authorization: `Bearer ${config.FISH_AUDIO_API_KEY}` } });
  if (!response.ok) { res.status(502).json({ error: 'Fish Audio voice catalog unavailable' }); return; }
  const payload = await response.json() as { items?: Array<{ _id: string; title: string; languages?: string[]; visibility?: string }>; has_more?: boolean };
  res.json({ voices: (payload.items ?? []).map(item => ({ id: item._id, name: item.title, languages: item.languages ?? [], visibility: item.visibility })), hasMore: payload.has_more ?? false });
});

providersRouter.get('/cartesia/voices', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  if (!config.CARTESIA_API_KEY) {
    res.status(503).json({ error: 'CARTESIA_API_KEY is not configured' });
    return;
  }
  try {
    res.json({
      voices: await listCartesiaRussianVoices(),
      model: config.CARTESIA_MODEL,
      defaultVoiceId: config.CARTESIA_DEFAULT_VOICE_ID,
      streaming: true,
      catalogAvailable: true,
    });
  } catch {
    res.json({
      voices: CARTESIA_RUSSIAN_VOICES,
      model: config.CARTESIA_MODEL,
      defaultVoiceId: config.CARTESIA_DEFAULT_VOICE_ID,
      streaming: true,
      catalogAvailable: false,
    });
  }
});
