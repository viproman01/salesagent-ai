import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import CommandPalette from './components/CommandPalette';
import { useHotkeys } from './hooks/useHotkeys';

const Dashboard     = lazy(() => import('./pages/Dashboard'));
const Conversations = lazy(() => import('./pages/Conversations'));
const Recordings    = lazy(() => import('./pages/Recordings'));
const Knowledge     = lazy(() => import('./pages/Knowledge'));
const Agents        = lazy(() => import('./pages/Agents'));
const VoiceTest     = lazy(() => import('./pages/VoiceTest'));
const Chat          = lazy(() => import('./pages/Chat'));
const WhatsApp      = lazy(() => import('./pages/WhatsApp'));
const Login         = lazy(() => import('./pages/Login'));

const Fallback = () => (
  <div className="h-full grid place-items-center text-fg-2 text-[13px]">Загрузка…</div>
);

function PrivateLayout() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useHotkeys(
    [{ combo: 'mod+k', handler: () => setPaletteOpen(o => !o) }],
    [
      { keys: ['g', 'd'], handler: () => navigate('/dashboard') },
      { keys: ['g', 'c'], handler: () => navigate('/conversations') },
      { keys: ['g', 'r'], handler: () => navigate('/recordings') },
      { keys: ['g', 'k'], handler: () => navigate('/knowledge') },
      { keys: ['g', 'a'], handler: () => navigate('/agents') },
      { keys: ['g', 'v'], handler: () => navigate('/voice-test') },
      { keys: ['g', 'h'], handler: () => navigate('/chat') },
      { keys: ['g', 'w'], handler: () => navigate('/whatsapp') },
    ]
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-bg-0">
          <Suspense fallback={<Fallback />}>
            <Routes>
              <Route path="/"              element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard"     element={<Dashboard />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route path="/recordings"    element={<Recordings />} />
              <Route path="/knowledge"     element={<Knowledge />} />
              <Route path="/agents"        element={<Agents />} />
              <Route path="/voice-test"    element={<VoiceTest />} />
              <Route path="/chat"          element={<Chat />} />
              <Route path="/whatsapp"      element={<WhatsApp />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

export default function App() {
  const [isAuth, setIsAuth] = useState<boolean | null>(null);

  useEffect(() => {
    setIsAuth(!!localStorage.getItem('token'));
  }, []);

  if (isAuth === null) return null;

  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route path="/login" element={
          isAuth ? <Navigate to="/dashboard" /> : <Login onLogin={() => setIsAuth(true)} />
        } />
        <Route path="/*" element={
          isAuth ? <PrivateLayout /> : <Navigate to="/login" />
        } />
      </Routes>
    </Suspense>
  );
}
