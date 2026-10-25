import { createRoot } from 'react-dom/client';
import './index.css';
import { HostPage } from './pages/HostPage';
import { PlayerPage } from './pages/PlayerPage';
import { ScreenPage } from './pages/ScreenPage';

const path = location.pathname.replace(/\/+$/, '') || '/';
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

if (path === '/' && isLocal) {
  history.replaceState(null, '', '/host');
}

function App() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  if (p === '/host') return <HostPage />;
  if (p === '/screen') return <ScreenPage />;
  return <PlayerPage />;
}

createRoot(document.getElementById('root')!).render(<App />);
