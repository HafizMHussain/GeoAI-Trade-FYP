/**
 * Asset Profile Page
 *
 * Shows a detailed breakdown of any network asset — sea ports, inland container
 * terminals, railway stations, or road/rail junctions — in plain English.
 *
 * URL: /asset/:asset_id   (e.g. /asset/road_2411  /asset/port_1  /asset/dryport_5)
 */
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { assetApi, historyApi, networkApi } from '../api/networkApi';
import { resolveNodeName } from '../utils/nearestCity';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { TIER_COLOR } from '../styles/tokens';
import { pipelineTsToLabel } from '../utils/formatters';
import Topbar from '../components/Topbar';

// ── Type metadata ─────────────────────────────────────────────────────────────

const TYPE_META = {
  port:              { icon: '🚢', label: 'Sea Port',                  color: '#D85A30', desc: 'A major seaport handling international cargo containers and bulk freight by ship.' },
  dryport:           { icon: '🏭', label: 'Inland Container Terminal', color: '#534AB7', desc: 'An inland hub where goods are transferred between trucks and trains for onward shipping.' },
  station:           { icon: '🚂', label: 'Railway Station',           color: '#1D9E75', desc: 'A railway station connecting freight trains to the national rail network.' },
  rail_station:      { icon: '🚂', label: 'Railway Station',           color: '#1D9E75', desc: 'A railway station connecting freight trains to the national rail network.' },
  road_intersection: { icon: '⬡',  label: 'Road Junction',             color: '#64748B', desc: 'A road crossing point where multiple freight routes meet. Disruption here can delay multiple trucks simultaneously.' },
  rail_intersection: { icon: '⬡',  label: 'Rail Junction',             color: '#64748B', desc: 'A rail line crossing point. A blockage here can delay multiple train services at once.' },
};

function typeMeta(type) {
  return TYPE_META[type] || { icon: '📍', label: type?.replace(/_/g,' ') || 'Location', color: '#6B7280', desc: '' };
}

function isFacility(type) {
  return ['port','dryport','station','rail_station'].includes(type);
}

// ── Tier badge ────────────────────────────────────────────────────────────────

