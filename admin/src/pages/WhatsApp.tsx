import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Link2,
  Loader2,
  LogOut,
  MessageCircle,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import api from '../api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { toast } from '../ui/Toast';

type ConnectionState = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error';

interface WhatsAppStatus {
  status: ConnectionState;
  qrCode?: string;
  phone?: string;
  pushName?: string;
  lastConnectedAt?: string;
  error?: string;
  automation?: {
    enabled: boolean;
    activeAgent: boolean;
    outboxWorker: boolean;
    ready: boolean;
  };
  limits?: {
    outboundMaxChars: number;
  };
}

const STATUS_COPY: Record<ConnectionState, { label: string; description: string }> = {
  disconnected: {
    label: 'Не подключён',
    description: 'Подключите отдельный WhatsApp-номер, чтобы получать и отправлять сообщения.',
  },
  connecting: {
    label: 'Подключение…',
    description: 'Запускаем защищённую сессию и готовим QR-код.',
  },
  qr: {
    label: 'Ожидаем сканирования',
    description: 'Отсканируйте QR-код в WhatsApp на телефоне. Статус обновится автоматически.',
  },
  connected: {
    label: 'Подключён',
    description: 'Транспорт WhatsApp готов. Статус автоответа проверяется отдельно.',
  },
  error: {
    label: 'Ошибка подключения',
    description: 'Сессию не удалось запустить. Попробуйте переподключиться.',
  },
};

function statusTone(status: ConnectionState): 'neutral' | 'ok' | 'warn' | 'danger' {
  if (status === 'connected') return 'ok';
  if (status === 'connecting' || status === 'qr') return 'warn';
  if (status === 'error') return 'danger';
  return 'neutral';
}

