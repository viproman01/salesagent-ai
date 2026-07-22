export type WhatsAppControlCommand = 'stop' | 'start' | 'human';

const COMMANDS: Readonly<Record<WhatsAppControlCommand, ReadonlySet<string>>> = {
  stop: new Set([
    'stop',
    'стоп',
    'отписаться',
    'отмена',
    'не пишите',
    'не писать',
    'прекратить',
  ]),
  start: new Set([
    'start',
    'старт',
    'возобновить',
    'включить автоответ',
    'включить ai',
  ]),
  human: new Set([
    'оператор',
    'человек',
    'менеджер',
    'позовите оператора',
    'позвать оператора',
    'соедините с оператором',
    'соединить с оператором',
    'хочу поговорить с человеком',
  ]),
};

export const WHATSAPP_CONTROL_REPLIES: Readonly<
  Record<WhatsAppControlCommand, string>
> = Object.freeze({
  stop:
    'Я AI-ассистент компании. Автоматические ответы отключены. Чтобы включить их снова, отправьте «СТАРТ».',
  start:
    'Я AI-ассистент компании. Автоматические ответы снова включены. Чем могу помочь?',
  human:
    'Я AI-ассистент компании. Передаю переписку оператору и больше не буду отвечать автоматически.',
});

export const WHATSAPP_RATE_LIMIT_REPLY =
  'Я AI-ассистент компании. Сообщения приходят слишком быстро. Подождите минуту или отправьте «ОПЕРАТОР», чтобы перейти к человеку.';

export function classifyWhatsAppControlCommand(
  text: string
): WhatsAppControlCommand | null {
  const normalized = normalizeCommand(text);
  if (isExplicitStopRequest(normalized)) return 'stop';
  for (const command of ['stop', 'start', 'human'] as const) {
    if (COMMANDS[command].has(normalized)) return command;
  }
  return null;
}

export function ensureAiDisclosure(text: string, isFirstAiReply: boolean): string {
  const normalized = text.trim();
  if (!isFirstAiReply || containsAiDisclosure(normalized)) return normalized;
  return `Я AI-ассистент компании. ${normalized}`;
}

function normalizeCommand(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/[.!?,;:]+$/gu, '')
    .replace(/\s+/gu, ' ');
}

function isExplicitStopRequest(text: string): boolean {
  // Accept common explicit opt-out variants while keeping phrases such as
  // "не пишите цену без скидки" outside the control path.
  return /^(?:(?:please|пожалуйста)\s+)?\/?(?:stop|стоп)(?:\s+(?:please|пожалуйста))?$/iu
    .test(text) ||
    /^(?:пожалуйста\s+)?не\s+(?:пишите|писать)(?:\s+(?:мне|нам))?(?:\s+больше)?(?:\s+пожалуйста)?$/iu
      .test(text);
}

function containsAiDisclosure(text: string): boolean {
  return /(?:ai|ии)[-\s]?(?:ассистент|помощник|агент)/iu.test(text) ||
    /(?:виртуальн(?:ый|ая)|цифров(?:ой|ая))\s+(?:ассистент|помощник|агент)/iu.test(text);
}