function TierBadge({ tier, size = 'sm' }) {
  const c = TIER_COLOR[tier] || '#6B7280';
  const label = { CRITICAL:'Critical', HIGH:'High', MEDIUM:'Medium', LOW:'Low' }[tier] || tier;
  const cls = size === 'lg'
    ? 'px-3.5 py-1.5 text-sm font-bold rounded-full border'
    : 'px-2.5 py-0.5 text-xs font-bold rounded-full border';
  return (
    <span className={cls} style={{ color: c, borderColor: c+'60', backgroundColor: c+'18' }}>
      {label}
    </span>
  );
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ value, color, label, subLabel }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1">
        <div>
          <span className="text-gray-700 font-medium">{label}</span>
          {subLabel && <span className="text-gray-400 ml-1">— {subLabel}</span>}
        </div>
        <span className="font-black text-slate-800">{pct}%</span>
      </div>
      <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ value, label, sub, accent }) {
  return (
    <div className="bg-gray-50 rounded-2xl p-4 text-center border border-gray-100">
      <div className="text-2xl font-black text-slate-900" style={accent ? { color: accent } : {}}>{value}</div>
      <div className="text-xs font-bold text-gray-600 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Mini map ──────────────────────────────────────────────────────────────────

function AssetMap({ asset }) {
  const mapEl  = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: mapEl.current,
      style: `https://api.maptiler.com/maps/topo/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [asset.lon, asset.lat],
      zoom: isFacility(asset.node_type) ? 10 : 11,
      interactive: true,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    mapRef.current.on('load', () => setReady(true));
  }, [asset.lon, asset.lat, asset.node_type]);

  useEffect(() => {
    if (!ready) return;
    const meta = typeMeta(asset.node_type);
    const el = document.createElement('div');
    el.style.cssText = `
      width:32px;height:32px;border-radius:50%;
      background:${meta.color};border:3px solid #fff;
      box-shadow:0 2px 8px rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      font-size:14px;
    `;
    el.textContent = meta.icon;
    new maplibregl.Marker({ element: el })
      .setLngLat([asset.lon, asset.lat])
      .addTo(mapRef.current);
  }, [ready, asset]);

  return <div ref={mapEl} className="w-full h-full" />;
}

// ── Betweenness → plain-English ───────────────────────────────────────────────

function betweennessLabel(bc) {
  const pct = Math.min((bc || 0) * 100 * 3.24, 100);
  if (pct < 0.1) return { pct, label: 'Very few routes', desc: 'Almost no freight routes currently use this junction as a waypoint.' };
  if (pct < 1)   return { pct, label: 'Some routes', desc: 'A small share of freight routes pass through here.' };
  if (pct < 10)  return { pct, label: 'Moderate traffic', desc: 'A noticeable share of freight routes use this junction.' };
  if (pct < 30)  return { pct, label: 'High traffic', desc: 'Many freight routes depend on this junction — disruption would have wide impact.' };
  return { pct, label: 'Critical junction', desc: 'A very large share of freight routes pass through here. This is a strategic chokepoint.' };
}

// ── Alert label ───────────────────────────────────────────────────────────────

function alertExplain(level) {
  return {
    CRITICAL: 'Immediate threat — avoid this location if possible.',
    HIGH:     'Active threat detected — monitor closely and prepare alternatives.',
    MEDIUM:   'Elevated risk — keep watch on conditions.',
    LOW:      'Normal conditions — no immediate threat.',
  }[level] || '';
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AssetProfile() {
  const { asset_id } = useParams();

  const { data: asset, isLoading, error } = useQuery({
    queryKey: ['asset', asset_id],
    queryFn:  () => assetApi.getDetail(asset_id).then(r => r.data),
  });

  const { data: reachability } = useQuery({
    queryKey: ['asset-reachability', asset_id],
    queryFn:  () => assetApi.getReachability(asset_id).then(r => r.data),
    enabled:  !!asset_id && !!asset && isFacility(asset?.node_type),
  });

  const { data: timestamps } = useQuery({
    queryKey: ['history-timestamps'],
    queryFn:  () => historyApi.getTimestamps().then(r => r.data),
  });

  const { data: historySnapshots } = useQuery({
    queryKey: ['asset-hazard-history', asset_id, timestamps],
    queryFn: async () => {
      if (!timestamps?.length) return [];
      const recentTs = timestamps.slice(0, 12).reverse();
      const results = await Promise.all(
        recentTs.map(ts =>
          historyApi.getNodes(ts)
            .then(r => {
              const feat = (r.data?.features || []).find(f => f.properties?.asset_id === asset_id);
              return feat ? { ts, composite_hazard: feat.properties.composite_hazard, alert_level: feat.properties.alert_level } : null;
            })
            .catch(() => null)
        )
      );
      return results.filter(Boolean);
    },
    enabled: !!(timestamps?.length && asset_id),
    staleTime: 300000,
  });

  // ── Loading / error ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Topbar mode="full" />
        <div className="flex items-center justify-center py-32">
          <div className="text-center">
            <svg className="animate-spin w-8 h-8 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <div className="text-gray-400 text-sm">Loading location profile…</div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !asset) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Topbar mode="full" />
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <div className="text-4xl mb-4">📍</div>
          <h2 className="text-xl font-bold text-slate-700 mb-2">Location Not Found</h2>
          <p className="text-gray-500 mb-6">No data found for <code className="bg-gray-100 px-2 py-0.5 rounded text-sm">{asset_id}</code></p>
          <Link to="/map" className="inline-flex items-center gap-2 bg-slate-900 text-white font-bold px-5 py-2.5 rounded-xl text-sm hover:bg-slate-700 transition">
            ← Back to Risk Map
          </Link>
        </div>
      </div>
    );
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  const hz       = asset.hazard || {};
  const risk     = asset.risk   || {};
  const meta     = typeMeta(asset.node_type);
  const isFac    = isFacility(asset.node_type);
  const name     = resolveNodeName(asset);
  const bc       = betweennessLabel(asset.betweenness_centrality);

  const chartData = historySnapshots?.length
    ? historySnapshots.map(s => ({ t: pipelineTsToLabel(s.ts), hazard: Math.round((s.composite_hazard || 0) * 100) }))
    : hz.composite_hazard != null
    ? [{ t: 'Now', hazard: Math.round((hz.composite_hazard || 0) * 100) }]
    : [];

  const hazardPct    = Math.round((hz.composite_hazard || 0) * 100);
  const riskPct      = Math.round((risk.composite_risk || 0) * 100);
  const netRiskPct   = Math.round((risk.network_criticality_risk || 0) * 100);
  const alertLevel   = hz.alert_level || 'LOW';
  const alertColor   = TIER_COLOR[alertLevel] || '#6B7280';
  const riskTier     = risk.risk_tier || 'LOW';

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <Topbar mode="full" />

      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-6">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
            <Link to="/" className="hover:text-gray-600 transition">Home</Link>
            <span>›</span>
            <Link to="/map" className="hover:text-gray-600 transition">Risk Map</Link>
            <span>›</span>
            <span className="text-gray-600">{name}</span>
          </div>

          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="flex items-start gap-4">
              {/* Type icon */}
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0 border-2"
                style={{ backgroundColor: meta.color + '15', borderColor: meta.color + '40' }}>
                {meta.icon}
              </div>
              <div>
                <h1 className="text-2xl font-black text-slate-900 leading-tight">{name}</h1>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="px-3 py-1 rounded-full text-xs font-bold text-white" style={{ backgroundColor: meta.color }}>
                    {meta.label}
                  </span>
                  {/* Hazard alert */}
                  <TierBadge tier={alertLevel} size="sm" />
                  {alertLevel !== 'LOW' && <span className="text-xs text-gray-500">{alertExplain(alertLevel)}</span>}
                  {risk.is_chokepoint && (
                    <span className="px-2.5 py-0.5 bg-orange-100 text-orange-700 border border-orange-200 text-xs font-bold rounded-full">
                      ⚠ Chokepoint
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-gray-400 flex-wrap">
                  <span className="font-mono">{asset.asset_id}</span>
                  <span>·</span>
                  <span>{asset.lat?.toFixed(4)}°N, {asset.lon?.toFixed(4)}°E</span>
                  {asset.lat && (
                    <>
                      <span>·</span>
                      <a href={`https://www.google.com/maps?q=${asset.lat},${asset.lon}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-blue-500 hover:text-blue-700 transition">
                        View on Google Maps ↗
                      </a>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 flex-wrap">
              <Link to={`/routes?from=${asset_id}`}
                className="flex items-center gap-1.5 text-sm font-bold px-4 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-slate-700 transition">
                🛣️ Plan Route
              </Link>
              <Link to={`/scenario?target=${asset_id}`}
                className="flex items-center gap-1.5 text-sm font-bold px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-white transition">
                ⚡ Simulate Disruption
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">

        {/* ── About this location ── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-base font-bold text-slate-800 mb-1">About This Location</h2>
          <p className="text-sm text-gray-600 leading-relaxed">{meta.desc}</p>
          {!isFac && (
            <div className="mt-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-700">
              <span className="font-bold">How does this affect trade?</span> When this junction is blocked by flooding, accidents, or road closures, all trucks using these roads must divert — adding extra time and cost to their journeys.
            </div>
          )}
        </div>

        {/* ── Key stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            value={<span style={{ color: alertColor }}>{alertLevel}</span>}
            label="Hazard Alert Level"
            sub="From live pipeline"
          />
          <StatCard
            value={`${hazardPct}%`}
            label="Current Threat Score"
            sub="Combined flood + other hazards"
            accent={hazardPct > 50 ? alertColor : undefined}
          />
          <StatCard
            value={`${riskPct}%`}
            label="Risk Score (H×E×V)"
            sub="Actual impact after exposure + vulnerability"
          />
          <StatCard
            value={bc.label}
            label="Network Importance"
            sub={`~${bc.pct.toFixed(1)}% of routes pass here`}
          />
        </div>

        {/* ── Map + Network importance ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Map — 2/3 width */}
          <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden" style={{ height: 300 }}>
            <AssetMap asset={asset} />
          </div>

          {/* Network position card */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex flex-col gap-4">
            <div>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Network Position</div>
              <div className="space-y-2">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600">Freight routes passing through</span>
                    <span className="font-bold text-slate-800">{bc.pct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(bc.pct, 100)}%` }} />
                  </div>
                  <div className="text-xs text-gray-400 mt-1">{bc.desc}</div>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Asset Ratings</div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  { label: 'Importance', value: `${asset.importance_index || 1}/5`, tip: 'Strategic value to Pakistan trade' },
                  { label: 'Capacity',   value: `${asset.handling_capacity_index || 1}/5`, tip: 'Throughput capacity' },
                  { label: 'Redundancy', value: `${asset.redundancy_index || 0}/3`, tip: 'Alternative routes available' },
                ].map(m => (
                  <div key={m.label} title={m.tip} className="bg-gray-50 rounded-xl p-2.5 cursor-help">
                    <div className="text-base font-black text-slate-800">{m.value}</div>
                    <div className="text-xs text-gray-400 mt-0.5 leading-tight">{m.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {asset.redundancy_index === 0 && (
              <div className="bg-orange-50 border border-orange-200 rounded-xl px-3 py-2.5 text-xs text-orange-700">
                <span className="font-bold">No alternatives detected</span> — if this junction is blocked, there may be no easy detour.
              </div>
            )}
          </div>
        </div>

        {/* ── Hazard pipeline + Risk engine ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Hazard Pipeline */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-bold text-slate-800">Live Threat Assessment</h3>
              <span className="text-xs text-gray-400">From hazard pipeline</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Real-time threat scores calculated from satellite rainfall data, weather alerts, news monitoring, and historical accident records.
            </p>

            {hz.composite_hazard != null ? (
              <div className="space-y-1">
                <ScoreBar label="🌊 Flooding" value={hz.hazard_flood} color="#378ADD"
                  subLabel={hz.hazard_flood > 0.5 ? 'Active flood conditions nearby' : hz.hazard_flood > 0.3 ? 'Elevated rainfall detected' : 'Normal levels'} />
                <ScoreBar label="🌀 Cyclone / Storm" value={hz.hazard_cyclone} color="#534AB7"
                  subLabel={hz.hazard_cyclone > 0.3 ? 'Storm activity detected' : 'No storms nearby'} />
                <ScoreBar label="🚫 Labor Action" value={hz.hazard_strike} color="#EF9F27"
                  subLabel={hz.hazard_strike > 0.3 ? 'Strike activity in news' : 'No events detected'} />
                <ScoreBar label="⚠️ Transport Accident" value={hz.hazard_accident} color="#E24B4A"
                  subLabel={hz.hazard_accident > 0.3 ? 'Recent incidents detected' : 'Normal conditions'} />

                <div className="mt-4 pt-4 border-t border-gray-100">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold text-slate-700">Combined Threat Level</span>
                    <TierBadge tier={alertLevel} size="lg" />
                  </div>
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${hazardPct}%`, backgroundColor: alertColor }} />
                  </div>
                  <div className="flex justify-between text-xs mt-1">
                    <span className="text-gray-400">{alertExplain(alertLevel)}</span>
                    <span className="font-bold text-slate-800">{hazardPct}%</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-xl">
                <div className="text-3xl mb-2">⏳</div>
                No hazard data yet<br />
                <span className="text-xs">Run the hazard pipeline to see live threat scores</span>
              </div>
            )}
          </div>

          {/* Risk Engine */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-bold text-slate-800">Risk Engine Analysis</h3>
              <span className="text-xs text-gray-400">Hazard × Exposure × Vulnerability</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              The risk score is lower than the raw hazard because it accounts for how exposed this specific location is and how badly it would be damaged.
              A road junction in a high-flood area has high hazard but moderate vulnerability.
            </p>

            {risk.composite_risk != null ? (
              <div className="space-y-1">
                <ScoreBar label="🌊 Flood risk" value={risk.risk_flood} color="#378ADD"
                  subLabel="Flood hazard × road exposure × vulnerability" />
                <ScoreBar label="🌀 Cyclone risk" value={risk.risk_cyclone} color="#534AB7"
                  subLabel="Cyclone hazard × exposure × vulnerability" />
                <ScoreBar label="🚫 Strike risk" value={risk.risk_strike} color="#EF9F27"
                  subLabel="Labor action × exposure × vulnerability" />
                <ScoreBar label="⚠️ Accident risk" value={risk.risk_accident} color="#E24B4A"
                  subLabel="Accident hazard × exposure × vulnerability" />

                <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-bold text-slate-700">Composite Risk Score</span>
                      <TierBadge tier={riskTier} size="lg" />
                    </div>
                    <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${riskPct}%`, backgroundColor: TIER_COLOR[riskTier] || '#6B7280' }} />
                    </div>
                    <div className="flex justify-between text-xs mt-1">
                      <span className="text-gray-400">Risk to freight operations</span>
                      <span className="font-bold text-slate-800">{riskPct}%</span>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Network criticality impact</span>
                      <span className="font-bold text-slate-800">{netRiskPct}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden mt-1">
                      <div className="h-full rounded-full bg-purple-500" style={{ width: `${netRiskPct}%` }} />
                    </div>
                    <div className="text-xs text-gray-400 mt-1">How much this location's disruption would affect the wider network</div>
                  </div>
                </div>

                {hazardPct > riskPct + 20 && (
                  <div className="mt-3 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 text-xs text-blue-700">
                    <span className="font-bold">Why is risk lower than hazard?</span> The flood threat is real ({hazardPct}%), but this type of location has lower exposure and vulnerability — reducing the final risk score to {riskPct}%.
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-xl">
                <div className="text-3xl mb-2">⏳</div>
                No risk data yet<br />
                <span className="text-xs">Run the risk engine (after hazard pipeline)</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Hazard history chart ── */}
        {chartData.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-bold text-slate-800">Hazard History</h3>
              <span className="text-xs text-gray-400">Combined threat score over time</span>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Shows how the threat level at this location has changed across pipeline runs. Peaks indicate flood events, storms, or other hazard spikes.
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -24 }}>
                <defs>
                  <linearGradient id="hazGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={alertColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={alertColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9 }} domain={[0, 100]} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} formatter={v => [`${v}%`, 'Threat level']} />
                <Area type="monotone" dataKey="hazard" stroke={alertColor} fill="url(#hazGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
            {chartData.length === 1 && (
              <div className="text-xs text-gray-400 mt-2 text-center">Only one data point — run the pipeline multiple times to see trend history.</div>
            )}
          </div>
        )}

        {/* ── Centrality deep-dive (collapsible for non-technical) ── */}
        <details className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden group">
          <summary className="px-6 py-4 cursor-pointer flex items-center justify-between hover:bg-gray-50 transition select-none">
            <div>
              <span className="text-base font-bold text-slate-800">Network Centrality Metrics</span>
              <span className="text-xs text-gray-400 ml-2">(technical details)</span>
            </div>
            <span className="text-gray-400 text-sm group-open:rotate-180 transition-transform">▼</span>
          </summary>
          <div className="px-6 pb-6 pt-2 border-t border-gray-100">
            <p className="text-xs text-gray-500 mb-4">These scores are computed by network analysis algorithms. Higher = more central to the freight network.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: 'Betweenness',  value: (asset.betweenness_centrality || 0).toFixed(6), tip: 'Fraction of shortest paths passing through this node' },
                { label: 'Closeness',    value: (asset.closeness_centrality   || 0).toFixed(4), tip: 'How quickly this node can reach all others' },
                { label: 'Degree',       value: (asset.degree_centrality      || 0).toFixed(5), tip: 'Number of direct connections, normalised' },
                { label: 'Importance',   value: `${asset.importance_index || 1}/5`, tip: 'Strategic importance to national supply chain' },
                { label: 'Capacity',     value: `${asset.handling_capacity_index || 1}/5`, tip: 'Throughput capacity index' },
                { label: 'Redundancy',   value: `${asset.redundancy_index || 0}/3`, tip: 'Number of alternative routes if this fails' },
              ].map(m => (
                <div key={m.label} title={m.tip} className="bg-gray-50 rounded-xl p-3 text-center cursor-help hover:bg-gray-100 transition">
                  <div className="text-sm font-black text-slate-900 font-mono">{m.value}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{m.label}</div>
                </div>
              ))}
            </div>
          </div>
        </details>

        {/* ── Reachability (facilities only) ── */}
        {isFac && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-slate-800">Journey Times to Other Terminals</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Pre-computed travel times from this terminal to all other ports, depots, and stations in the network.
              </p>
            </div>
            {(reachability || []).length === 0 ? (
              <div className="px-6 py-10 text-center text-gray-400 text-sm">No reachability data available yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Destination</th>
                      <th className="text-right px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Journey Time</th>
                      <th className="text-right px-6 py-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Distance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {(reachability || []).slice(0, 20).map((r, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition">
                        <td className="px-6 py-3 font-medium text-slate-800">
                          {r.destination_name || r.destination}
                        </td>
                        <td className="px-6 py-3 text-gray-600 text-right font-mono">
                          {r.travel_time_hr ? `${r.travel_time_hr.toFixed(1)} hrs` : '—'}
                        </td>
                        <td className="px-6 py-3 text-gray-600 text-right font-mono">
                          {r.distance_km ? `${Math.round(r.distance_km)} km` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── For non-facilities: what to do card ── */}
        {!isFac && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <h2 className="text-base font-bold text-slate-800 mb-4">What Can You Do?</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Link to={`/routes?from=${asset_id}`}
                className="flex flex-col items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl p-4 hover:bg-blue-100 transition text-center">
                <span className="text-3xl">🛣️</span>
                <div className="font-bold text-blue-800 text-sm">Find Safe Routes</div>
                <div className="text-xs text-blue-600">Find freight routes that avoid or pass through this junction</div>
              </Link>
              <Link to={`/scenario?target=${asset_id}`}
                className="flex flex-col items-center gap-2 bg-orange-50 border border-orange-100 rounded-xl p-4 hover:bg-orange-100 transition text-center">
                <span className="text-3xl">⚡</span>
                <div className="font-bold text-orange-800 text-sm">Simulate Blockage</div>
                <div className="text-xs text-orange-600">See which trade corridors are affected if this junction is closed</div>
              </Link>
              <Link to="/map"
                className="flex flex-col items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl p-4 hover:bg-gray-100 transition text-center">
                <span className="text-3xl">🗺️</span>
                <div className="font-bold text-gray-800 text-sm">See on Risk Map</div>
                <div className="text-xs text-gray-500">View this junction in context on the live risk map</div>
              </Link>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