function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string; message?: string } | undefined;
    if (error.response?.status === 404) return 'Модуль WhatsApp ещё не запущен на сервере.';
    return data?.error || data?.message || error.message;
  }
  return error instanceof Error ? error.message : 'Неизвестная ошибка';
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default function WhatsApp() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['whatsapp', 'status'],
    queryFn: () => api.get('/whatsapp/status').then(r => r.data as WhatsAppStatus),
    refetchInterval: query => {
      const status = query.state.data?.status;
      if (status === 'connecting' || status === 'qr') return 2_500;
      if (status === 'connected') return 15_000;
      return 30_000;
    },
    refetchIntervalInBackground: false,
    retry: 1,
  });

  const runAction = async (action: 'connect' | 'reconnect' | 'logout') => {
    const response = await api.post(`/whatsapp/${action}`);
    return response.data as WhatsAppStatus;
  };

  const connectMutation = useMutation({
    mutationFn: () => runAction('connect'),
    onSuccess: data => {
      queryClient.setQueryData(['whatsapp', 'status'], data);
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'status'] });
      toast.success(data.status === 'connected' ? 'WhatsApp подключён' : 'Подключение запущено');
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const reconnectMutation = useMutation({
    mutationFn: () => runAction('reconnect'),
    onSuccess: data => {
      queryClient.setQueryData(['whatsapp', 'status'], data);
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'status'] });
      toast.success('Сессия перезапущена');
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const logoutMutation = useMutation({
    mutationFn: () => runAction('logout'),
    onSuccess: data => {
      queryClient.setQueryData(['whatsapp', 'status'], data);
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'status'] });
      toast.success('WhatsApp отключён');
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const status = statusQuery.data?.status ?? 'disconnected';
  const copy = STATUS_COPY[status];
  const connectedAt = formatDate(statusQuery.data?.lastConnectedAt);
  const actionPending = connectMutation.isPending || reconnectMutation.isPending || logoutMutation.isPending;
  const fetchError = statusQuery.isError ? errorMessage(statusQuery.error) : null;
  const serviceError = statusQuery.data?.error;
  const automation = statusQuery.data?.automation;

  let automationLabel = 'Статус AI не подтверждён';
  let automationTone: 'neutral' | 'ok' | 'warn' | 'danger' = 'neutral';
  let automationDescription = 'Сервер не вернул данные о готовности автоответа.';
  if (status !== 'connected') {
    automationLabel = 'Ожидает WhatsApp';
    automationDescription = 'Сначала подключите WhatsApp-номер.';
  } else if (automation?.ready) {
    automationLabel = 'Автоответ готов';
    automationTone = 'ok';
    automationDescription = 'AI включён, активный агент найден, очередь отправки работает.';
  } else if (automation && !automation.enabled) {
    automationLabel = 'Автоответ выключен';
    automationTone = 'danger';
    automationDescription = 'Включите TEXT_CHAT_ENABLED на сервере.';
  } else if (automation && !automation.activeAgent) {
    automationLabel = 'Нет AI-агента';
    automationTone = 'warn';
    automationDescription = 'Для WhatsApp нужен активный агент.';
  } else if (automation && !automation.outboxWorker) {
    automationLabel = 'Очередь не работает';
    automationTone = 'danger';
    automationDescription = 'Фоновый обработчик исходящих WhatsApp-сообщений не запущен.';
  } else if (automation) {
    automationLabel = 'Автоответ не готов';
    automationTone = 'warn';
    automationDescription = 'Один из компонентов автоответа ещё не готов.';
  }

  const logout = () => {
    const confirmed = window.confirm(
      'Отключить WhatsApp? Авторизация будет удалена, для повторного подключения понадобится новый QR-код.',
    );
    if (confirmed) logoutMutation.mutate();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold text-fg-0">WhatsApp</h1>
            <Badge tone={statusTone(status)} size="sm">{copy.label}</Badge>
            <Badge tone={automationTone} size="sm">{automationLabel}</Badge>
          </div>
          <p className="text-[12px] text-fg-2 mt-1">Прямое подключение WhatsApp Web без внешнего агрегатора</p>
          <p className="text-[11px] text-fg-2 mt-1">
            AI включается отдельно для каждого диалога; STOP и передача оператору блокируют автоответ.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void statusQuery.refetch()}
          disabled={statusQuery.isFetching}
          iconLeft={<RefreshCw size={13} className={statusQuery.isFetching ? 'animate-spin' : ''} />}
        >
          Обновить
        </Button>
      </div>

      {(fetchError || serviceError) && (
        <div className="flex items-start gap-2.5 rounded-3 border border-danger/30 bg-danger/10 p-3 text-[12px] text-danger" role="alert">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Не удалось подключить WhatsApp</div>
            <div className="mt-0.5 opacity-90">{fetchError || serviceError}</div>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        <Card className="min-h-[430px] flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-3 grid place-items-center shrink-0 ${status === 'connected' ? 'bg-ok/10 text-ok' : status === 'error' ? 'bg-danger/10 text-danger' : 'bg-bg-2 text-fg-1'}`}>
                {status === 'connected' && <CheckCircle2 size={20} />}
                {status === 'error' && <AlertCircle size={20} />}
                {status === 'connecting' && <Loader2 size={20} className="animate-spin" />}
                {status === 'qr' && <QrCode size={20} />}
                {status === 'disconnected' && <MessageCircle size={20} />}
              </div>
              <div>
                <h2 className="text-[14px] font-semibold text-fg-0">{copy.label}</h2>
                <p className="text-[12px] text-fg-1 mt-1 max-w-lg">{copy.description}</p>
              </div>
            </div>
            {statusQuery.isFetching && !statusQuery.isLoading && <Loader2 size={14} className="animate-spin text-fg-2 shrink-0" />}
          </div>

          <div className="flex-1 grid place-items-center py-6">
            {statusQuery.isLoading ? (
              <div className="flex flex-col items-center gap-3 text-fg-2 text-[12px]">
                <Loader2 size={28} className="animate-spin" />
                Проверяем сессию…
              </div>
            ) : status === 'qr' && statusQuery.data?.qrCode ? (
              <div className="text-center">
                <div className="inline-flex rounded-4 border border-line bg-white p-3 shadow-d-2">
                  <img
                    src={statusQuery.data.qrCode}
                    alt="QR-код для подключения WhatsApp"
                    className="w-[256px] h-[256px] object-contain"
                  />
                </div>
                <p className="mt-3 text-[11px] text-fg-2">Не закрывайте страницу до завершения привязки</p>
              </div>
            ) : status === 'connecting' || (status === 'qr' && !statusQuery.data?.qrCode) ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-20 h-20 rounded-full bg-bg-2 grid place-items-center text-fg-1">
                  <Loader2 size={30} className="animate-spin" />
                </div>
                <div>
                  <div className="text-[13px] font-medium text-fg-0">Генерируем QR-код</div>
                  <div className="text-[11px] text-fg-2 mt-1">Обычно это занимает несколько секунд</div>
                </div>
              </div>
            ) : status === 'connected' ? (
              <div className="w-full max-w-sm rounded-3 border border-ok/30 bg-ok/10 p-5 text-center">
                <div className="mx-auto w-14 h-14 rounded-full bg-ok/15 text-ok grid place-items-center">
                  <CheckCircle2 size={28} />
                </div>
                <div className="mt-3 text-[15px] font-semibold text-fg-0">{statusQuery.data?.pushName || 'WhatsApp Business'}</div>
                {statusQuery.data?.phone && <div className="mt-1 text-[13px] num text-fg-1">+{statusQuery.data.phone.replace(/^\+/, '')}</div>}
                {connectedAt && (
                  <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-fg-2">
                    <Clock3 size={12} />
                    Подключён {connectedAt}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-20 h-20 rounded-full bg-bg-2 grid place-items-center text-fg-2">
                  <Smartphone size={30} />
                </div>
                <div className="text-[12px] text-fg-2 max-w-xs">Для теста лучше использовать отдельный WhatsApp Business-номер.</div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap justify-center gap-2 border-t border-line pt-4">
            {status === 'disconnected' && (
              <Button
                onClick={() => connectMutation.mutate()}
                loading={connectMutation.isPending}
                disabled={actionPending}
                iconLeft={<Link2 size={14} />}
              >
                {connectMutation.isPending ? 'Подключаем…' : 'Подключить WhatsApp'}
              </Button>
            )}
            {(status === 'connecting' || status === 'qr' || status === 'error') && (
              <Button
                variant={status === 'error' ? 'primary' : 'secondary'}
                onClick={() => reconnectMutation.mutate()}
                loading={reconnectMutation.isPending}
                disabled={actionPending}
                iconLeft={<RefreshCw size={14} />}
              >
                {reconnectMutation.isPending
                  ? 'Переподключаем…'
                  : status === 'qr' ? 'Получить новый QR' : 'Переподключить'}
              </Button>
            )}
            {status === 'connected' && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => reconnectMutation.mutate()}
                  loading={reconnectMutation.isPending}
                  disabled={actionPending}
                  iconLeft={<RefreshCw size={14} />}
                >
                  {reconnectMutation.isPending ? 'Переподключаем…' : 'Переподключить'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={logout}
                  loading={logoutMutation.isPending}
                  disabled={actionPending}
                  className="hover:!text-danger"
                  iconLeft={<LogOut size={14} />}
                >
                  {logoutMutation.isPending ? 'Отключаем…' : 'Отключить номер'}
                </Button>
              </>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Как подключить" />
            <ol className="space-y-3">
              {[
                'Нажмите «Подключить WhatsApp» и дождитесь QR-кода.',
                'Откройте WhatsApp: на iPhone — «Настройки», на Android — меню ⋮.',
                'Выберите «Связанные устройства».',
                'Нажмите «Привязка устройства» и отсканируйте QR-код.',
              ].map((step, index) => (
                <li key={step} className="flex gap-2.5 text-[12px] text-fg-1">
                  <span className="w-5 h-5 shrink-0 rounded-full bg-bg-2 border border-line grid place-items-center text-[10px] font-semibold num text-fg-0">{index + 1}</span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </Card>

          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[13px] font-semibold text-fg-0">Автоматическая переписка</h3>
                  <Badge tone={automationTone} size="sm">{automationLabel}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-fg-1">
                  {automationDescription}
                </p>
                {statusQuery.data?.limits?.outboundMaxChars && (
                  <p className="mt-1 text-[10px] text-fg-2">
                    Лимит исходящего сообщения: {statusQuery.data.limits.outboundMaxChars} символов.
                  </p>
                )}
              </div>
              <Link
                to="/conversations"
                className="h-7 px-2.5 inline-flex items-center rounded-2 border border-line bg-bg-2 text-[12px] text-fg-0 hover:bg-line"
              >
                Разговоры
              </Link>
            </div>
          </Card>

          <Card>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-2 bg-accent/10 text-accent grid place-items-center shrink-0">
                <ShieldCheck size={17} />
              </div>
              <div>
                <h3 className="text-[13px] font-semibold text-fg-0">Важно для стабильной работы</h3>
                <ul className="mt-2 space-y-1.5 text-[11px] text-fg-1 list-disc pl-4">
                  <li>Не выходите из WhatsApp на привязанном устройстве.</li>
                  <li>Держите телефон и WhatsApp в актуальном состоянии.</li>
                  <li>Не используйте подключение для массовых незапрошенных рассылок.</li>
                </ul>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
