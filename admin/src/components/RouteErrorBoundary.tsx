import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import api from '../api';

interface Props { children: ReactNode }
interface State { error: Error | null }

function isChunkLoadError(error: Error): boolean {
  return /ChunkLoadError|dynamically imported module|Loading chunk|Importing a module script failed/i.test(
    `${error.name} ${error.message}`
  );
}

export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const route = window.location.pathname;
    const buildId = localStorage.getItem('salesagent-build-id') ?? 'unknown';
    void api.post('/system/client-errors', {
      name: error.name,
      message: error.message,
      route,
      buildId,
      stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 4000),
    }).catch(() => undefined);

    if (isChunkLoadError(error)) {
      const reloadKey = `salesagent-chunk-reload:${route}`;
      if (sessionStorage.getItem(reloadKey) !== buildId) {
        sessionStorage.setItem(reloadKey, buildId);
        window.location.reload();
      }
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunkError = isChunkLoadError(this.state.error);
    return (
      <div className="mx-auto mt-12 max-w-xl rounded-2xl border border-red-200 bg-white p-7 text-center shadow-sm">
        <AlertTriangle className="mx-auto mb-3 text-red-500" size={34} />
        <h1 className="text-lg font-semibold text-gray-900">
          {chunkError ? 'Приложение обновилось' : 'Раздел не удалось открыть'}
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          {chunkError
            ? 'Загрузилась старая часть интерфейса. Обновите страницу, чтобы перейти на текущую версию.'
            : 'Ошибка уже отправлена в диагностику. Можно повторить загрузку без повторного входа.'}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mx-auto mt-5 flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
        >
          <RefreshCw size={15} /> Обновить приложение
        </button>
        <p className="mt-4 font-mono text-xs text-gray-400">
          build: {localStorage.getItem('salesagent-build-id') ?? 'unknown'}
        </p>
      </div>
    );
  }
}
