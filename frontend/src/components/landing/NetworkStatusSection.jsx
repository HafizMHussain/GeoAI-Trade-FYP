import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TIER_COLOR } from '../../styles/tokens';

const HAZARD_META = {
  flood:    { icon: '🌊', label: 'Flooding',          plain: 'Heavy rainfall & river overflow threatening roads and ports' },
  cyclone:  { icon: '🌀', label: 'Cyclone / Storm',   plain: 'Tropical storm activity near Pakistan coastline' },
  strike:   { icon: '🚫', label: 'Labor Action',      plain: 'Strikes, road blockades or border closures detected in news' },
  accident: { icon: '⚠️', label: 'Transport Accidents', plain: 'Road/rail accidents detected via traffic & news analysis' },
};

function ThreatCard({ type, data }) {
  const meta = HAZARD_META[type];
  if (!data) return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 animate-pulse">
      <div className="h-4 bg-gray-100 rounded w-2/3 mb-3" />
      <div className="h-3 bg-gray-100 rounded w-full" />
    </div>
  );

  const active = data.status !== 'OK';
  const isCritical = data.status === 'CRITICAL';
  const c = isCritical ? TIER_COLOR.CRITICAL : data.status === 'ACTIVE' || data.status === 'HIGH' ? TIER_COLOR.HIGH : '#22C55E';
  const pct = Math.round((data.max_score || 0) * 100);

  const statusConfig = {
    CRITICAL: { bg: 'bg-red-50',    border: 'border-red-200',   badge: 'bg-red-500 text-white',    dot: 'bg-red-500' },
    HIGH:     { bg: 'bg-orange-50', border: 'border-orange-200', badge: 'bg-orange-500 text-white', dot: 'bg-orange-500' },
    ACTIVE:   { bg: 'bg-orange-50', border: 'border-orange-200', badge: 'bg-orange-500 text-white', dot: 'bg-orange-400' },
    OK:       { bg: 'bg-white',     border: 'border-gray-100',   badge: 'bg-green-100 text-green-700', dot: 'bg-green-400' },
  };
  const cfg = statusConfig[data.status] || statusConfig.OK;

  return (
    <div className={`rounded-2xl border ${cfg.bg} ${cfg.border} shadow-sm p-5 transition-all hover:shadow-md`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">{meta.icon}</span>
          <div>
            <div className="text-sm font-bold text-gray-800">{meta.label}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              <span className="text-xs text-gray-500 font-mono">{data.status}</span>
            </div>
          </div>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${cfg.badge}`}>
          {data.status === 'OK' ? 'Clear' : data.status}
        </span>
      </div>

      {active ? (
        <>
          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
            <span>Intensity</span>
            <span className="font-bold text-gray-700">{pct}%</span>
          </div>
          <div className="h-2 bg-white/60 rounded-full overflow-hidden mb-2 border border-white">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: c }} />
          </div>
          <div className="text-xs text-gray-500">{data.triggered || 0} locations affected</div>
        </>
      ) : (
        <p className="text-xs text-gray-400 leading-relaxed mt-1">{meta.plain}</p>
      )}
    </div>
  );
}

function StatItem({ label, value, sub }) {
  return (
    <div className="text-center px-2">
      <div className="text-2xl font-black text-gray-900 tabular-nums">{value}</div>
      <div className="text-xs font-bold text-gray-600 mt-0.5 leading-tight">{label}</div>
      <div className="text-xs text-gray-400 mt-0.5 leading-tight">{sub}</div>
    </div>
  );
}

function RiskBar({ tier, count, total }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const labels = { CRITICAL: 'Immediate Action', HIGH: 'Monitor Closely', MEDIUM: 'Watch List', LOW: 'Normal' };
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-28 text-right flex-shrink-0">
        <div className="text-xs font-bold" style={{ color: TIER_COLOR[tier] }}>{tier}</div>
        <div className="text-xs text-gray-400">{labels[tier]}</div>
      </div>
      <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: TIER_COLOR[tier] }} />
      </div>
      <div className="w-12 text-xs font-mono font-bold text-gray-700 text-right flex-shrink-0">
        {(count || 0).toLocaleString()}
      </div>
    </div>
  );
}

export default function NetworkStatusSection({ metrics, hazSum, riskDist }) {
  const counts = hazSum?.alert_counts || {};
  const nd     = riskDist?.nodes || {};
  const hasActive = (counts.CRITICAL || 0) > 0 || (counts.HIGH || 0) > 0;

  const stats = [
    { label: 'Trade Locations',   value: (metrics?.total_nodes  || '—').toLocaleString?.() ?? '—',                sub: 'Junctions + Terminals' },
    { label: 'Road & Rail Links', value: (metrics?.total_edges  || '—').toLocaleString?.() ?? '—',                sub: 'Segments monitored' },
    { label: 'Network Length',    value: metrics ? `${Math.round((metrics.total_length_km || 0) / 1000)}K km` : '—', sub: 'Total road + rail' },
    { label: 'Avg Journey Time',  value: metrics ? `${(metrics.avg_travel_time_hr || 0).toFixed(1)}h` : '—',     sub: 'Port to port average' },
    { label: 'Trade Terminals',   value: metrics?.facility_nodes ?? 42,                                           sub: 'Ports, ICD & Stations' },
    { label: 'Freight Corridors', value: metrics?.corridors ?? 861,                                              sub: 'Pre-computed routes' },
  ];

  return (
    <div id="network-status">
      {/* ── Network stats bar ─────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-y-6 gap-x-4 divide-x-0 lg:divide-x divide-gray-100">
            {stats.map(s => <StatItem key={s.label} {...s} />)}
          </div>
        </div>
      </div>

      {/* ── Live hazard cards ──────────────────────────────────────────── */}
      <div className="bg-slate-50 border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-6 py-10">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-mono text-gray-400 uppercase tracking-widest">Live Threat Monitor</span>
              </div>
              <h2 className="text-xl font-bold text-gray-900">
                Current Network Status
                {hasActive && (
                  <span className="ml-3 text-sm font-semibold text-red-500 bg-red-50 px-2.5 py-0.5 rounded-full border border-red-200">
                    {counts.CRITICAL || 0} Critical · {counts.HIGH || 0} High
                  </span>
                )}
              </h2>
            </div>
            <Link to="/map" className="hidden sm:flex items-center gap-1.5 text-sm font-semibold text-geo-cyan hover:text-geo-teal transition-colors">
              Open Live Map →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {['flood', 'cyclone', 'strike', 'accident'].map(k => (
              <ThreatCard key={k} type={k} data={hazSum?.[k]} />
            ))}
          </div>
        </div>
      </div>

      {/* ── Risk distribution (only if data available) ─────────────────── */}
      {nd.total > 0 && (
        <div className="bg-white border-b border-gray-100">
          <div className="max-w-7xl mx-auto px-6 py-10">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
              <div>
                <div className="text-xs font-mono text-gray-400 uppercase tracking-widest mb-1">Risk Distribution</div>
                <h2 className="text-xl font-bold text-gray-900 mb-1">
                  {nd.total?.toLocaleString()} Locations Analyzed
                </h2>
                <p className="text-sm text-gray-500 mb-5">
                  UNDRR formula: Threat × Exposure × Vulnerability
                </p>
                <div className="space-y-1">
                  {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(t => (
                    <RiskBar key={t} tier={t} count={nd[t.toLowerCase()]} total={nd.total} />
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                {nd.chokepoints > 0 && (
                  <div className="bg-orange-50 border border-orange-200 rounded-2xl p-5">
                    <div className="font-bold text-orange-700 text-base mb-1">{nd.chokepoints} Critical Chokepoints</div>
                    <p className="text-sm text-orange-600/80">
                      Strategic junctions where disruption would impact many freight corridors simultaneously.
                    </p>
                  </div>
                )}
                <div className="bg-slate-50 rounded-2xl border border-slate-100 p-5">
                  <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">What these levels mean</div>
                  {[
                    { tier: 'CRITICAL', desc: 'Immediate action required — routes through this location should be avoided' },
                    { tier: 'HIGH',     desc: 'Plan alternatives — disruption likely within 24 hours' },
                    { tier: 'MEDIUM',   desc: 'Monitor closely — conditions may deteriorate' },
                    { tier: 'LOW',      desc: 'Normal operations — proceed as planned' },
                  ].map(({ tier, desc }) => (
                    <div key={tier} className="flex items-start gap-2 mb-2.5 last:mb-0">
                      <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: TIER_COLOR[tier] }} />
                      <div>
                        <span className="text-xs font-bold mr-1.5" style={{ color: TIER_COLOR[tier] }}>{tier}</span>
                        <span className="text-xs text-gray-500">{desc}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex gap-3">
                  <Link to="/map"      className="flex-1 text-center py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-700 transition-colors">Open Risk Map</Link>
                  <Link to="/scenario" className="flex-1 text-center py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition-colors">Run Scenario</Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
