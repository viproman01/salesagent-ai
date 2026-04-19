import { Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Conversations from './pages/Conversations';
import Recordings from './pages/Recordings';
import Knowledge from './pages/Knowledge';
import Agents from './pages/Agents';
import VoiceTest from './pages/VoiceTest';
import Chat from './pages/Chat';
import Login from './pages/Login';

function PrivateLayout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
        <Routes>
          <Route path="/"              element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"     element={<Dashboard />} />
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/recordings"    element={<Recordings />} />
          <Route path="/knowledge"     element={<Knowledge />} />
          <Route path="/agents"        element={<Agents />} />
          <Route path="/voice-test"   element={<VoiceTest />} />
          <Route path="/chat"          element={<Chat />} />
        </Routes>
      </main>
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
    <Routes>
      <Route path="/login" element={
        isAuth ? <Navigate to="/dashboard" /> : <Login onLogin={() => setIsAuth(true)} />
      } />
      <Route path="/*" element={
        isAuth ? <PrivateLayout /> : <Navigate to="/login" />
      } />
    </Routes>
  );
}
