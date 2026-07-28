import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import Sidebar from './components/Sidebar';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import Login from './pages/Login';
import Register from './pages/Register';
import api from './api';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Conversations = lazy(() => import('./pages/Conversations'));
const Recordings = lazy(() => import('./pages/Recordings'));
const Knowledge = lazy(() => import('./pages/Knowledge'));
const Agents = lazy(() => import('./pages/Agents'));
const VoiceTest = lazy(() => import('./pages/VoiceTest'));
const Chat = lazy(() => import('./pages/Chat'));
const Help = lazy(() => import('./pages/Help'));

type AuthState = 'loading' | 'authenticated' | 'anonymous';

const authenticatedPages: Record<string, React.LazyExoticComponent<() => React.JSX.Element>> = {
  '/dashboard': Dashboard,
  '/conversations': Conversations,
  '/recordings': Recordings,
  '/knowledge': Knowledge,
  '/agents': Agents,
  '/voice-test': VoiceTest,
  '/chat': Chat,
  '/help': Help,
};

function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const updatePath = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', updatePath);
    return () => window.removeEventListener('popstate', updatePath);
  }, []);
  return pathname;
}

function PrivateLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen lg:h-screen lg:overflow-hidden">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto bg-gray-50 p-4 pt-20 transition-colors sm:p-6 sm:pt-20 lg:pt-6">
        <RouteErrorBoundary>
          <Suspense fallback={<div className="flex h-64 items-center justify-center text-sm text-gray-400">Загрузка раздела…</div>}>
            {children}
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}

function AppRoutes({ auth, refreshAuth }: { auth: AuthState; refreshAuth: () => void }) {
  const pathname = usePathname();
  const targetPath = auth === 'anonymous'
    ? (pathname === '/register' ? '/register' : '/login')
    : (authenticatedPages[pathname] ? pathname : '/dashboard');

  useEffect(() => {
    if (auth !== 'loading') navigate(targetPath);
  }, [auth, targetPath]);

  if (auth === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-gray-50 text-sm text-gray-400">Проверяем сессию…</div>;
  }

  if (auth === 'anonymous') {
    return targetPath === '/register'
      ? <Register onRegister={refreshAuth} />
      : <Login onLogin={refreshAuth} />;
  }

  const Page = authenticatedPages[targetPath] ?? Dashboard;
  return (
    <PrivateLayout>
      <Page />
    </PrivateLayout>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const refreshAuth = () => setAuth('loading');

  useEffect(() => {
    if (auth !== 'loading') return;
    let cancelled = false;
    Promise.all([
      api.get('/auth/me'),
      api.get('/system/version').catch(() => ({ data: { buildId: 'unknown' } })),
    ]).then(([me, version]) => {
      if (cancelled) return;
      localStorage.removeItem('token');
      localStorage.setItem('orgId', me.data.orgId);
      localStorage.setItem('salesagent-build-id', version.data.buildId);
      setAuth('authenticated');
    }).catch(() => {
      if (!cancelled) setAuth('anonymous');
    });
    return () => { cancelled = true; };
  }, [auth]);

  return <AppRoutes auth={auth} refreshAuth={refreshAuth} />;
}
