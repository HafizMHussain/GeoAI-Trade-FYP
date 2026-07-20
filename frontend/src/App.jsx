import { useState, useCallback, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import Landing           from './pages/Landing';
import Dashboard         from './pages/Dashboard';
import Globe             from './pages/Globe';
import RoutePlanner      from './pages/RoutePlanner';
import AssetProfile      from './pages/AssetProfile';
import ScenarioSimulator from './pages/ScenarioSimulator';
import ErrorBoundary     from './components/ErrorBoundary';
import Topbar            from './components/Topbar';
import ChatPanel         from './components/chat/ChatPanel';
import ChatButton        from './components/chat/ChatButton';
import './App.css';

const _origConsoleError = console.error;
console.error = (...args) => {
  const msg = args[0]?.toString?.() || '';
  if (msg.includes('message channel closed') || msg.includes('asynchronous response')) return;
  _origConsoleError(...args);
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000, refetchOnWindowFocus: false },
  },
});

const FLOATING_PAGES = ['/map', '/dashboard', '/routes', '/scenario', '/globe'];

// ── Action labels for the toast ──────────────────────────────────────────────
const ACTION_TOAST = {
  flyTo:              (a) => `📍 Flying to ${a.name || a.asset_id} on the map`,
  showRoute:          (a) => `🛣 Opening Route Planner — searching route`,
  runScenario:        (a) => `⚡ Opening Scenario Simulator — running simulation`,
  highlightAssets:    (a) => `✨ Highlighting ${a.asset_ids?.length || 0} assets on the Risk Map`,
  moveSlider:         (a) => `⏱ Moving time slider to ${a.timestamp}`,
  flyTo3d:            (a) => `🌏 Flying to ${a.name || a.asset_id} on the 3D Globe`,
  showRoute3d:        (a) => `🌏 Opening 3D Globe — plotting route`,
  highlightAssets3d:  (a) => `🌏 Highlighting assets on the 3D Globe`,
};

// ── Sliding action toast ─────────────────────────────────────────────────────
function ActionToast({ action, onDone }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!action) return;
    setVisible(true);
    const t = setTimeout(() => { setVisible(false); setTimeout(onDone, 350); }, 3500);
    return () => clearTimeout(t);
  }, [action]);

  if (!action) return null;
  const label = ACTION_TOAST[action.type]?.(action) || `⚙ ${action.type}`;

  return (
    <div className={`fixed top-16 left-1/2 z-[60] transition-all duration-300 pointer-events-none
                     ${visible ? 'opacity-100 -translate-x-1/2 translate-y-0' : 'opacity-0 -translate-x-1/2 -translate-y-3'}`}
         style={{ transform: `translateX(-50%) translateY(${visible ? 0 : -12}px)` }}>
      <div className="bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-full
                      shadow-xl flex items-center gap-2 whitespace-nowrap border border-white/10">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
        {label}
      </div>
    </div>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────
function AppShell() {
  const { pathname } = useLocation();
  const navigate     = useNavigate();
  const isFloating   = pathname === '/' || FLOATING_PAGES.some(p => pathname.startsWith(p));

  const [chatOpen,    setChatOpen]    = useState(false);
  const [hasUnread,   setHasUnread]   = useState(false);
  const [toastAction, setToastAction] = useState(null);

  const handleChatAction = useCallback((action) => {
    if (!action?.type) return;

    // Show toast immediately
    setToastAction(action);

    switch (action.type) {

      case 'flyTo': {
        const params = new URLSearchParams({ flyTo: action.asset_id });
        if (action.name) params.set('flyName', action.name);
        navigate(`/map?${params.toString()}`);
        break;
      }

      case 'showRoute': {
        const params = new URLSearchParams();
        if (action.from) params.set('from', action.from);
        if (action.to)   params.set('to',   action.to);
        // Map mode aliases from LLM to our values
        const modeMap = { safest: 'any', fastest: 'any', balanced: 'any', road: 'road', rail: 'rail' };
        const mode    = action.mode || 'any';
        params.set('mode', modeMap[mode] || 'any');
        // Pass the avoidance intent as a separate param RoutePlanner reads
        if (mode === 'safest') params.set('avoidRisk', '1');
        navigate(`/routes?${params.toString()}`);
        break;
      }

      case 'runScenario': {
        const params = new URLSearchParams();
        const targets = Array.isArray(action.targets)
          ? action.targets
          : [action.targets].filter(Boolean);
        // Pass ALL targets comma-separated so ScenarioSimulator reads them all
        if (targets.length) params.set('target', targets.join(','));
        if (action.scenario_type) params.set('type', action.scenario_type);
        if (action.severity != null) params.set('severity', String(action.severity));
        navigate(`/scenario?${params.toString()}`);
        break;
      }

      case 'highlightAssets': {
        const ids = Array.isArray(action.asset_ids) ? action.asset_ids.join(',') : '';
        navigate(`/map?highlight=${encodeURIComponent(ids)}`);
        break;
      }

      // ── 3D Globe variants (triggered when user says "3d" / "globe") ────────
      case 'flyTo3d': {
        const params3 = new URLSearchParams({ flyTo: action.asset_id });
        if (action.name) params3.set('flyName', action.name);
        navigate(`/globe?${params3.toString()}`);
        break;
      }
      case 'showRoute3d': {
        const p3 = new URLSearchParams();
        if (action.from) p3.set('from', action.from);
        if (action.to)   p3.set('to',   action.to);
        navigate(`/globe?${p3.toString()}`);
        break;
      }
      case 'highlightAssets3d': {
        const ids3 = Array.isArray(action.asset_ids) ? action.asset_ids.join(',') : '';
        navigate(`/globe?flyTo=${ids3.split(',')[0] || ''}`);
        break;
      }

      case 'moveSlider': {
        navigate(`/map?slider=${encodeURIComponent(action.timestamp || '')}`);
        break;
      }

      default:
        break;
    }
  }, [navigate]);

  const handleBotMessage = useCallback((action) => {
    if (action) handleChatAction(action);
    if (!chatOpen && action) setHasUnread(true);
  }, [handleChatAction, chatOpen]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {!isFloating && <Topbar mode="full" />}

      <div className="flex-1 flex flex-col min-h-0">
        <ErrorBoundary>
          <Routes>
            <Route path="/"                element={<Landing />} />
            <Route path="/map"             element={<Dashboard />} />
            <Route path="/dashboard"       element={<Dashboard />} />
            <Route path="/routes"          element={<RoutePlanner />} />
            <Route path="/scenario"        element={<ScenarioSimulator />} />
            <Route path="/asset/:asset_id" element={<AssetProfile />} />
            <Route path="/globe"           element={<Globe />} />
          </Routes>
        </ErrorBoundary>
      </div>

      {/* Action toast — slides in from top center whenever a map action fires */}
      <ActionToast action={toastAction} onDone={() => setToastAction(null)} />

      {/* Global AI chat */}
      <ChatPanel
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        onAction={handleBotMessage}
      />
      <ChatButton
        isOpen={chatOpen}
        onClick={() => { setChatOpen(p => !p); setHasUnread(false); }}
        hasUnread={hasUnread}
      />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <AppShell />
      </Router>
    </QueryClientProvider>
  );
}
