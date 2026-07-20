/**
 * Risk Network Map — the primary analytical tool.
 *
 * Layout: Left sidebar controls | Center map | Right context panel
 *
 * Non-technical language throughout:
 *   nodes → "locations" or "trade terminals" / "junctions"
 *   edges → "roads" / "rail lines" / "freight routes"
 *   betweenness → "routes passing through"
 *   composite_risk → "overall risk level"
 *   network_criticality_risk → "network impact score"
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { combinedApi, hazardApi, riskApi, networkApi, historyApi } from '../api/networkApi';
import ErrorBoundary from '../components/ErrorBoundary';
import Topbar from '../components/Topbar';
import { TIER_COLOR, TIER_BG, RISK_TIER_EXPR, ALERT_LEVEL_EXPR, ROAD_TYPE_EXPR, NODE_TYPE_EXPR } from '../styles/tokens';
import { resolveNodeName } from '../utils/nearestCity';
import { minutesAgoFromTs, formatRelativeTime, pipelineTsToLabel } from '../utils/formatters';

// ── Module-level edge cache ───────────────────────────────────────────────────
const CACHE_TTL = 25 * 60 * 1000;
const _cache = { road: null, roadTs: 0, rail: null, railTs: 0, intermodal: null, intermodalTs: 0 };
function cacheGet(k) { return _cache[k] && Date.now() - _cache[k + 'Ts'] < CACHE_TTL ? _cache[k] : null; }
function cacheSet(k, v) { _cache[k] = v; _cache[k + 'Ts'] = Date.now(); }

// ── Plain-English helpers ─────────────────────────────────────────────────────

const NODE_TYPE_LABEL = {
  port:              'Sea Port',
  dryport:           'Inland Container Terminal',
  station:           'Railway Station',
  rail_station:      'Railway Station',
  road_intersection: 'Road Junction',
  rail_intersection: 'Rail Junction',
};

const EDGE_TYPE_LABEL = {
  road:       'Road Segment',
  rail:       'Rail Line',
  intermodal: 'Terminal Access Road',
};

function nodeTypeLabel(type) { return NODE_TYPE_LABEL[type] || (type || '').replace(/_/g, ' '); }
function edgeTypeLabel(mode) { return EDGE_TYPE_LABEL[mode] || mode; }

function riskTierLabel(tier) {
  return { CRITICAL: 'Critical — Avoid Now', HIGH: 'High — Use Caution', MEDIUM: 'Medium — Monitor', LOW: 'Normal Operations' }[tier] || tier;
}

function betweennessToPercent(bc) {
  // bc is normalized 0-1; multiply by known max to get meaningful %
  return Math.round(Math.min((bc || 0) * 100 * 3.24, 100));
}

// ── Color mode ────────────────────────────────────────────────────────────────
function edgeColorExpr(mode) {
  if (mode === 'hazard') return ALERT_LEVEL_EXPR;
  if (mode === 'infra')  return ROAD_TYPE_EXPR;
  return RISK_TIER_EXPR;
}
function nodeColorExpr(mode) {
  if (mode === 'hazard') return ALERT_LEVEL_EXPR;
  if (mode === 'infra')  return NODE_TYPE_EXPR;
  return RISK_TIER_EXPR;
}

// ── Small reusable components ─────────────────────────────────────────────────

function StatusBadge({ tier, size = 'sm' }) {
  const c = TIER_COLOR[tier] || '#6B7280';
  const cls = size === 'lg'
    ? 'px-3.5 py-1.5 rounded-full text-sm font-bold border'
    : 'px-2.5 py-0.5 rounded-full text-xs font-bold border';
  return (
    <span className={cls} style={{ color: c, borderColor: c + '60', backgroundColor: c + '18' }}>
      {tier || 'N/A'}
    </span>
  );
}

function MiniBar({ value, color, label }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-0.5">
        <span className="text-gray-500">{label}</span>
        <span className="font-bold text-slate-800">{Math.round((value || 0) * 100)}%</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.round((value || 0) * 100)}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

// ── LEFT SIDEBAR ──────────────────────────────────────────────────────────────

function LeftSidebar({ colorMode, setColorMode, layers, toggleLayer, filter, setFilter, pipelineStatus }) {
  const { data: kpiHist } = useQuery({
    queryKey: ['kpi-history'],
    queryFn: () => hazardApi.getKpiHistory(24).then(r => r.data),
    refetchInterval: 60000,
  });

  const chartData = useMemo(() => (kpiHist || []).slice(0, 16).reverse().map(k => ({
    t: pipelineTsToLabel(k.timestamp),
    triggered: k.triggered_nodes || 0,
  })), [kpiHist]);

  const lastRunMins = minutesAgoFromTs(pipelineStatus?.last_run);
  const isStale = lastRunMins !== null && lastRunMins > 90;

  return (
    <div className="flex flex-col h-full bg-white border-r border-gray-200 overflow-y-auto" style={{ width: 260 }}>

      {/* Pipeline status */}
      <div className={`px-4 py-3 border-b ${isStale ? 'border-amber-200 bg-amber-50' : 'border-gray-100'}`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">Pipeline</span>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${pipelineStatus?.running ? 'bg-amber-500 animate-pulse' : isStale ? 'bg-amber-400' : 'bg-green-500'}`} />
            <span className="text-xs text-gray-500">{pipelineStatus?.running ? 'Running…' : 'Idle'}</span>
          </div>
        </div>
        <div className="text-xs text-gray-400 mb-2">
          {lastRunMins !== null ? `Updated ${formatRelativeTime(lastRunMins)}` : 'Status unknown'}
          {isStale && <span className="text-amber-600 ml-1">· may be stale</span>}
        </div>
        <div className="w-full py-1.5 bg-gray-50 text-gray-400 border border-gray-100 text-xs font-semibold text-center rounded-lg">
          Runs automatically every 15 mins
        </div>
      </div>

      {/* Color mode */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Map Colors</div>
        <div className="space-y-1">
          {[
            { id: 'risk',   label: 'Risk Level',           sub: 'How dangerous is each location?' },
            { id: 'hazard', label: 'Active Threats',       sub: 'What is threatening right now?' },
            { id: 'infra',  label: 'Infrastructure Type',  sub: 'Road types and facility types' },
          ].map(m => (
            <button key={m.id} onClick={() => setColorMode(m.id)}
              className={`w-full text-left px-3 py-2.5 rounded-xl border transition ${colorMode === m.id ? 'bg-slate-900 border-slate-900 text-white' : 'border-gray-100 hover:border-gray-200 hover:bg-gray-50'}`}>
              <div className={`text-xs font-bold ${colorMode === m.id ? 'text-white' : 'text-slate-800'}`}>{m.label}</div>
              <div className={`text-xs mt-0.5 ${colorMode === m.id ? 'text-white/60' : 'text-gray-400'}`}>{m.sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Layer toggles */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Show on Map</div>
        <div className="space-y-1.5">
          {[
            { key: 'roads',      label: 'Roads',                    color: '#94A3B8', icon: '━' },
            { key: 'rail',       label: 'Railways',                 color: '#1D9E75', icon: '╌' },
            { key: 'ports',      label: 'Sea Ports (3)',            color: '#D85A30', icon: '●' },
            { key: 'dryports',   label: 'Inland Terminals (9)',     color: '#534AB7', icon: '●' },
            { key: 'stations',   label: 'Rail Stations (30)',       color: '#1D9E75', icon: '●' },
            { key: 'hotspots',   label: 'High-Risk Junctions',      color: '#EF9F27', icon: '▲' },
          ].map(l => (
            <button key={l.key} onClick={() => toggleLayer(l.key)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-gray-50 transition">
              <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 text-white text-xs font-bold transition ${layers[l.key] ? '' : 'opacity-30'}`}
                style={{ backgroundColor: l.color }}>
                {layers[l.key] ? '✓' : ''}
              </div>
              <span className={`text-xs font-medium flex-1 text-left ${layers[l.key] ? 'text-slate-800' : 'text-gray-400'}`}>{l.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Alert filter */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Show Locations</div>
        <div className="space-y-1">
          {[
            { id: 'all',       label: 'All locations' },
            { id: 'critical',  label: 'Critical only' },
            { id: 'high',      label: 'High risk & above' },
            { id: 'triggered', label: 'Active alerts only' },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition border ${filter === f.id ? 'bg-slate-900 text-white border-slate-900' : 'border-gray-100 text-gray-600 hover:bg-gray-50'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
          {colorMode === 'risk' ? 'Risk Level (road + ring)' : colorMode === 'hazard' ? 'Threat Level (road + ring)' : 'Infrastructure Types'}
        </div>
        {/* Facility types — always shown */}
        <div className="mb-2 space-y-1">
          <div className="text-xs text-gray-400 font-semibold mb-1">Trade terminals (inner dot)</div>
          {[['#D85A30','🚢 Sea Port (3)'], ['#534AB7','🏭 Inland Terminal (9)'], ['#1D9E75','🚂 Rail Station (30)']].map(([c, l]) => (
            <div key={l} className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full flex-shrink-0 border-2 border-white shadow-sm" style={{ backgroundColor: c }} />
              <span className="text-xs text-gray-600">{l}</span>
            </div>
          ))}
        </div>
        {colorMode !== 'infra' ? (
          <div className="space-y-1">
            <div className="text-xs text-gray-400 font-semibold mb-1">
              {colorMode === 'risk' ? 'Risk tier (outer ring + roads)' : 'Alert level (outer ring + roads)'}
            </div>
            {[
              { tier: 'CRITICAL', desc: 'Avoid' },
              { tier: 'HIGH',     desc: 'Caution' },
              { tier: 'MEDIUM',   desc: 'Monitor' },
              { tier: 'LOW',      desc: 'Normal' },
            ].map(({ tier, desc }) => (
              <div key={tier} className="flex items-center gap-2">
                <div className="w-3 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: TIER_COLOR[tier] }} />
                <span className="text-xs text-gray-600">{tier}</span>
                <span className="text-xs text-gray-400 ml-auto">{desc}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-xs text-gray-400 font-semibold mb-1">Road types</div>
            {[['#D85A30','Motorway'], ['#EF9F27','Trunk Road'], ['#378ADD','Primary Road'], ['#1D9E75','Railway'], ['#94A3B8','Other Roads']].map(([c, l]) => (
              <div key={l} className="flex items-center gap-2">
                <div className="w-4 h-1 rounded flex-shrink-0" style={{ backgroundColor: c }} />
                <span className="text-xs text-gray-600">{l}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hazard trend */}
      {chartData.length > 1 && (
        <div className="px-4 py-3">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Affected Locations (24h)</div>
          <ResponsiveContainer width="100%" height={80}>
            <AreaChart data={chartData} margin={{ top: 2, right: 2, bottom: 2, left: -28 }}>
              <defs>
                <linearGradient id="sideGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#E24B4A" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#E24B4A" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 2" stroke="#f0f0f0" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 7 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 7 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 10, borderRadius: 4, border: '1px solid #e5e7eb', padding: '4px 8px' }} formatter={v => [v, 'Locations affected']} />
              <Area type="monotone" dataKey="triggered" stroke="#E24B4A" fill="url(#sideGrad)" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── RIGHT PANEL: Network Status (default) ─────────────────────────────────────

function TierBar({ label, count, total, color }) {
  const pct = total > 0 ? Math.min((count / total) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 text-xs font-bold flex-shrink-0" style={{ color }}>{label}</div>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="w-12 text-xs text-right font-mono text-gray-600 flex-shrink-0">{(count||0).toLocaleString()}</div>
    </div>
  );
}

function HazardTypeCard({ icon, label, data }) {
  const s = data?.status || 'OK';
  const isOk = s === 'OK';
  const color = s === 'CRITICAL' ? '#E24B4A' : s === 'ACTIVE' || s === 'ELEVATED' ? '#EF9F27' : '#22C55E';
  const pct   = Math.round((data?.max_score || 0) * 100);
  return (
    <div className="rounded-xl border p-2.5" style={{ borderColor: color + '35', backgroundColor: color + '06' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-700 font-semibold">{icon} {label}</span>
        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: color }}>{s}</span>
      </div>
      {!isOk ? (
        <>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-1">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-400">{(data?.triggered || 0).toLocaleString()} locations</span>
            <span className="font-bold" style={{ color }}>{pct}%</span>
          </div>
        </>
      ) : (
        <div className="text-xs text-gray-400 mt-0.5">No active events</div>
      )}
    </div>
  );
}

function NetworkStatusPanel({ onChokepointClick }) {
  const { data: metrics }     = useQuery({ queryKey: ['network-metrics'],   queryFn: () => networkApi.getMetrics().then(r => r.data), staleTime: 300000 });
  const { data: hazSum }      = useQuery({ queryKey: ['hazard-summary'],    queryFn: () => hazardApi.getSummary().then(r => r.data), refetchInterval: 30000 });
  const { data: riskDist }    = useQuery({ queryKey: ['risk-distribution'], queryFn: () => riskApi.getDistribution().then(r => r.data), refetchInterval: 120000 });
  const { data: kpis }        = useQuery({ queryKey: ['kpis-latest'],       queryFn: () => networkApi.getMetrics().then(r => r.data), staleTime: 60000 });
  const { data: chokepoints } = useQuery({ queryKey: ['chokepoints'],       queryFn: () => riskApi.getChokepoints(8).then(r => r.data), refetchInterval: 120000 });

  const nd  = riskDist?.nodes || {};
  const ed  = riskDist?.edges || {};
  const haz = hazSum || {};

  // Hazard alert counts (raw threat from pipeline — how many nodes triggered)
  const hCrit = haz.alert_counts?.CRITICAL || 0;
  const hHigh = haz.alert_counts?.HIGH     || 0;
  const hMed  = haz.alert_counts?.MEDIUM   || 0;
  const hLow  = haz.alert_counts?.LOW      || 0;
  const hTotal = hCrit + hHigh + hMed + hLow || 1;

  // H×E×V composite risk counts (from risk engine, usually lower than hazard)
  const rCrit  = nd.critical || 0;
  const rHigh  = nd.high     || 0;
  const rMed   = nd.medium   || 0;
  const rLow   = nd.low      || 0;
  const rTotal = nd.total || hTotal;

  // Edge risk
  const eCrit  = ed.critical || 0;
  const eHigh  = ed.high     || 0;
  const eMed   = ed.medium   || 0;
  const eLow   = ed.low      || 0;
  const eTotal = ed.total || 1;

  const floodActive   = haz.flood?.status === 'CRITICAL' || haz.flood?.status === 'ACTIVE' || haz.flood?.status === 'ELEVATED';
  const overallStatus = hCrit > 0 ? 'CRITICAL' : hHigh > 0 ? 'HIGH' : hMed > 0 ? 'MEDIUM' : 'OK';
  const statusColor   = TIER_COLOR[overallStatus] || '#22C55E';

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* ── Network overview ── */}
      <div className="p-4 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Network Overview</div>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { label: 'Nodes',      value: (metrics?.total_nodes || 0).toLocaleString() },
            { label: 'Road Links', value: (metrics?.total_edges || 0).toLocaleString() },
            { label: 'Route Km',   value: `${Math.round((metrics?.total_length_km || 0)/1000)}K` },
            { label: 'Avg Time',   value: `${(metrics?.avg_travel_time_hr || 0).toFixed(1)}h` },
            { label: 'Terminals',  value: 42 },
            { label: 'Corridors',  value: 861 },
          ].map(s => (
            <div key={s.label} className="bg-gray-50 rounded-lg p-2 text-center">
              <div className="text-sm font-black text-slate-900">{s.value}</div>
              <div className="text-xs text-gray-400 mt-0.5 leading-tight">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Overall system status banner ── */}
      <div className="px-4 pt-4 pb-0">
        <div className="rounded-xl p-3 border mb-4" style={{ borderColor: statusColor+'30', backgroundColor: statusColor+'08' }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-400 font-semibold mb-0.5">System Status</div>
              <div className="font-black text-base" style={{ color: statusColor }}>
                {overallStatus === 'OK' ? '✅ All Clear' : overallStatus === 'CRITICAL' ? '🔴 Critical Alert' : overallStatus === 'HIGH' ? '🟠 High Alert' : '🟡 Elevated'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-400">Affected nodes</div>
              <div className="text-2xl font-black" style={{ color: statusColor }}>{(hCrit + hHigh).toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── SECTION 1: Live Hazard Pipeline ── */}
      <div className="px-4 pb-4 border-b border-gray-100">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Live Hazard Pipeline</div>
          <div className="flex-1 h-px bg-gray-100" />
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" title="Live data" />
        </div>

        {/* Four hazard type cards */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <HazardTypeCard icon="🌊" label="Flooding"     data={haz.flood}    />
          <HazardTypeCard icon="🌀" label="Cyclone"      data={haz.cyclone}  />
          <HazardTypeCard icon="🚫" label="Strikes & Shutdowns" data={haz.strike}   />
          <HazardTypeCard icon="⚠️" label="Accidents"    data={haz.accident} />
        </div>

        {/* Hazard alert level distribution */}
        <div className="bg-gray-50 rounded-xl p-3 border border-gray-100">
          <div className="text-xs font-semibold text-gray-500 mb-2.5">
            Nodes by Hazard Alert Level
            <span className="font-normal text-gray-400 ml-1">— raw threat score from pipeline</span>
          </div>
          <div className="space-y-2">
            <TierBar label="CRITICAL" count={hCrit} total={hTotal} color={TIER_COLOR.CRITICAL} />
            <TierBar label="HIGH"     count={hHigh} total={hTotal} color={TIER_COLOR.HIGH}     />
            <TierBar label="MEDIUM"   count={hMed}  total={hTotal} color={TIER_COLOR.MEDIUM}   />
            <TierBar label="LOW"      count={hLow}  total={hTotal} color={TIER_COLOR.LOW}      />
          </div>
          {floodActive && (
            <div className="mt-2.5 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2.5 py-1.5">
              🌊 Flood is the primary driver — {haz.flood?.triggered || 0} nodes exposed at {Math.round((haz.flood?.max_score||0)*100)}% max intensity
            </div>
          )}
          {(haz.strike?.triggered > 0 || haz.strike?.status === 'ACTIVE' || haz.strike?.status === 'ELEVATED' || haz.strike?.status === 'CRITICAL') && (
            <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              🚫 Strike / Shutdown active — {haz.strike?.triggered || 0} locations affected · {Math.round((haz.strike?.max_score||0)*100)}% severity
              {haz.strike?.max_score >= 0.5 && <div className="font-bold mt-0.5">⚠ City shutdown or major disruption detected</div>}
            </div>
          )}
          {(haz.accident?.triggered > 0) && (
            <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2.5 py-1.5">
              ⚠️ Accident alert — {haz.accident?.triggered || 0} locations affected · {Math.round((haz.accident?.max_score||0)*100)}% severity
            </div>
          )}
        </div>
      </div>

      {/* ── SECTION 2: Risk Engine H×E×V ── */}
      <div className="px-4 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Risk Engine (H×E×V)</div>
          <div className="flex-1 h-px bg-gray-100" />
        </div>
        <div className="text-xs text-gray-400 mb-2.5 leading-relaxed">
          Composite risk = Hazard × Exposure × Vulnerability (UNDRR formula).
          A location can have HIGH hazard but LOW risk if it has low exposure or high resilience.
        </div>

        {/* Explain gap between hazard and risk */}
        {hCrit > 0 && rCrit === 0 && (
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 mb-3 text-xs text-blue-700">
            <div className="font-bold mb-1">ℹ Why hazard ≠ risk here</div>
            <div className="leading-relaxed">
              Hazard pipeline shows <strong>{hCrit.toLocaleString()} CRITICAL nodes</strong> (high flood exposure).
              The risk engine outputs LOW because exposure and vulnerability scores moderate the composite risk
              below the HIGH threshold. Switch to <strong>Hazard color mode</strong> to see raw threat on the map.
            </div>
          </div>
        )}

        <div className="bg-gray-50 rounded-xl p-3 border border-gray-100 mb-3">
          <div className="text-xs font-semibold text-gray-500 mb-2.5">Facility & Junction Nodes</div>
          <div className="space-y-2">
            <TierBar label="CRITICAL" count={rCrit} total={rTotal} color={TIER_COLOR.CRITICAL} />
            <TierBar label="HIGH"     count={rHigh} total={rTotal} color={TIER_COLOR.HIGH}     />
            <TierBar label="MEDIUM"   count={rMed}  total={rTotal} color={TIER_COLOR.MEDIUM}   />
            <TierBar label="LOW"      count={rLow}  total={rTotal} color={TIER_COLOR.LOW}      />
          </div>
          {nd.max_risk > 0 && (
            <div className="flex justify-between text-xs mt-2 pt-2 border-t border-gray-100 text-gray-400">
              <span>Max composite risk</span>
              <span className="font-bold text-slate-700">{Math.round((nd.max_risk||0)*100)}%</span>
            </div>
          )}
          {nd.avg_risk > 0 && (
            <div className="flex justify-between text-xs text-gray-400">
              <span>Avg composite risk</span>
              <span className="font-bold text-slate-700">{Math.round((nd.avg_risk||0)*100)}%</span>
            </div>
          )}
        </div>

        {/* Road & Rail edge risk */}
        {eTotal > 1 && (
          <div className="bg-gray-50 rounded-xl p-3 border border-gray-100">
            <div className="text-xs font-semibold text-gray-500 mb-2.5">Road & Rail Segments</div>
            <div className="space-y-1.5">
              {[['CRITICAL', eCrit, TIER_COLOR.CRITICAL], ['HIGH', eHigh, TIER_COLOR.HIGH], ['MEDIUM', eMed, TIER_COLOR.MEDIUM], ['LOW', eLow, TIER_COLOR.LOW]].map(([lbl, cnt, clr]) =>
                cnt > 0 ? <TierBar key={lbl} label={lbl} count={cnt} total={eTotal} color={clr} /> : null
              )}
            </div>
          </div>
        )}

        {nd.chokepoints > 0 && (
          <div className="mt-2.5 text-xs text-orange-700 bg-orange-50 rounded-xl px-3 py-2 font-medium border border-orange-100">
            ⚠ {nd.chokepoints} strategic chokepoint{nd.chokepoints > 1 ? 's' : ''} — high betweenness centrality + elevated risk
          </div>
        )}
      </div>

      {/* ── SECTION 3: Key Chokepoints ── */}
      {chokepoints?.length > 0 && (
        <div className="p-4">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Key Strategic Locations</div>
          <div className="text-xs text-gray-400 mb-2.5">Highest network centrality — click to fly map</div>
          <div className="space-y-1">
            {chokepoints.map((cp, i) => {
              const tc = TIER_COLOR[cp.risk_tier] || '#6B7280';
              return (
                <button key={cp.asset_id} onClick={() => onChokepointClick && onChokepointClick(cp)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl hover:bg-gray-50 transition text-left border border-transparent hover:border-gray-200 group">
                  <div className="text-xs font-bold text-gray-300 w-4 flex-shrink-0">{i + 1}</div>
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 border border-white shadow-sm" style={{ backgroundColor: tc }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-slate-800 truncate group-hover:text-slate-900">{cp.name || resolveNodeName(cp)}</div>
                    <div className="text-xs text-gray-400">{nodeTypeLabel(cp.node_type)}</div>
                  </div>
                  <div className="flex-shrink-0">
                    <StatusBadge tier={cp.risk_tier} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── RIGHT PANEL: Location Detail (on click) ───────────────────────────────────

function LocationDetailPanel({ location, onClose, onFlyTo }) {
  const p = location;
  const displayName = resolveNodeName(p);
  const isFacility = ['port', 'dryport', 'station', 'rail_station'].includes(p.node_type);

  // Disruption impact — only for facilities (meaningful for supply chain)
  const { data: disruption, isLoading: disruptionLoading } = useQuery({
    queryKey: ['disruption', p.asset_id],
    queryFn: () => networkApi.getDisruptionImpact(p.asset_id, 'node').then(r => r.data),
    enabled: isFacility && !!p.asset_id,
    staleTime: 120000,
  });

  const routesPct = betweennessToPercent(p.betweenness_centrality);
  const riskPct   = Math.round((p.composite_risk || 0) * 100);
  const hazardPct = Math.round((p.composite_hazard || 0) * 100);
  const netRiskPct = Math.round((p.network_criticality_risk || 0) * 100);

  return (
    <div className="flex flex-col h-full bg-white overflow-y-auto">

      {/* Header */}
      <div className="p-4 border-b border-gray-100 bg-gradient-to-b from-gray-50 to-white">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-base font-black text-slate-900 leading-tight">{displayName}</div>
            <div className="text-xs text-gray-400 mt-0.5">{nodeTypeLabel(p.node_type)}</div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {p.risk_tier && <StatusBadge tier={p.risk_tier} size="lg" />}
              {p.is_chokepoint && (
                <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-700 border border-orange-200">
                  ⚠ Chokepoint
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-600 text-2xl leading-none flex-shrink-0">×</button>
        </div>
        <div className="mt-2 text-xs text-gray-300 font-mono">{p.asset_id}</div>
      </div>

      {/* Network position */}
      <div className="p-4 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Network Position</div>
        <div className="space-y-2.5">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-600 font-medium">Freight routes passing through</span>
              <span className="font-bold text-slate-800">{routesPct}%</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${routesPct}%` }} />
            </div>
            {routesPct > 20 && <div className="text-xs text-blue-600 mt-1">⚠ High connectivity — many routes depend on this location</div>}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center mt-2">
            <div className="bg-gray-50 rounded-lg p-2">
              <div className="text-sm font-black text-slate-900">{p.importance_index || 1}/5</div>
              <div className="text-xs text-gray-400">Importance</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-2">
              <div className="text-sm font-black text-slate-900">{p.handling_capacity_index || 1}/5</div>
              <div className="text-xs text-gray-400">Capacity</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-2">
              <div className="text-sm font-black text-slate-900">{p.redundancy_index || 0}/3</div>
              <div className="text-xs text-gray-400">Alternatives</div>
            </div>
          </div>
        </div>
      </div>

      {/* Hazard pipeline — live threat scores */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Hazard Pipeline — Live Threats</div>
          {p.alert_level && (
            <span className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ backgroundColor: (TIER_COLOR[p.alert_level] || '#6B7280') + '20', color: TIER_COLOR[p.alert_level] || '#6B7280' }}>
              {p.alert_level}
            </span>
          )}
        </div>
        <div className="space-y-2">
          {[
            { key: 'hazard_flood',    label: '🌊 Flooding',        color: '#378ADD' },
            { key: 'hazard_cyclone',  label: '🌀 Cyclone / Storm', color: '#534AB7' },
            { key: 'hazard_strike',   label: '🚫 Strike / Shutdown', color: '#EF9F27' },
            { key: 'hazard_accident', label: '⚠️ Accidents',       color: '#E24B4A' },
          ].map(({ key, label, color }) => {
            const val = p[key] || 0;
            const pct = Math.round(val * 100);
            return (
              <div key={key}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-gray-600">{label}</span>
                  <span className="font-bold text-slate-800">{pct}%</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2.5 flex items-center justify-between pt-2.5 border-t border-gray-100">
          <span className="text-xs text-gray-500">Combined threat (Noisy-OR)</span>
          <div className="flex items-center gap-2">
            <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${hazardPct}%`, backgroundColor: TIER_COLOR[p.alert_level] || '#EF9F27' }} />
            </div>
            <span className="text-sm font-black text-slate-900">{hazardPct}%</span>
          </div>
        </div>
      </div>

      {/* Risk Engine — H × E × V output */}
      <div className="p-4 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Risk Engine — H × E × V</div>
        <div className="text-xs text-gray-400 mb-3">UNDRR formula: Hazard × Exposure × Vulnerability</div>
        <div className="space-y-2">
          {[
            { rk: 'risk_flood',    hk: 'hazard_flood',    label: '🌊 Flood risk',   color: '#378ADD' },
            { rk: 'risk_cyclone',  hk: 'hazard_cyclone',  label: '🌀 Cyclone risk', color: '#534AB7' },
            { rk: 'risk_strike',   hk: 'hazard_strike',   label: '🚫 Strike risk',  color: '#EF9F27' },
            { rk: 'risk_accident', hk: 'hazard_accident', label: '⚠️ Accident risk',color: '#E24B4A' },
          ].map(({ rk, hk, label, color }) => {
            const riskVal = p[rk] || 0;
            const hazVal  = p[hk] || 0;
            const rPct = Math.round(riskVal * 100);
            const hPct = Math.round(hazVal * 100);
            return (
              <div key={rk} className="bg-gray-50 rounded-lg px-2.5 py-2">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600 font-medium">{label}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-400">hazard {hPct}%</span>
                    <span className="text-gray-300">→</span>
                    <span className="font-black text-slate-800">{rPct}%</span>
                  </div>
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${rPct}%`, backgroundColor: color }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Composite risk score</span>
            <div className="flex items-center gap-2">
              <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${riskPct}%`, backgroundColor: TIER_COLOR[p.risk_tier] || '#6B7280' }} />
              </div>
              <span className="text-sm font-black" style={{ color: TIER_COLOR[p.risk_tier] || '#6B7280' }}>{riskPct}%</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Network criticality risk</span>
            <div className="flex items-center gap-2">
              <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-purple-500" style={{ width: `${netRiskPct}%` }} />
              </div>
              <span className="text-sm font-black text-purple-700">{netRiskPct}%</span>
            </div>
          </div>
        </div>
        {p.is_chokepoint && (
          <div className="mt-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-xs text-orange-700">
            <span className="font-bold">⚠ Network Chokepoint:</span> High risk × high betweenness centrality.
            Failure here disrupts many trade corridors.
          </div>
        )}
      </div>

      {/* Disruption impact (facility only) */}
      {isFacility && (
        <div className="p-4 border-b border-gray-100">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">
            If This Location Closes Today
          </div>
          {disruptionLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-4">
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Calculating disruption impact…
            </div>
          ) : disruption ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className={`rounded-xl p-3 text-center ${(disruption.total_affected || 0) > 10 ? 'bg-red-50 border border-red-200' : 'bg-gray-50'}`}>
                  <div className={`text-2xl font-black ${(disruption.total_affected || 0) > 10 ? 'text-red-600' : 'text-slate-800'}`}>
                    {disruption.total_affected || 0}
                  </div>
                  <div className="text-xs text-gray-500">Trade routes affected</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <div className="text-2xl font-black text-slate-800">
                    {(disruption.top_impacts || []).filter(i => i.status === 'UNREACHABLE').length}
                  </div>
                  <div className="text-xs text-gray-500">Routes cut off completely</div>
                </div>
              </div>

              {disruption.top_impacts?.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-500 mb-1.5">Most affected routes:</div>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {disruption.top_impacts.slice(0, 5).map((imp, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-gray-50 last:border-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${imp.status === 'UNREACHABLE' ? 'bg-red-500' : 'bg-amber-400'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-slate-700 truncate">
                            {imp.source_name || imp.source} → {imp.target_name || imp.target}
                          </div>
                        </div>
                        <div className={`flex-shrink-0 font-bold ${imp.status === 'UNREACHABLE' ? 'text-red-600' : 'text-amber-600'}`}>
                          {imp.status === 'UNREACHABLE' ? 'CUT OFF' : `+${(imp.delay_pct || 0).toFixed(0)}%`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-400 py-2">Disruption data unavailable</div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="p-4 space-y-2">
        <Link to={`/routes?from=${p.asset_id}`}
          className="flex items-center justify-center gap-2 w-full bg-slate-900 hover:bg-slate-700 text-white text-sm font-bold py-2.5 rounded-xl transition">
          🛣️ Find Safe Route From Here
        </Link>
        <Link to={`/scenario?target=${p.asset_id}`}
          className="flex items-center justify-center gap-2 w-full border border-orange-200 hover:bg-orange-50 text-orange-700 text-sm font-bold py-2.5 rounded-xl transition">
          ⚡ Simulate This Location Closing
        </Link>
        <Link to={`/asset/${p.asset_id}`}
          className="flex items-center justify-center gap-2 w-full border border-gray-200 hover:bg-gray-50 text-gray-600 text-sm font-bold py-2.5 rounded-xl transition">
          📊 Full Location Profile
        </Link>
      </div>
    </div>
  );
}

// ── RIGHT PANEL: Road Detail (on edge click) ──────────────────────────────────

function RoadDetailPanel({ edge, onClose }) {
  if (!edge) return null;
  const p = edge;
  const riskPct   = Math.round((p.composite_risk || 0) * 100);
  const hazPct    = Math.round((p.composite_hazard || 0) * 100);
  const netRisk   = Math.round((p.network_criticality_risk || 0) * 100);
  const lengthKm  = (p.length_km || 0).toFixed(1);
  const timeMin   = Math.round((p.travel_time_hr || 0) * 60);
  const speed     = p.avg_speed_kmh || 0;
  const roadName  = (p.road_type || '').replace(/_/g, ' ') || 'Road';

  return (
    <div className="flex flex-col h-full bg-white overflow-y-auto">
      <div className="p-4 border-b border-gray-100 bg-gradient-to-b from-gray-50 to-white">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-base font-black text-slate-900 capitalize">{roadName}</div>
            <div className="text-xs text-gray-400 mt-0.5">{edgeTypeLabel(p.mode)}</div>
            <div className="mt-2">
              {p.risk_tier && <StatusBadge tier={p.risk_tier} size="lg" />}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-600 text-2xl">×</button>
        </div>
      </div>

      <div className="p-4 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Route Details</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-lg font-black text-slate-900">{lengthKm}<span className="text-xs font-normal text-gray-400"> km</span></div>
            <div className="text-xs text-gray-400">Length</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-lg font-black text-slate-900">{timeMin}<span className="text-xs font-normal text-gray-400"> min</span></div>
            <div className="text-xs text-gray-400">Travel time</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-lg font-black text-slate-900">{speed}<span className="text-xs font-normal text-gray-400"> km/h</span></div>
            <div className="text-xs text-gray-400">Speed</div>
          </div>
        </div>
      </div>

      {/* Hazard pipeline scores */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Hazard Pipeline</div>
          {p.alert_level && (
            <span className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ backgroundColor: (TIER_COLOR[p.alert_level] || '#6B7280') + '20', color: TIER_COLOR[p.alert_level] || '#6B7280' }}>
              {p.alert_level}
            </span>
          )}
        </div>
        <div className="space-y-1.5">
          <MiniBar value={p.hazard_flood}    color="#378ADD" label="🌊 Flood" />
          <MiniBar value={p.hazard_cyclone}  color="#534AB7" label="🌀 Cyclone" />
          <MiniBar value={p.hazard_strike}   color="#EF9F27" label="🚫 Strike / Shutdown" />
          <MiniBar value={p.hazard_accident} color="#E24B4A" label="⚠️ Accident" />
        </div>
        {p.any_trigger && (
          <div className="mt-2 text-xs text-red-600 bg-red-50 rounded-lg px-2.5 py-1.5 border border-red-100">
            ● Hazard threshold exceeded — this edge is actively triggered
          </div>
        )}
      </div>

      {/* Risk engine output */}
      <div className="p-4 border-b border-gray-100">
        <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Risk Engine (H × E × V)</div>
        <div className="space-y-1.5">
          <MiniBar value={p.risk_flood}    color="#378ADD" label="Flood risk" />
          <MiniBar value={p.risk_cyclone}  color="#534AB7" label="Cyclone risk" />
          <MiniBar value={p.risk_strike}   color="#EF9F27" label="Strike risk" />
          <MiniBar value={p.risk_accident} color="#E24B4A" label="Accident risk" />
        </div>
        <div className="mt-2.5 pt-2.5 border-t border-gray-100 space-y-1.5">
          <MiniBar value={p.composite_risk}           color={TIER_COLOR[p.risk_tier] || '#6B7280'} label="Composite risk" />
          <MiniBar value={p.network_criticality_risk} color="#8B5CF6" label="Network criticality" />
        </div>
        {netRisk > 20 && (
          <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
            <div className="font-bold mb-0.5">High-impact corridor</div>
            Significant freight traffic uses this segment. Disruption here would affect many trade routes.
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="text-xs text-gray-400 mb-2">Based on this road's risk:</div>
        <Link to="/routes"
          className="flex items-center justify-center gap-2 w-full bg-slate-900 hover:bg-slate-700 text-white text-sm font-bold py-2.5 rounded-xl transition">
          🛣️ Find Routes That Avoid This Road
        </Link>
      </div>
    </div>
  );
}

// ── TIME SLIDER ───────────────────────────────────────────────────────────────

function TimeSlider({ timestamps, currentIdx, onChange, isLoading }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed]     = useState(1500); // ms per frame
  const timerRef = useRef(null);
  const max = Math.max(timestamps.length - 1, 0);
  const ts = timestamps[currentIdx] || timestamps[0] || '';
  const pct = max > 0 ? (currentIdx / max) * 100 : 0;

  // Auto-play
  useEffect(() => {
    if (!playing) return;
    timerRef.current = setInterval(() => {
      onChange(i => {
        if (i >= max) { setPlaying(false); return max; }
        return i + 1;
      });
    }, speed);
    return () => clearInterval(timerRef.current);
  }, [playing, speed, max, onChange]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); onChange(i => Math.max(0, (typeof i === 'number' ? i : currentIdx) - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); onChange(i => Math.min(max, (typeof i === 'number' ? i : currentIdx) + 1)); }
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [max, currentIdx, onChange]);

  if (!timestamps?.length) return null;

  const speeds = [
    { ms: 2500, label: '0.5×' },
    { ms: 1500, label: '1×' },
    { ms: 800,  label: '2×' },
    { ms: 400,  label: '4×' },
  ];

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20">
      {/* Glassmorphic bar */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.88))',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }} className="px-5 py-3">

        {/* Top row: controls + timestamp */}
        <div className="flex items-center gap-3 mb-2.5">
          {/* Playback controls */}
          <div className="flex items-center gap-1">
            <button onClick={() => onChange(i => Math.max(0, (typeof i === 'number' ? i : currentIdx) - 1))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition"
              title="Previous (←)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button onClick={() => setPlaying(p => !p)}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition shadow-lg"
              style={{ background: playing ? 'linear-gradient(135deg, #F59E0B, #EF4444)' : 'linear-gradient(135deg, #F59E0B, #F97316)' }}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}>
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
              )}
            </button>
            <button onClick={() => onChange(i => Math.min(max, (typeof i === 'number' ? i : currentIdx) + 1))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition"
              title="Next (→)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
          </div>

          {/* Speed selector */}
          <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
            {speeds.map(s => (
              <button key={s.ms} onClick={() => setSpeed(s.ms)}
                className={`px-2 py-1 rounded-md text-xs font-bold transition ${speed === s.ms ? 'bg-amber-500 text-white shadow' : 'text-white/40 hover:text-white/70'}`}>
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Timestamp display */}
          <div className="flex items-center gap-2">
            {isLoading && (
              <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            )}
            <div className="bg-white/8 border border-white/10 rounded-lg px-3 py-1.5 min-w-[150px] text-center">
              <div className="text-xs font-mono text-white font-bold tracking-wide">
                {isLoading ? 'Loading…' : pipelineTsToLabel(ts)}
              </div>
            </div>
          </div>

          {/* Counter */}
          <div className="text-xs text-white/30 font-mono flex-shrink-0 min-w-[50px] text-right">
            {currentIdx + 1}<span className="text-white/15">/{timestamps.length}</span>
          </div>
        </div>

        {/* Slider track */}
        <div className="relative group">
          {/* Custom track background */}
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-200 ease-out"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(90deg, #F59E0B, #EF4444)',
              }} />
          </div>

          {/* Tick marks for each timestamp */}
          {timestamps.length <= 60 && (
            <div className="absolute inset-0 flex items-center pointer-events-none">
              {timestamps.map((_, i) => (
                <div key={i} className="absolute h-1 w-px bg-white/15"
                  style={{ left: `${(i / max) * 100}%` }} />
              ))}
            </div>
          )}

          {/* Thumb indicator */}
          <div className="absolute top-1/2 -translate-y-1/2 pointer-events-none transition-all duration-200 ease-out"
            style={{ left: `${pct}%`, transform: `translateX(-50%) translateY(-50%)` }}>
            <div className="w-3.5 h-3.5 rounded-full bg-amber-400 shadow-lg shadow-amber-500/40 border-2 border-white group-hover:scale-125 transition-transform" />
          </div>

          {/* Invisible native range for smooth interaction */}
          <input type="range" min={0} max={max} value={currentIdx}
            onChange={e => { setPlaying(false); onChange(+e.target.value); }}
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
            style={{ height: '24px', marginTop: '-10px' }} />
        </div>
      </div>
    </div>
  );
}

// ── MAP COMPONENT ─────────────────────────────────────────────────────────────

function RiskNetworkMap({ colorMode, layers, filter, onLocationSelect, onRoadSelect, historyNodes, onMapReady }) {
  const mapEl  = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [roadProgress, setRoadProgress] = useState(null);

  // Facility nodes — refresh every 2 min so colors update after pipeline runs
  const { data: facilityNodes } = useQuery({
    queryKey: ['combined-facilities'],
    queryFn: () => combinedApi.getNodes({ type: 'port,dryport,station,rail_station' }).then(r => r.data),
    refetchInterval: 120000,
  });
  const { data: pkBound }      = useQuery({ queryKey: ['pakistan-boundary'], queryFn: () => networkApi.getPakistanBoundary().then(r => r.data).catch(() => null), staleTime: Infinity });
  // Hotspots: fetch ALL junctions — LOW/no-hazard ones show green, elevated ones show amber/red
  // alert_level filter removed so zero-hazard nodes still appear on the map as green dots
  const { data: hotspotNodes } = useQuery({ queryKey: ['combined-hotspots'], queryFn: () => combinedApi.getNodes({ type: 'road_intersection,rail_intersection' }).then(r => r.data), refetchInterval: 120000 });

  // Init map
  useEffect(() => {
    if (mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: mapEl.current,
      style: `https://api.maptiler.com/maps/topo/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [68, 30], zoom: 5, antialias: true,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    mapRef.current.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    mapRef.current.on('load', () => { setReady(true); if (onMapReady) onMapReady(mapRef.current); });
  }, [onMapReady]);

  // Pakistan boundary
  useEffect(() => {
    if (!ready || !pkBound || mapRef.current.getSource('pk')) return;
    mapRef.current.addSource('pk', { type: 'geojson', data: pkBound });
    mapRef.current.addLayer({ id: 'pk-fill', type: 'fill', source: 'pk', paint: { 'fill-color': '#e8f4f8', 'fill-opacity': 0.12 } });
    mapRef.current.addLayer({ id: 'pk-line', type: 'line', source: 'pk', paint: { 'line-color': '#334155', 'line-width': 1.5, 'line-opacity': 0.6 } });
  }, [pkBound, ready]);

  // Road edges — cached progressive load
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const setupLayer = (feats) => {
      const fc = { type: 'FeatureCollection', features: feats };
      if (!mapRef.current.getSource('roads')) {
        mapRef.current.addSource('roads', { type: 'geojson', data: fc });
        mapRef.current.addLayer({
          id: 'roads-layer', type: 'line', source: 'roads',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': RISK_TIER_EXPR,
            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 2.5],
            'line-opacity': 0.7,
          },
        });
        mapRef.current.on('click', 'roads-layer', e => { if (e.features?.[0]) onRoadSelect(e.features[0].properties); });
        mapRef.current.on('mouseenter', 'roads-layer', () => { mapRef.current.getCanvas().style.cursor = 'pointer'; });
        mapRef.current.on('mouseleave', 'roads-layer', () => { mapRef.current.getCanvas().style.cursor = ''; });
      } else {
        mapRef.current.getSource('roads').setData(fc);
      }
    };
    const cached = cacheGet('road');
    if (cached) { setupLayer(cached); return; }
    (async () => {
      setupLayer([]);
      let feats = [], offset = 0, total = null;
      while (!cancelled) {
        const r = await combinedApi.getEdges({ mode: 'road', limit: 2000, offset }).catch(() => null);
        if (!r?.data?.features?.length) break;
        feats = feats.concat(r.data.features);
        if (total === null) total = r.data.pagination?.total ?? null;
        setRoadProgress({ loaded: feats.length, total });
        if (mapRef.current?.getSource('roads')) {
          mapRef.current.getSource('roads').setData({ type: 'FeatureCollection', features: feats });
        }
        offset += 2000;
        if ((r.data.pagination?.returned ?? r.data.features.length) < 2000) break;
      }
      if (!cancelled) { cacheSet('road', feats); setRoadProgress(null); }
    })();
    return () => { cancelled = true; };
  }, [ready]);

  // Rail — cached
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const add = (feats) => {
      const fc = { type: 'FeatureCollection', features: feats };
      if (mapRef.current.getSource('rail')) { mapRef.current.getSource('rail').setData(fc); return; }
      mapRef.current.addSource('rail', { type: 'geojson', data: fc });
      mapRef.current.addLayer({
        id: 'rail-layer', type: 'line', source: 'rail',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': RISK_TIER_EXPR, 'line-width': 3, 'line-opacity': 0.75, 'line-dasharray': [5, 3] },
      });
      mapRef.current.on('click', 'rail-layer', e => { if (e.features?.[0]) onRoadSelect(e.features[0].properties); });
      mapRef.current.on('mouseenter', 'rail-layer', () => { mapRef.current.getCanvas().style.cursor = 'pointer'; });
      mapRef.current.on('mouseleave', 'rail-layer', () => { mapRef.current.getCanvas().style.cursor = ''; });
    };
    const cached = cacheGet('rail');
    if (cached) { add(cached); return; }
    combinedApi.getEdges({ mode: 'rail' }).then(r => {
      if (!cancelled && r?.data?.features) { cacheSet('rail', r.data.features); add(r.data.features); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [ready]);

  // Intermodal — cached, hidden by default
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const add = (feats) => {
      const fc = { type: 'FeatureCollection', features: feats };
      if (mapRef.current.getSource('intermodal')) { mapRef.current.getSource('intermodal').setData(fc); return; }
      mapRef.current.addSource('intermodal', { type: 'geojson', data: fc });
      mapRef.current.addLayer({
        id: 'intermodal-layer', type: 'line', source: 'intermodal',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#EF9F27', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [3, 2] },
      });
    };
    const cached = cacheGet('intermodal');
    if (cached) { add(cached); return; }
    combinedApi.getEdges({ mode: 'intermodal' }).then(r => {
      if (!cancelled && r?.data?.features) { cacheSet('intermodal', r.data.features); add(r.data.features); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [ready]);

  // Hotspot junctions — colored by HAZARD alert level (not risk tier, which is all LOW)
  useEffect(() => {
    if (!ready || !hotspotNodes) return;
    if (mapRef.current.getSource('hotspots')) { mapRef.current.getSource('hotspots').setData(hotspotNodes); return; }
    mapRef.current.addSource('hotspots', { type: 'geojson', data: hotspotNodes });

    // Pulse halo for CRITICAL nodes
    mapRef.current.addLayer({
      id: 'hotspots-halo', type: 'circle', source: 'hotspots',
      filter: ['==', ['get', 'alert_level'], 'CRITICAL'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 10, 12, 20],
        'circle-color': ALERT_LEVEL_EXPR, 'circle-opacity': 0.18,
        'circle-stroke-width': 0,
      },
    });

    mapRef.current.addLayer({
      id: 'hotspots-layer', type: 'circle', source: 'hotspots',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          4, ['match', ['get', 'alert_level'], 'CRITICAL', 4, 3],
          10, ['match', ['get', 'alert_level'], 'CRITICAL', 9, 6],
        ],
        'circle-color': ALERT_LEVEL_EXPR,
        'circle-opacity': ['match', ['get', 'alert_level'], 'CRITICAL', 0.92, 0.70],
        'circle-stroke-width': ['match', ['get', 'alert_level'], 'CRITICAL', 2, 1],
        'circle-stroke-color': '#fff',
      },
    });
    mapRef.current.on('click', 'hotspots-layer', e => { if (e.features?.[0]) onLocationSelect(e.features[0].properties); });
    mapRef.current.on('mouseenter', 'hotspots-layer', () => { mapRef.current.getCanvas().style.cursor = 'pointer'; });
    mapRef.current.on('mouseleave', 'hotspots-layer', () => { mapRef.current.getCanvas().style.cursor = ''; });
  }, [hotspotNodes, ready]);

  // Facility nodes — color by type when in infrastructure mode, by risk otherwise
  useEffect(() => {
    if (!ready || !facilityNodes) return;
    if (mapRef.current.getSource('facilities')) { mapRef.current.getSource('facilities').setData(facilityNodes); return; }
    mapRef.current.addSource('facilities', { type: 'geojson', data: facilityNodes });

    // Type-color expression: port=coral, dryport=purple, station/rail_station=teal
    const typeColorExpr = [
      'match', ['get', 'node_type'],
      'port',        '#D85A30',
      'dryport',     '#534AB7',
      'station',     '#1D9E75',
      'rail_station','#1D9E75',
      '#64748B',
    ];

    // Ring shows risk tier; inner circle shows facility type
    mapRef.current.addLayer({ id: 'fac-glow', type: 'circle', source: 'facilities',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 16, 12, 40],
               'circle-color': RISK_TIER_EXPR, 'circle-opacity': 0.13, 'circle-stroke-width': 0 } });

    // Risk-tier border ring
    mapRef.current.addLayer({ id: 'fac-ring', type: 'circle', source: 'facilities',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 10, 12, 18],
               'circle-color': RISK_TIER_EXPR, 'circle-opacity': 0.5,
               'circle-stroke-width': 0 } });

    // Type-colored solid circle on top
    mapRef.current.addLayer({ id: 'fac-circle', type: 'circle', source: 'facilities',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 7, 12, 14],
               'circle-color': typeColorExpr, 'circle-opacity': 1,
               'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff' } });

    mapRef.current.addLayer({ id: 'fac-labels', type: 'symbol', source: 'facilities',
      layout: { 'text-field': ['coalesce', ['get', 'display_name'], ['get', 'name'], ['get', 'asset_id']],
                'text-size': 11, 'text-offset': [0, 1.8], 'text-anchor': 'top', 'text-optional': true,
                'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'] },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 },
      minzoom: 4 });

    mapRef.current.on('click', 'fac-circle', e => { if (e.features?.[0]) onLocationSelect(e.features[0].properties); });
    mapRef.current.on('mouseenter', 'fac-circle', () => { mapRef.current.getCanvas().style.cursor = 'pointer'; });
    mapRef.current.on('mouseleave', 'fac-circle', () => { mapRef.current.getCanvas().style.cursor = ''; });
  }, [facilityNodes, ready]);

  // History overlay
  useEffect(() => {
    if (!ready) return;
    if (!historyNodes?.features?.length) {
      if (mapRef.current.getSource('hist')) mapRef.current.getSource('hist').setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    if (!mapRef.current.getSource('hist')) {
      mapRef.current.addSource('hist', { type: 'geojson', data: historyNodes });
      mapRef.current.addLayer({ id: 'hist-layer', type: 'circle', source: 'hist',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 12, 8], 'circle-color': ALERT_LEVEL_EXPR, 'circle-opacity': 0.80, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' } });
    } else {
      mapRef.current.getSource('hist').setData(historyNodes);
    }
  }, [historyNodes, ready]);

  // Color mode switch — hotspots always use alert_level (hazard) color
  useEffect(() => {
    if (!ready) return;
    const ec = edgeColorExpr(colorMode), nc = nodeColorExpr(colorMode);
    ['roads-layer', 'rail-layer'].forEach(id => {
      if (mapRef.current.getLayer(id)) mapRef.current.setPaintProperty(id, 'line-color', ec);
    });
    // Facility risk ring updates with color mode
    ['fac-glow', 'fac-ring'].forEach(id => {
      if (mapRef.current.getLayer(id)) mapRef.current.setPaintProperty(id, 'circle-color', nc);
    });
    // Hotspots always stay hazard-colored (they represent live threat, not computed risk)
    // so we don't change their color on mode switch
  }, [colorMode, ready]);

  // Layer visibility
  useEffect(() => {
    if (!ready) return;
    const vis = on => on ? 'visible' : 'none';
    if (mapRef.current.getLayer('roads-layer'))    mapRef.current.setLayoutProperty('roads-layer',    'visibility', vis(layers.roads));
    if (mapRef.current.getLayer('rail-layer'))     mapRef.current.setLayoutProperty('rail-layer',     'visibility', vis(layers.rail));
    ['hotspots-halo', 'hotspots-layer'].forEach(id => {
      if (mapRef.current.getLayer(id)) mapRef.current.setLayoutProperty(id, 'visibility', vis(layers.hotspots));
    });
    const showFac = layers.ports || layers.dryports || layers.stations;
    ['fac-glow', 'fac-ring', 'fac-circle', 'fac-labels'].forEach(id => {
      if (mapRef.current.getLayer(id)) mapRef.current.setLayoutProperty(id, 'visibility', vis(showFac));
    });
  }, [layers, ready]);

  // Node filter — applied when user clicks filter buttons in left sidebar
  useEffect(() => {
    if (!ready) return;
    const FAC_LAYERS    = ['fac-glow', 'fac-ring', 'fac-circle', 'fac-labels'];
    const HOTSPOT_LAYERS = ['hotspots-halo', 'hotspots-layer'];

    // Build the MapLibre filter expression based on filter mode
    let expr = null; // null = no filter (show all)
    if (filter === 'critical') {
      // Show only nodes with CRITICAL alert level or very high composite_hazard
      expr = ['any',
        ['==', ['get', 'alert_level'], 'CRITICAL'],
        ['>=', ['coalesce', ['get', 'composite_hazard'], 0], 0.75],
      ];
    } else if (filter === 'high') {
      expr = ['any',
        ['in', ['get', 'alert_level'], ['literal', ['CRITICAL', 'HIGH']]],
        ['>=', ['coalesce', ['get', 'composite_hazard'], 0], 0.40],
      ];
    } else if (filter === 'triggered') {
      expr = ['>', ['coalesce', ['get', 'composite_hazard'], 0], 0.05];
    }

    FAC_LAYERS.forEach(id => {
      if (mapRef.current.getLayer(id)) {
        mapRef.current.setFilter(id, expr);
      }
    });
    HOTSPOT_LAYERS.forEach(id => {
      if (mapRef.current.getLayer(id)) {
        // Hotspots already filtered by CRITICAL/HIGH; for 'all' and 'triggered' show them, else null
        mapRef.current.setFilter(id, filter === 'critical'
          ? ['==', ['get', 'alert_level'], 'CRITICAL']
          : null);
      }
    });
  }, [filter, ready]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapEl} className="absolute inset-0" />

      {/* Road loading bar */}
      {roadProgress && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-white rounded-xl shadow-lg border border-gray-100 px-4 py-2 text-xs text-gray-600 flex items-center gap-3" style={{ minWidth: 280 }}>
          <svg className="animate-spin w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div className="flex-1">
            <div className="flex justify-between mb-0.5">
              <span>Loading road network…</span>
              <span className="font-mono font-bold text-slate-700">{roadProgress.loaded.toLocaleString()}{roadProgress.total ? ` / ${roadProgress.total.toLocaleString()}` : ''}</span>
            </div>
            {roadProgress.total > 0 && (
              <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${Math.min(roadProgress.loaded / roadProgress.total * 100, 100)}%` }} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── MAIN DASHBOARD ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const mapInstanceRef = useRef(null);

  const [colorMode,      setColorMode]      = useState('risk');
  const [layers,         setLayers]         = useState({ roads: true, rail: true, ports: true, dryports: true, stations: true, hotspots: true });
  const [filter,         setFilter]         = useState('all');
  const [selectedLoc,    setSelectedLoc]    = useState(null); // location click
  const [selectedEdge,   setSelectedEdge]   = useState(null); // road/rail click
  const [historyMode,    setHistoryMode]    = useState(false);
  const [historyIdx,     setHistoryIdx]     = useState(0);
  const [historyData,    setHistoryData]    = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [mapReady,       setMapReady]       = useState(false);

  const { data: pipelineStatus } = useQuery({ queryKey: ['pipeline-status'], queryFn: () => hazardApi.getPipelineStatus().then(r => r.data), refetchInterval: 15000 });
  const { data: hazSum }         = useQuery({ queryKey: ['hazard-summary'],   queryFn: () => hazardApi.getSummary().then(r => r.data), refetchInterval: 30000 });
  const { data: timestamps }     = useQuery({ queryKey: ['history-timestamps'], queryFn: () => historyApi.getTimestamps().then(r => r.data), enabled: historyMode });

  const staleMinutes = useMemo(() => minutesAgoFromTs(pipelineStatus?.last_run), [pipelineStatus]);
  const isStale = staleMinutes !== null && staleMinutes > 90;
  const hasCritical = (hazSum?.alert_counts?.CRITICAL || 0) > 0;



  // Auto-clear edge tooltip after 8 seconds — properly cleaned up on unmount
  useEffect(() => {
    if (!selectedEdge) return;
    const timer = setTimeout(() => setSelectedEdge(null), 8000);
    return () => clearTimeout(timer);
  }, [selectedEdge]);

  useEffect(() => {
    if (!historyMode || !timestamps?.length) return;
    const ts = timestamps[historyIdx];
    if (!ts) return;
    let cancelled = false;
    setHistoryLoading(true);
    historyApi.getNodes(ts)
      .then(r => { if (!cancelled) setHistoryData(r.data); })
      .catch(() => { if (!cancelled) setHistoryData(null); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [historyIdx, historyMode, timestamps]);

  useEffect(() => { if (!historyMode) { setHistoryData(null); setHistoryIdx(0); } }, [historyMode]);

  // ── Chat action: flyTo / highlight from URL params ────────────────────────
  const { data: facilityNodes } = useQuery({
    queryKey: ['combined-facilities'],
    queryFn:  () => combinedApi.getNodes({ type: 'port,dryport,station,rail_station' }).then(r => r.data),
    staleTime: 120000,
  });

  // Executes chat-bot actions (flyTo, highlight, slider) once both map and data are ready
  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current) return;

    const flyToId   = searchParams.get('flyTo');
    const highlight = searchParams.get('highlight');
    const slider    = searchParams.get('slider');

    if (flyToId && facilityNodes?.features) {
      const feat = facilityNodes.features.find(f => f.properties?.asset_id === flyToId);
      if (feat?.geometry?.coordinates) {
        const [lon, lat] = feat.geometry.coordinates;
        mapInstanceRef.current.flyTo({ center: [lon, lat], zoom: 12, duration: 1200 });
        setSelectedLoc(feat.properties);
      }
    }

    if (highlight) {
      const ids   = highlight.split(',').filter(Boolean);
      const feats = (facilityNodes?.features || []).filter(f => ids.includes(f.properties?.asset_id));
      const src   = mapInstanceRef.current.getSource('chat-highlight');
      if (src) {
        src.setData({ type: 'FeatureCollection', features: feats });
        // Also fly to the first highlighted asset
        if (feats[0]?.geometry?.coordinates) {
          const [lon, lat] = feats[0].geometry.coordinates;
          mapInstanceRef.current.flyTo({ center: [lon, lat], zoom: 7, duration: 1200 });
        }
        setTimeout(() => {
          if (mapInstanceRef.current?.getSource('chat-highlight'))
            mapInstanceRef.current.getSource('chat-highlight').setData({ type: 'FeatureCollection', features: [] });
        }, 10000);
      }
    }

    if (slider && timestamps?.length) {
      const idx = timestamps.indexOf(slider);
      if (idx >= 0) { setHistoryMode(true); setHistoryIdx(idx); }
    }
  }, [searchParams, facilityNodes, timestamps, mapReady]);

  const toggleLayer = useCallback(k => setLayers(p => ({ ...p, [k]: !p[k] })), []);

  const handleLocationSelect = useCallback(props => {
    setSelectedLoc(props);
    setSelectedEdge(null);
  }, []);

  const handleRoadSelect = useCallback(props => {
    setSelectedEdge(props);
    setSelectedLoc(null);
    // Timeout cleanup handled by the useEffect above
  }, []);

  const handleChokepointClick = useCallback(cp => {
    setSelectedLoc(cp);
    setSelectedEdge(null);
    if (mapInstanceRef.current && cp.lon != null && cp.lat != null) {
      mapInstanceRef.current.flyTo({ center: [cp.lon, cp.lat], zoom: 11, duration: 1200 });
    }
  }, []);

  // Right panel: location detail > road detail > default status
  const rightPanel = selectedLoc
    ? <LocationDetailPanel location={selectedLoc} onClose={() => setSelectedLoc(null)} onFlyTo={mapInstanceRef} />
    : selectedEdge
    ? <RoadDetailPanel edge={selectedEdge} onClose={() => setSelectedEdge(null)} />
    : <NetworkStatusPanel onChokepointClick={handleChokepointClick} />;

  return (
    <div className="h-screen flex flex-col overflow-hidden">

      {/* Shared floating topbar */}
      <Topbar mode="floating" title="Live Risk Map" />

      {/* Critical banners — shown below topbar */}
      {isStale && (
        <div className="bg-amber-600 text-white px-4 py-1.5 text-xs font-semibold flex items-center gap-2 flex-shrink-0 mt-[52px]">
          ⚠ Data may be outdated — last updated {formatRelativeTime(staleMinutes)}. Pipeline runs automatically every 15 min.
          <button onClick={() => qc.invalidateQueries()} className="ml-auto underline hover:no-underline">Refresh data</button>
        </div>
      )}
      {hasCritical && (
        <div className={`bg-red-600 text-white px-4 py-1.5 text-xs font-bold flex items-center gap-2 flex-shrink-0 ${!isStale ? 'mt-[52px]' : ''}`}>
          <div className="w-1.5 h-1.5 rounded-full bg-white pulse-dot" />
          FLOOD CRITICAL — {hazSum?.alert_counts?.CRITICAL} locations at critical risk
          {hazSum?.flood?.status === 'CRITICAL' && ` · ${Math.round((hazSum.flood.max_score || 0) * 100)}% intensity · ${hazSum.flood.triggered} locations triggered`}
        </div>
      )}
      {!hasCritical && (hazSum?.strike?.triggered > 0 || hazSum?.strike?.status === 'CRITICAL' || hazSum?.strike?.status === 'ACTIVE') && (
        <div className={`bg-amber-600 text-white px-4 py-1.5 text-xs font-bold flex items-center gap-2 flex-shrink-0 ${!isStale ? 'mt-[52px]' : ''}`}>
          <div className="w-1.5 h-1.5 rounded-full bg-white pulse-dot" />
          🚫 STRIKE / SHUTDOWN — {hazSum?.strike?.triggered || 0} locations affected
          {hazSum?.strike?.max_score >= 0.5 && ' · City-wide disruption detected'}
        </div>
      )}

      {/* Secondary controls bar */}
      <div className={`bg-white/95 backdrop-blur-sm border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-shrink-0 z-20 ${!isStale && !hasCritical ? 'mt-[52px]' : ''}`}>
        <button onClick={() => setHistoryMode(p => !p)}
          className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition ${historyMode ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
          {historyMode ? '● Live' : '⏱ History'}
        </button>
        <button onClick={() => qc.invalidateQueries()}
          className="px-2.5 py-1.5 border border-gray-200 text-gray-500 text-xs rounded-lg hover:bg-gray-50 transition">
          ↻ Refresh
        </button>

        <div className="text-xs text-gray-400 ml-auto hidden sm:block">Click any location or road segment to analyze it</div>
        <Link to="/globe"
          className="ml-2 px-3 py-1.5 border border-gray-200 text-gray-600 text-xs font-bold rounded-lg hover:bg-gray-50 transition flex items-center gap-1.5 flex-shrink-0">
          🌏 3D Globe
        </Link>
      </div>

      {/* 3-column layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar */}
        <LeftSidebar
          colorMode={colorMode} setColorMode={setColorMode}
          layers={layers} toggleLayer={toggleLayer}
          filter={filter} setFilter={setFilter}
          pipelineStatus={pipelineStatus}
        />

        {/* Map */}
        <div className={`flex-1 min-w-0 relative ${historyMode ? 'pb-14' : ''}`}>
          <ErrorBoundary>
            <RiskNetworkMap
              colorMode={colorMode}
              layers={layers}
              filter={filter}
              onLocationSelect={handleLocationSelect}
              onRoadSelect={handleRoadSelect}
              historyNodes={historyMode ? historyData : null}
              onMapReady={map => {
                mapInstanceRef.current = map;
                // onMapReady fires after 'load' — map is ready, add layers directly
                if (!map.getSource('chat-highlight')) {
                  map.addSource('chat-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
                  // Outer glow
                  map.addLayer({
                    id: 'chat-highlight-glow',
                    type: 'circle',
                    source: 'chat-highlight',
                    paint: {
                      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 30, 12, 55],
                      'circle-color': '#F59E0B',
                      'circle-opacity': 0.18,
                      'circle-blur': 1,
                    },
                  });
                  // Solid ring
                  map.addLayer({
                    id: 'chat-highlight-ring',
                    type: 'circle',
                    source: 'chat-highlight',
                    paint: {
                      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 18, 12, 32],
                      'circle-color': '#F59E0B',
                      'circle-opacity': 0.15,
                      'circle-stroke-width': 4,
                      'circle-stroke-color': '#F59E0B',
                      'circle-stroke-opacity': 0.9,
                    },
                  });
                }
                setMapReady(true);  // triggers URL-param useEffect
              }}
            />
          </ErrorBoundary>

          {historyMode && !historyData && !historyLoading && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none">
              <div className="rounded-2xl px-10 py-8 text-center shadow-2xl" style={{
                background: 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.88))',
                backdropFilter: 'blur(16px)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}>
                <div className="text-3xl mb-3">⏱</div>
                <div className="text-sm font-bold text-white">History Playback</div>
                <div className="text-xs text-white/40 mt-1.5 max-w-[220px] leading-relaxed">Drag the slider or press ▶ to replay past hazard states across the network</div>
                <div className="flex items-center justify-center gap-3 mt-3 text-xs text-white/25">
                  <span>← → step</span><span>·</span><span>Space play/pause</span>
                </div>
              </div>
            </div>
          )}

          {historyMode && <TimeSlider timestamps={timestamps || []} currentIdx={historyIdx} onChange={setHistoryIdx} isLoading={historyLoading} />}
        </div>

        {/* Right panel */}
        <div className="w-[380px] flex-shrink-0 border-l border-gray-200 flex flex-col min-h-0 bg-white overflow-hidden">
          {rightPanel}
        </div>
      </div>
    </div>
  );
}
