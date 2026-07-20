/**
 * Shared Topbar — used on every page.
 * mode='full'     → standard navbar (Landing, AssetProfile)
 * mode='floating' → compact strip for fullscreen pages (Map, Routes, Scenario)
 */
import { Link, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { hazardApi } from '../api/networkApi';
import { TIER_COLOR } from '../styles/tokens';
import { minutesAgoFromTs, formatRelativeTime } from '../utils/formatters';

const NAV = [
  { to: '/map',      label: 'Risk Map',    icon: '🗺️' },
  { to: '/routes',   label: 'Route Planner', icon: '🛣️' },
  { to: '/scenario', label: 'Scenarios',   icon: '⚡' },
  { to: '/globe',    label: '3D Globe',    icon: '🌏' },
];

function PipelineStatus({ running, lastRunMins, dark }) {
  const label = running ? 'Updating…' : formatRelativeTime(lastRunMins) || '—';
  const isStale = !running && lastRunMins !== null && lastRunMins > 90;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
        running ? 'bg-amber-400 pulse-dot' : isStale ? 'bg-amber-400' : 'bg-green-500'
      }`} />
      <span className={
        running ? (dark ? 'text-amber-300' : 'text-amber-600') :
        isStale  ? (dark ? 'text-amber-400' : 'text-amber-600') :
                   (dark ? 'text-white/40'  : 'text-gray-400')
      }>
        {running ? 'Analyzing…' : isStale ? `Stale · ${label}` : label}
      </span>
    </div>
  );
}

function HazardPill({ hazSum, dark }) {
  if (!hazSum) return null;
  const counts = hazSum.alert_counts || {};
  if ((counts.CRITICAL || 0) === 0 && (counts.HIGH || 0) === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {counts.CRITICAL > 0 && (
        <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${dark ? 'bg-red-500/20 text-red-300 border-red-500/30' : 'bg-red-50 text-red-600 border-red-200'}`}>
          {counts.CRITICAL} Critical
        </span>
      )}
      {counts.HIGH > 0 && (
        <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${dark ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-600 border-amber-200'}`}>
          {counts.HIGH} High
        </span>
      )}
    </div>
  );
}

export default function Topbar({ mode = 'full', title, backTo, backLabel }) {
  const { data: pipeline } = useQuery({
    queryKey: ['pipeline-status'],
    queryFn:  () => hazardApi.getPipelineStatus().then(r => r.data),
    refetchInterval: 15000,
  });
  const { data: hazSum } = useQuery({
    queryKey: ['hazard-summary'],
    queryFn:  () => hazardApi.getSummary().then(r => r.data),
    refetchInterval: 30000,
  });

  const lastRunMins = minutesAgoFromTs(pipeline?.last_run);

  if (mode === 'floating') {
    return (
      <div className="absolute top-0 left-0 right-0 z-30 bg-white border-b border-gray-200 topbar shadow-sm">
        {/* Back / Brand */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {backTo ? (
            <Link to={backTo} className="flex items-center gap-1.5 text-gray-400 hover:text-slate-700 text-xs transition">
              ← {backLabel || 'Home'}
            </Link>
          ) : (
            <Link to="/" className="text-gray-400 hover:text-slate-700 text-xs transition">← Home</Link>
          )}
          {title && (
            <>
              <span className="text-gray-200 text-xs">|</span>
              <span className="text-slate-800 font-bold text-sm">{title}</span>
            </>
          )}
        </div>

        {/* Nav links */}
        <div className="flex items-center gap-0.5 ml-2">
          {NAV.map(({ to, label }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  isActive ? 'bg-slate-100 text-slate-900' : 'text-gray-400 hover:text-slate-700 hover:bg-gray-50'
                }`
              }>
              {label}
            </NavLink>
          ))}
        </div>

        <div className="flex-1" />

        {/* Hazard pills + pipeline status */}
        <HazardPill hazSum={hazSum} dark={false} />
        <div className="hidden sm:block border-l border-gray-200 pl-3 ml-1">
          <PipelineStatus running={pipeline?.running} lastRunMins={lastRunMins} dark={false} />
        </div>
      </div>
    );
  }

  // mode === 'full'
  return (
    <nav className="bg-slate-900 text-white shadow-lg flex-shrink-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-3.5 flex items-center justify-between gap-4">
        <Link to="/" className="text-lg font-black text-white hover:text-amber-400 transition tracking-tight flex-shrink-0">
          Pakistan TradeLink
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-1">
          {NAV.map(({ to, label }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) =>
                `px-3.5 py-2 rounded-lg text-sm font-semibold transition ${
                  isActive ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white hover:bg-white/10'
                }`
              }>
              {label}
            </NavLink>
          ))}
        </div>

        <div className="flex-1" />

        {/* Right: hazard pills + pipeline status */}
        <HazardPill hazSum={hazSum} dark={true} />
        <div className="border-l border-white/10 pl-3">
          <PipelineStatus running={pipeline?.running} lastRunMins={lastRunMins} dark={true} />
        </div>
      </div>
    </nav>
  );
}
