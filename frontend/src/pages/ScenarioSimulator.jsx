/**
 * Scenario Simulator — "What if?" disruption analysis
 *
 * Shows the map with animated impact visualization:
 * - Selected targets pulse red
 * - Affected facilities glow amber with ripple rings
 * - Route network flashes to show disrupted corridors
 * - Results panel shows how many routes are cut or delayed
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { networkApi, scenarioApi, combinedApi, chatApi } from '../api/networkApi';
import Topbar from '../components/Topbar';
import { TIER_COLOR } from '../styles/tokens';
import { resolveNodeName } from '../utils/nearestCity';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCENARIO_TYPES = [
  {
    id: 'node_removal',
    label: 'Terminal Closure',
    icon: '🚫',
    color: '#E24B4A',
    desc: 'What if this port or depot completely shuts down? Simulates a full operational halt — strike, flooding, government closure.',
  },
  {
    id: 'edge_closure',
    label: 'Road / Rail Blockage',
    icon: '🚧',
    color: '#EF9F27',
    desc: 'What if a road or rail line is blocked? Simulates a bridge closure, flood washout, or accident blocking the route.',
  },
  {
    id: 'capacity_reduction',
    label: 'Capacity Reduction',
    icon: '📉',
    color: '#EAB308',
    desc: 'What if throughput drops significantly? Simulates congestion, partial strike, or maintenance reducing how much can flow through.',
  },
  {
    id: 'flood',
    label: 'Flood Event',
    icon: '🌊',
    color: '#378ADD',
    desc: 'Uses live flood hazard data from the pipeline to slow flood-exposed roads and railways. Severity scales the impact.',
  },
  {
    id: 'cyclone',
    label: 'Cyclone / Storm',
    icon: '🌀',
    color: '#534AB7',
    desc: 'Uses live cyclone hazard scores. Affects coastal facilities and exposed transport links most.',
  },
  {
    id: 'strike',
    label: 'Strike & Shutdown',
    icon: '🛑',
    color: '#EF9F27',
    desc: 'Uses live strike & shutdown hazard scores — city closures, motorway blocks, and dharna events from news monitoring.',
  },
  {
    id: 'accident',
    label: 'Transport Accident',
    icon: '⚠️',
    color: '#E24B4A',
    desc: 'Uses live accident hazard scores. Simulates a major road collision or train derailment blocking key routes.',
  },
];

// ── Animated scenario map ─────────────────────────────────────────────────────

function ScenarioMap({ targets, affectedIds, isRunning, hasResults, onFacilityClick, impactedRoutes, showCorridors }) {
  const mapEl          = useRef(null);
  const mapRef         = useRef(null);
  const [ready, setReady] = useState(false);
  const popupRef       = useRef(null);
  const corridorPopRef = useRef(null); // separate ref for corridor hover popups

  const { data: pkBound }       = useQuery({ queryKey: ['pakistan-boundary'],   queryFn: () => networkApi.getPakistanBoundary().then(r => r.data).catch(() => null), staleTime: Infinity });
  const { data: facilityNodes } = useQuery({ queryKey: ['combined-facilities'], queryFn: () => combinedApi.getNodes({ type: 'port,dryport,station,rail_station' }).then(r => r.data), staleTime: 120000 });
  const { data: railEdges }     = useQuery({ queryKey: ['combined-rail'],       queryFn: () => combinedApi.getEdges({ mode: 'rail' }).then(r => r.data), staleTime: 120000 });

  // Init map
  useEffect(() => {
    if (mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: mapEl.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [68, 30], zoom: 5, antialias: true,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    mapRef.current.on('load', () => setReady(true));
    return () => { if (popupRef.current) popupRef.current.remove(); };
  }, []);

  // Pakistan boundary
  useEffect(() => {
    if (!ready || !pkBound || mapRef.current.getSource('pk')) return;
    mapRef.current.addSource('pk', { type: 'geojson', data: pkBound });
    mapRef.current.addLayer({ id: 'pk-fill', type: 'fill', source: 'pk', paint: { 'fill-color': '#dbeafe', 'fill-opacity': 0.10 } });
    mapRef.current.addLayer({ id: 'pk-line', type: 'line', source: 'pk', paint: { 'line-color': '#64748b', 'line-width': 1.5, 'line-opacity': 0.5 } });
  }, [pkBound, ready]);

  // Road edges (static background)
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const empty = { type: 'FeatureCollection', features: [] };
      if (!mapRef.current.getSource('roads')) {
        mapRef.current.addSource('roads', { type: 'geojson', data: empty });
        mapRef.current.addLayer({
          id: 'roads-layer', type: 'line', source: 'roads',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['match', ['downcase', ['get', 'road_type']], 'motorway', '#D85A30', 'trunk', '#EF9F27', 'primary', '#378ADD', '#94a3b8'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 2],
            'line-opacity': 0.45,
          },
        });
      }
      let feats = [], offset = 0;
      while (!cancelled) {
        const r = await combinedApi.getEdges({ mode: 'road', limit: 2000, offset }).catch(() => null);
        if (!r?.data?.features?.length) break;
        feats = feats.concat(r.data.features);
        if (mapRef.current?.getSource('roads'))
          mapRef.current.getSource('roads').setData({ type: 'FeatureCollection', features: feats });
        offset += 2000;
        if ((r.data.pagination?.returned ?? r.data.features.length) < 2000) break;
      }
    })();
    return () => { cancelled = true; };
  }, [ready]);

  // Rail edges
  useEffect(() => {
    if (!ready || !railEdges) return;
    if (mapRef.current.getSource('rail')) { mapRef.current.getSource('rail').setData(railEdges); return; }
    mapRef.current.addSource('rail', { type: 'geojson', data: railEdges });
    mapRef.current.addLayer({
      id: 'rail-layer', type: 'line', source: 'rail',
      paint: { 'line-color': '#1D9E75', 'line-width': 2, 'line-opacity': 0.5, 'line-dasharray': [5, 3] },
    });
  }, [railEdges, ready]);

  // Facility nodes — colored by state: target=red pulsing, affected=orange, normal=type color
  useEffect(() => {
    if (!ready || !facilityNodes) return;

    const getColorExpr = () => [
      'case',
      ['in', ['get', 'asset_id'], ['literal', targets]],
      '#E24B4A',
      ['in', ['get', 'asset_id'], ['literal', affectedIds]],
      '#EF9F27',
      ['match', ['get', 'node_type'],
        'port',        '#D85A30',
        'dryport',     '#534AB7',
        'station',     '#1D9E75',
        'rail_station','#1D9E75',
        '#64748B',
      ],
    ];

    // Single zoom interpolate with case inside each stop — avoids "multiple zoom subexpression" error
    const getSizeExpr = (baseMin, baseMax) => [
      'interpolate', ['linear'], ['zoom'],
      4, ['case',
        ['in', ['get', 'asset_id'], ['literal', targets]],    baseMin * 1.6,
        ['in', ['get', 'asset_id'], ['literal', affectedIds]], baseMin * 1.3,
        baseMin,
      ],
      12, ['case',
        ['in', ['get', 'asset_id'], ['literal', targets]],    baseMax * 1.6,
        ['in', ['get', 'asset_id'], ['literal', affectedIds]], baseMax * 1.3,
        baseMax,
      ],
    ];

    if (mapRef.current.getSource('facilities')) {
      mapRef.current.getSource('facilities').setData(facilityNodes);
      if (mapRef.current.getLayer('fac-glow')) {
        mapRef.current.setPaintProperty('fac-glow', 'circle-color', getColorExpr());
        mapRef.current.setPaintProperty('fac-glow', 'circle-radius', getSizeExpr(20, 40));
      }
      if (mapRef.current.getLayer('fac-ring')) {
        mapRef.current.setPaintProperty('fac-ring', 'circle-color', getColorExpr());
        mapRef.current.setPaintProperty('fac-ring', 'circle-radius', getSizeExpr(12, 22));
      }
      if (mapRef.current.getLayer('fac-circle')) {
        mapRef.current.setPaintProperty('fac-circle', 'circle-color', getColorExpr());
        mapRef.current.setPaintProperty('fac-circle', 'circle-radius', getSizeExpr(7, 14));
      }
      return;
    }

    mapRef.current.addSource('facilities', { type: 'geojson', data: facilityNodes });

    mapRef.current.addLayer({
      id: 'fac-glow', type: 'circle', source: 'facilities',
      paint: {
        'circle-radius': getSizeExpr(20, 40),
        'circle-color':  getColorExpr(),
        'circle-opacity': ['case', ['in', ['get', 'asset_id'], ['literal', targets]], 0.25, ['in', ['get', 'asset_id'], ['literal', affectedIds]], 0.15, 0.06],
        'circle-blur': 1,
      },
    });
    mapRef.current.addLayer({
      id: 'fac-ring', type: 'circle', source: 'facilities',
      paint: {
        'circle-radius': getSizeExpr(12, 22),
        'circle-color':  getColorExpr(),
        'circle-opacity': ['case', ['in', ['get', 'asset_id'], ['literal', targets]], 0.4, ['in', ['get', 'asset_id'], ['literal', affectedIds]], 0.25, 0.08],
      },
    });
    mapRef.current.addLayer({
      id: 'fac-circle', type: 'circle', source: 'facilities',
      paint: {
        'circle-radius':       getSizeExpr(7, 14),
        'circle-color':        getColorExpr(),
        'circle-opacity':      0.95,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });
    mapRef.current.addLayer({
      id: 'fac-labels', type: 'symbol', source: 'facilities',
      layout: {
        'text-field': ['coalesce', ['get', 'display_name'], ['get', 'name'], ['get', 'asset_id']],
        'text-size': 11, 'text-offset': [0, 1.7], 'text-anchor': 'top', 'text-optional': true,
      },
      paint: { 'text-color': '#1e293b', 'text-halo-color': '#fff', 'text-halo-width': 2.5 },
      minzoom: 5,
    });

    mapRef.current.on('click', 'fac-circle', e => {
      if (e.features?.[0]) onFacilityClick(e.features[0].properties.asset_id, e.features[0].properties);
    });
    mapRef.current.on('mouseenter', 'fac-circle', e => {
      mapRef.current.getCanvas().style.cursor = 'pointer';
      const f = e.features[0].properties;
      const name = f.display_name || f.name || f.asset_id;
      const isTarget = targets.includes(f.asset_id);
      if (popupRef.current) popupRef.current.remove();
      popupRef.current = new maplibregl.Popup({ offset: 12, closeButton: false, maxWidth: '200px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div style="background:#fff;border:1px solid #e2e8f0;padding:10px 13px;border-radius:10px;font-family:system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.12)">
          <div style="font-weight:800;color:#0f172a;font-size:13px">${name}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;text-transform:capitalize">${(f.node_type||'').replace(/_/g,' ')}</div>
          <div style="margin-top:6px;font-size:11px;font-weight:600;color:${isTarget ? '#dc2626' : '#16a34a'}">
            ${isTarget ? '✕ Click to remove' : '+ Click to add as target'}
          </div>
        </div>`)
        .addTo(mapRef.current);
    });
    mapRef.current.on('mouseleave', 'fac-circle', () => {
      mapRef.current.getCanvas().style.cursor = '';
      if (popupRef.current) { popupRef.current.remove(); popupRef.current = null; }
    });
  }, [facilityNodes, ready, targets, affectedIds]);

  // Dim road layer while simulation runs
  useEffect(() => {
    if (!ready) return;
    if (mapRef.current.getLayer('roads-layer'))
      mapRef.current.setPaintProperty('roads-layer', 'line-opacity', isRunning ? 0.2 : 0.45);
  }, [isRunning, ready]);

  // ── Render real impacted route paths (fetched after simulation) ──────────────
  useEffect(() => {
    if (!ready) return;
    const LAYERS  = ['impact-glow', 'impact-unreach', 'impact-delay-hi', 'impact-delay-lo'];

    // Cleanup helper
    const cleanupImpact = () => {
      try {
        LAYERS.forEach(id => { if (mapRef.current.getLayer(id)) mapRef.current.removeLayer(id); });
        if (mapRef.current.getSource('impact-routes')) mapRef.current.removeSource('impact-routes');
      } catch {}
      if (corridorPopRef.current) { corridorPopRef.current.remove(); corridorPopRef.current = null; }
    };

    if (!impactedRoutes?.length) { cleanupImpact(); return; }

    try {
      cleanupImpact();

      const fc = { type: 'FeatureCollection', features: impactedRoutes };
      mapRef.current.addSource('impact-routes', { type: 'geojson', data: fc });

      // 1. Glow halo for UNREACHABLE segments (wide, soft red blur)
      mapRef.current.addLayer({
        id: 'impact-glow', type: 'line', source: 'impact-routes',
        filter: ['==', ['get', '_status'], 'UNREACHABLE'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#E24B4A', 'line-width': 18, 'line-opacity': 0.13, 'line-blur': 6 },
      });

      // 2. Solid red for UNREACHABLE (route completely blocked)
      mapRef.current.addLayer({
        id: 'impact-unreach', type: 'line', source: 'impact-routes',
        filter: ['==', ['get', '_status'], 'UNREACHABLE'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#E24B4A', 'line-width': 5, 'line-opacity': 0.92 },
      });

      // 3. Orange dashed for high-delay (>50%)
      mapRef.current.addLayer({
        id: 'impact-delay-hi', type: 'line', source: 'impact-routes',
        filter: ['all', ['!=', ['get', '_status'], 'UNREACHABLE'], ['>=', ['get', '_delay_pct'], 50]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#EF9F27', 'line-width': 4, 'line-opacity': 0.9, 'line-dasharray': [7, 4] },
      });

      // 4. Amber dashed for moderate delay (<50%)
      mapRef.current.addLayer({
        id: 'impact-delay-lo', type: 'line', source: 'impact-routes',
        filter: ['all', ['!=', ['get', '_status'], 'UNREACHABLE'], ['<', ['get', '_delay_pct'], 50]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#EAB308', 'line-width': 3, 'line-opacity': 0.8, 'line-dasharray': [5, 5] },
      });

      // Hover popup on all impact layers
      const showImpactPopup = (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p        = f.properties || {};
        const isUnreach = p._status === 'UNREACHABLE';
        const delay    = Math.round(p._delay_pct || 0);
        const mode     = (p.mode || '').replace('_', ' ');
        const roadType = (p.road_type || '').replace(/_/g, ' ');
        const km       = parseFloat(p.length_km || 0).toFixed(1);
        mapRef.current.getCanvas().style.cursor = 'pointer';
        if (corridorPopRef.current) { corridorPopRef.current.remove(); corridorPopRef.current = null; }
        corridorPopRef.current = new maplibregl.Popup({ offset: 12, closeButton: false, maxWidth: '240px' })
          .setLngLat(e.lngLat)
          .setHTML(`<div style="background:#fff;padding:10px 13px;border-radius:10px;font-family:system-ui;box-shadow:0 4px 16px rgba(0,0,0,0.14)">
            <div style="font-weight:800;font-size:12px;color:${isUnreach ? '#dc2626' : '#d97706'};margin-bottom:4px">
              ${isUnreach ? '🚫 Route Cut Off' : `⚠ +${delay}% Delay`}
            </div>
            <div style="font-size:11px;color:#0f172a;font-weight:700;margin-bottom:2px">${p._from || ''} → ${p._to || ''}</div>
            <div style="font-size:10px;color:#64748b;margin-bottom:6px;text-transform:capitalize">${mode}${roadType ? ' · ' + roadType : ''} · ${km} km</div>
            <div style="font-size:10px;color:${isUnreach ? '#dc2626' : '#d97706'};font-weight:600">
              ${isUnreach ? 'No alternative route available for this freight corridor' : `Journey is ${delay}% longer via detour`}
            </div>
          </div>`)
          .addTo(mapRef.current);
      };

      ['impact-unreach','impact-delay-hi','impact-delay-lo'].forEach(id => {
        mapRef.current.on('mouseenter', id, showImpactPopup);
        mapRef.current.on('mousemove',  id, showImpactPopup);
        mapRef.current.on('mouseleave', id, () => {
          mapRef.current.getCanvas().style.cursor = '';
          if (corridorPopRef.current) { corridorPopRef.current.remove(); corridorPopRef.current = null; }
        });
      });
    } catch (err) {
      console.warn('Impact route layer error:', err);
    }
  }, [ready, impactedRoutes]);

  // Toggle impact route layer visibility when showCorridors changes
  useEffect(() => {
    if (!ready) return;
    const vis = showCorridors ? 'visible' : 'none';
    ['impact-glow','impact-unreach','impact-delay-hi','impact-delay-lo'].forEach(id => {
      if (mapRef.current.getLayer(id)) mapRef.current.setLayoutProperty(id, 'visibility', vis);
    });
  }, [showCorridors, ready]);

  return <div ref={mapEl} className="absolute inset-0" />;
}

// ── Target chip ───────────────────────────────────────────────────────────────

function TargetChip({ assetId, name, nodeType, onRemove }) {
  const typeIcon = { port:'🚢', dryport:'🏭', station:'🚂', rail_station:'🚂' }[nodeType] || '📍';
  return (
    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs">
      <span className="text-base">{typeIcon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-slate-800 truncate">{name}</div>
        <div className="text-gray-400 text-xs capitalize">{(nodeType||'').replace(/_/g,' ')}</div>
      </div>
      <button onClick={() => onRemove(assetId)}
        className="w-5 h-5 rounded-full bg-red-100 hover:bg-red-200 text-red-600 flex items-center justify-center text-xs transition flex-shrink-0">
        ×
      </button>
    </div>
  );
}

// ── AI narrative analysis of simulation results ───────────────────────────────

function AIInsight({ result, targetNames, scenarioType, severity }) {
  const [text,    setText]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(false);

  // Re-run whenever the result key facts change
  const key = `${targetNames.join(',')}|${scenarioType}|${result?.total_affected}`;
  const prevKey = useRef('');

  useEffect(() => {
    if (!result || result.total_affected === 0 || key === prevKey.current) return;
    prevKey.current = key;
    setText(null);
    setError(false);
    setLoading(true);

    const topImpacts = (result.top_impacts || []).slice(0, 4)
      .map(i => `  • ${i.source_name || i.source} → ${i.target_name || i.target}: ${
        i.status === 'UNREACHABLE' ? 'UNREACHABLE (no alternative)' : `+${(i.delay_pct||0).toFixed(0)}% delay`
      }`).join('\n');

    const prompt =
`Scenario analysis for Pakistan's freight network:

Disruption: ${scenarioType.replace(/_/g, ' ')} at ${targetNames.join(', ')} (${Math.round(severity * 100)}% severity)

Network impact:
- ${result.total_affected} of 861 freight corridors disrupted (${Math.round((result.total_affected/861)*100)}%)
- ${result.unreachable_pairs ?? 0} routes completely cut off (no alternative)
- ${result.delayed_pairs ?? 0} routes delayed (avg +${(result.avg_delay_pct??0).toFixed(0)}%, worst +${(result.max_delay_pct??0).toFixed(0)}%)

Most affected corridors:
${topImpacts || '  (none listed)'}

Respond with exactly 3 numbered points:
1. Immediate cascade effects on Pakistan's supply chain
2. Which alternative terminals or routes logistics managers should activate
3. Estimated freight/economic impact and how long disruption would last`;

    chatApi.send(prompt, [])
      .then(r => setText(r.data?.text || null))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [key]);

  if (!result || result.total_affected === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-800 border-b border-slate-700">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-cyan-400 to-teal-500 flex items-center justify-center text-xs font-bold text-slate-900 flex-shrink-0">AI</div>
        <span className="text-sm font-bold text-white">Risk Intelligence Analysis</span>
        {loading && <div className="ml-auto w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
      </div>
      <div className="px-4 py-4">
        {loading && !text && (
          <div className="space-y-2.5">
            {[80, 65, 90, 55, 75].map((w, i) => (
              <div key={i} className="h-3 bg-slate-200 rounded animate-pulse" style={{ width: `${w}%` }} />
            ))}
            <p className="text-xs text-slate-400 mt-3">Analyzing cascade effects across Pakistan's freight network…</p>
          </div>
        )}
        {error && (
          <p className="text-xs text-slate-400 italic">AI analysis unavailable — check your connection or API key.</p>
        )}
        {text && (
          <div className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{text}</div>
        )}
      </div>
    </div>
  );
}

// ── Pipeline Analysis panel (offline data from scenario_simulation.py) ────────

function PipelineAnalysis() {
  const { data: mc } = useQuery({
    queryKey: ['scenario-montecarlo'],
    queryFn: () => scenarioApi.getMonteCarlo().then(r => r.data),
    staleTime: 300000, // 5 min cache
  });
  const { data: corridors } = useQuery({
    queryKey: ['scenario-corridors'],
    queryFn: () => scenarioApi.getCorridors().then(r => r.data),
    staleTime: 300000,
  });
  const { data: econ } = useQuery({
    queryKey: ['scenario-economic'],
    queryFn: () => scenarioApi.getEconomic().then(r => r.data),
    staleTime: 300000,
  });
  const { data: recovery } = useQuery({
    queryKey: ['scenario-recovery'],
    queryFn: () => scenarioApi.getRecovery().then(r => r.data),
    staleTime: 300000,
  });

  const mcSummary = mc?.summary || {};
  const corrs = corridors?.corridors || [];
  const econImpacts = econ?.impacts || [];
  const recoveryTimeline = recovery?.timeline || [];

  const hasMC = mcSummary.eff_drop_p90 != null;
  const hasCorridor = corrs.length > 0;
  const hasEcon = econImpacts.length > 0;
  const hasRecovery = recoveryTimeline.length > 0;

  if (!hasMC && !hasCorridor && !hasEcon) {
    return (
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-3 text-xs text-gray-400 text-center">
        <div className="text-lg mb-1">📊</div>
        Pipeline analysis data will appear here once <code className="bg-gray-200 px-1 rounded">scenario_simulation.py</code> completes.
      </div>
    );
  }

  const worstEcon = hasEcon
    ? econImpacts.reduce((a, b) => (parseFloat(b.daily_trade_loss_usd || 0) > parseFloat(a.daily_trade_loss_usd || 0) ? b : a))
    : null;

  return (
    <div className="space-y-3">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Pipeline Analysis</div>

      {/* Monte Carlo P90 */}
      {hasMC && (
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-2xl p-4">
          <div className="text-xs font-bold text-indigo-700 mb-2 flex items-center gap-1.5">
            🎲 Monte Carlo Simulation
            <span className="text-gray-400 font-normal">({mcSummary.n_iterations || 500} iterations)</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-lg font-black text-indigo-600">{mcSummary.eff_drop_p50 ?? '—'}%</div>
              <div className="text-xs text-gray-400">P50</div>
            </div>
            <div>
              <div className="text-lg font-black text-red-500">{mcSummary.eff_drop_p90 ?? '—'}%</div>
              <div className="text-xs text-gray-400">P90</div>
            </div>
            <div>
              <div className="text-lg font-black text-red-700">{mcSummary.eff_drop_p99 ?? '—'}%</div>
              <div className="text-xs text-gray-400">P99</div>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="bg-white/60 rounded-lg px-2 py-1.5">
              <span className="text-gray-400">Avg nodes failed: </span>
              <span className="font-bold text-slate-700">{mcSummary.avg_nodes_failed ?? '—'}</span>
            </div>
            <div className="bg-white/60 rounded-lg px-2 py-1.5">
              <span className="text-gray-400">P(&gt;25% drop): </span>
              <span className="font-bold text-slate-700">{mcSummary.prob_gt25pct_drop ?? '—'}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Worst-case economic impact */}
      {worstEcon && (
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-3">
          <div className="text-xs font-bold text-amber-700 mb-1.5">💰 Worst-Case Economic Impact</div>
          <div className="text-xs text-gray-600">
            <span className="font-bold text-slate-800">{worstEcon.scenario_id?.replace(/_/g, ' ')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2 text-center">
            <div className="bg-white/60 rounded-lg py-1.5">
              <div className="text-sm font-black text-red-600">
                ${(parseFloat(worstEcon.daily_trade_loss_usd || 0) / 1e6).toFixed(1)}M
              </div>
              <div className="text-xs text-gray-400">Daily trade loss</div>
            </div>
            <div className="bg-white/60 rounded-lg py-1.5">
              <div className="text-sm font-black text-amber-600">
                {parseFloat(worstEcon.trade_disruption_pct || 0).toFixed(1)}%
              </div>
              <div className="text-xs text-gray-400">Trade disrupted</div>
            </div>
          </div>
        </div>
      )}

      {/* Corridor vulnerability */}
      {hasCorridor && (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
          <div className="text-xs font-bold text-slate-700 mb-2">🛤️ Corridor Vulnerability</div>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {corrs.slice(0, 10).map((c, i) => {
              const vulnColor = { CRITICAL: '#E24B4A', HIGH: '#EF9F27', MEDIUM: '#EAB308', LOW: '#22C55E' }[c.vulnerability] || '#6B7280';
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: vulnColor }} />
                  <span className="text-slate-600 truncate flex-1">{c.corridor?.replace('→', ' → ')}</span>
                  <span className="font-bold" style={{ color: vulnColor }}>{c.vulnerability}</span>
                  {c.delay_increase_pct != null && (
                    <span className="text-gray-400">+{parseFloat(c.delay_increase_pct).toFixed(0)}%</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recovery timeline */}
      {hasRecovery && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3">
          <div className="text-xs font-bold text-green-700 mb-2">🔄 Recovery Timeline</div>
          <div className="flex items-end gap-1 h-16">
            {recoveryTimeline.map((r, i) => {
              const pct = parseFloat(r.operational_pct || 0);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="w-full bg-green-200 rounded-t relative" style={{ height: `${Math.max(pct * 0.6, 2)}px` }}>
                    <div className="absolute inset-0 bg-green-500 rounded-t" style={{ height: `${pct}%` }} />
                  </div>
                  <div className="text-xs text-gray-400" style={{ fontSize: 8 }}>
                    {r.time_hours < 24 ? `${r.time_hours}h` : `${Math.round(r.time_hours / 24)}d`}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-xs text-gray-400 mt-1 text-center">
            {recoveryTimeline[recoveryTimeline.length - 1]?.operational_pct}% operational after{' '}
            {Math.round((recoveryTimeline[recoveryTimeline.length - 1]?.time_hours || 0) / 24)} days
          </div>
        </div>
      )}
    </div>
  );
}

// ── Impact results panel ──────────────────────────────────────────────────────

function ImpactResults({ result, loading, error, scenarioType, impactedRoutes, routesFetching }) {
  if (loading) {
    return (
      <div className="space-y-3">
        <div className="bg-red-50 border border-red-100 rounded-2xl p-5 text-center">
          <svg className="animate-spin w-8 h-8 text-red-500 mx-auto mb-3" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <div className="text-slate-800 font-bold text-sm">Running simulation…</div>
          <div className="text-gray-400 text-xs mt-1">Recalculating all 861 freight corridors</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-4 text-sm text-red-700">
        <div className="font-bold mb-1">Simulation failed</div>
        <div className="text-xs text-red-500">{error}</div>
      </div>
    );
  }

  if (!result) return null;

  const totalAffected = result.total_affected ?? 0;
  const unreachable   = result.unreachable_pairs ?? 0;
  const delayed       = result.delayed_pairs ?? 0;
  const avgDelay      = result.avg_delay_pct ?? 0;
  const maxDelay      = result.max_delay_pct ?? 0;
  const impacts       = result.top_impacts || [];
  const severity      = totalAffected > 0 ? Math.round((totalAffected / 861) * 100) : 0;

  // Zero-affected: show a clear "resilient" result with explanation
  if (totalAffected === 0 && !impacts.length) {
    return (
      <div className="space-y-3">
        <div className="bg-green-50 border border-green-200 rounded-2xl p-4 text-center">
          <div className="text-3xl mb-2">✅</div>
          <div className="font-black text-green-700 text-sm mb-1">No Route Disruptions Detected</div>
          <div className="text-xs text-gray-500 leading-relaxed">
            None of the 861 pre-computed trade corridors pass through this terminal as a critical node.
            The network can reroute around this closure automatically.
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 text-xs text-blue-700">
          <div className="font-bold mb-1">💡 What this means</div>
          <div className="leading-relaxed">
            This terminal is not a major chokepoint for freight routes between ports, inland depots, and rail stations.
            Try simulating closure of a major port (e.g. Karachi Port or Bin Qasim) to see significant network impact.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary headline */}
      <div className="bg-gradient-to-br from-red-50 to-red-100 border border-red-200 rounded-2xl p-4">
        <div className="text-xs text-gray-400 mb-1">Freight corridors disrupted</div>
        <div className="text-4xl font-black text-red-500">{totalAffected.toLocaleString()}</div>
        <div className="text-xs text-gray-400 mt-1">out of 861 pre-computed routes in the network</div>
        <div className="mt-3 h-2 bg-red-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-red-500 transition-all duration-1000"
            style={{ width: `${severity}%` }} />
        </div>
        <div className="flex justify-between text-xs mt-1">
          <span className="text-gray-400">Network impact</span>
          <span className="text-slate-700 font-bold">{severity}% of corridors</span>
        </div>
      </div>

      {/* Map visualization status badge */}
      <div className={`rounded-xl px-3 py-2 text-xs border flex items-center gap-2 ${
        routesFetching && !impactedRoutes
          ? 'bg-blue-50 border-blue-100 text-blue-600'
          : impactedRoutes?.length
          ? 'bg-slate-50 border-slate-200 text-slate-600'
          : 'bg-gray-50 border-gray-100 text-gray-400'
      }`}>
        {routesFetching && !impactedRoutes ? (
          <>
            <svg className="animate-spin w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span>Fetching actual route paths from network…</span>
          </>
        ) : impactedRoutes?.length ? (
          <>
            <span className="text-green-500 flex-shrink-0">🗺</span>
            <span>
              <span className="font-bold text-slate-700">
                {new Set(impactedRoutes.map(f => `${f.properties?._from}→${f.properties?._to}`)).size}
              </span> representative routes plotted on map
              <span className="text-gray-400"> (of {totalAffected} affected)</span>
              {' — '}affected corridors may share physical rail/road segments
            </span>
          </>
        ) : (
          <span>Map route paths unavailable — check the Results panel</span>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-center">
          <div className="text-2xl font-black text-red-500">{unreachable}</div>
          <div className="text-xs text-gray-400 mt-0.5">Routes completely</div>
          <div className="text-xs font-bold text-red-600">cut off</div>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-center">
          <div className="text-2xl font-black text-amber-600">{delayed}</div>
          <div className="text-xs text-gray-400 mt-0.5">Routes</div>
          <div className="text-xs font-bold text-amber-700">significantly delayed</div>
        </div>
      </div>

      {/* Explain the "always 41" pattern when a single facility closes */}
      {totalAffected > 0 && unreachable === totalAffected && (
        <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-xs text-slate-500 leading-relaxed">
          <span className="font-semibold text-slate-700">Why {totalAffected}?</span>
          {' '}The network has 42 key facilities. Closing one removes all pre-computed routes involving it — {totalAffected} corridors to/from the other {totalAffected} terminals.
          Routes are <span className="font-semibold">UNREACHABLE</span> because the system has no alternative path that avoids this terminal entirely.
        </div>
      )}

      {maxDelay > 0 && (
        <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5 grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-gray-400">Average delay</div>
            <div className="text-amber-600 font-black text-lg">+{avgDelay.toFixed(0)}%</div>
            <div className="text-gray-400">longer journey</div>
          </div>
          <div>
            <div className="text-gray-400">Worst route</div>
            <div className="text-red-500 font-black text-lg">+{maxDelay.toFixed(0)}%</div>
            <div className="text-gray-400">longest delay</div>
          </div>
        </div>
      )}

      {unreachable > 0 && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 text-xs text-blue-700">
          <div className="font-bold mb-1">💡 Recommended action</div>
          <div>
            {scenarioType === 'node_removal'
              ? `With this terminal closed, ${unreachable} freight corridor${unreachable > 1 ? 's have' : ' has'} no alternative route. Consider rerouting via the nearest open terminal.`
              : `${unreachable} trade corridor${unreachable > 1 ? 's' : ''} can no longer complete their journey. Activate contingency routing plans.`}
          </div>
        </div>
      )}

      {/* Affected routes */}
      {impacts.length > 0 && (
        <div>
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Most Affected Trade Routes</div>
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {impacts.map((imp, i) => (
              <div key={i} className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5">
                <div className="text-xs font-bold text-slate-700 mb-1 flex items-center gap-1 flex-wrap">
                  <span className="truncate max-w-[90px]">{imp.source_name || imp.source}</span>
                  <span className="text-gray-300 flex-shrink-0">→</span>
                  <span className="truncate max-w-[90px]">{imp.target_name || imp.target}</span>
                </div>
                {imp.status === 'UNREACHABLE' ? (
                  <span className="inline-flex items-center gap-1 bg-red-100 border border-red-200 text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">
                    🚫 No alternative route available
                  </span>
                ) : (
                  <div className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="text-gray-400">{imp.baseline?.toFixed(1)}h normal</span>
                    <span className="text-gray-300">→</span>
                    <span className="text-amber-600 font-bold">{imp.disrupted?.toFixed(1)}h disrupted</span>
                    <span className="bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded-full border border-amber-200">
                      +{(imp.delay_pct || 0).toFixed(0)}% slower
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {result._note && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl px-3 py-2 text-xs text-blue-600">
          ℹ️ {result._note}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ScenarioSimulator() {
  const [searchParams] = useSearchParams();

  // Support ?target=id1,id2 (comma-separated) from chat multi-target actions
  const [targets,      setTargets]      = useState(() => {
    const t = searchParams.get('target') || searchParams.get('targets');
    if (!t) return [];
    return t.split(',').map(s => s.trim()).filter(Boolean);
  });
  const [scenarioType, setScenarioType] = useState(() => {
    const t = searchParams.get('type');
    const valid = ['node_removal','edge_closure','capacity_reduction','flood','cyclone','strike','accident'];
    return valid.includes(t) ? t : 'node_removal';
  });
  const [severity,     setSeverity]     = useState(() => {
    const s = parseFloat(searchParams.get('severity'));
    return isNaN(s) ? 1.0 : Math.min(1.0, Math.max(0.1, s));
  });
  const [duration,     setDuration]     = useState(24);
  const [result,              setResult]              = useState(null);
  const [loading,             setLoading]             = useState(false);
  const [error,               setError]               = useState(null);
  const [affectedIds,         setAffectedIds]         = useState([]);
  const [impactedRoutes,   setImpactedRoutes]   = useState(null);
  const [routesFetching,   setRoutesFetching]   = useState(false);
  const [showCorridors,    setShowCorridors]    = useState(true);
  const runIdRef = useRef(0); // incremented on every new run + cancel to abort stale fetches
  const [leftOpen,     setLeftOpen]     = useState(true);
  const [rightOpen,    setRightOpen]    = useState(true);

  const { data: facilityGeoJSON } = useQuery({
    queryKey: ['combined-facilities'],
    queryFn:  () => combinedApi.getNodes({ type: 'port,dryport,station,rail_station' }).then(r => r.data),
    staleTime: 120000,
  });

  const facilities = useMemo(
    () => facilityGeoJSON?.features?.map(f => f.properties).filter(Boolean) || [],
    [facilityGeoJSON]
  );

  const clearSimulation = useCallback(() => {
    runIdRef.current += 1;       // abort any in-flight route fetch
    setResult(null);
    setAffectedIds([]);
    setImpactedRoutes(null);
    setRoutesFetching(false);
  }, []);

  const handleFacilityClick = useCallback((assetId) => {
    setTargets(prev => prev.includes(assetId) ? prev.filter(t => t !== assetId) : [...prev, assetId]);
    clearSimulation();
  }, [clearSimulation]);

  // runSimulation must be declared BEFORE the autoRan useEffect that references it
  const runSimulation = useCallback(async () => {
    if (!targets.length) return;

    // Increment run ID so any pending background fetch from a previous run is ignored
    runIdRef.current += 1;
    const thisRun = runIdRef.current;

    setLoading(true); setError(null); setResult(null); setAffectedIds([]);
    setImpactedRoutes(null); setRoutesFetching(false);

    try {
      const res = await scenarioApi.run({
        scenario_type:  scenarioType,
        targets:        targets.map(String),
        severity:       parseFloat(severity),
        duration_hours: parseInt(duration),
      });
      const data = res.data || {};
      setResult(data);

      // Highlighted affected facilities (orange glow)
      const affIds = (data.top_impacts || [])
        .filter(i => i.status === 'UNREACHABLE' || (i.delay_pct || 0) > 15)
        .flatMap(i => [i.source, i.target].filter(Boolean));
      setAffectedIds([...new Set(affIds)]);

      // ── Background-fetch REAL route geometry ─────────────────────────────────
      const topImpacts = data.top_impacts || [];

      // Strategy: prefer routes WHERE a target is the SOURCE (routes radiating OUT
      // from the closed terminal). These look more natural on the map and clearly
      // show which corridors the terminal was serving.
      const fromTarget = topImpacts.filter(i => targets.includes(i.source));
      const toTarget   = topImpacts.filter(i => !targets.includes(i.source));

      const toFetch = [
        // Radiating OUT from the closed terminal (UNREACHABLE)
        ...fromTarget.filter(i => i.status === 'UNREACHABLE').slice(0, 8),
        // Routes TO the terminal if we don't have enough "from" ones
        ...toTarget  .filter(i => i.status === 'UNREACHABLE').slice(0, Math.max(0, 8 - fromTarget.filter(i => i.status === 'UNREACHABLE').length)),
        // Delayed corridors (up to 6)
        ...fromTarget.filter(i => i.status !== 'UNREACHABLE' && (i.delay_pct || 0) > 20).slice(0, 6),
      ].filter(i => i.source && i.target)
       // Deduplicate by pair
       .filter((imp, idx, arr) => arr.findIndex(x => x.source === imp.source && x.target === imp.target) === idx);

      if (toFetch.length > 0) {
        setRoutesFetching(true);
        Promise.all(toFetch.map(async (imp) => {
          try {
            const routeRes = await networkApi.getAdvancedRoutes(
              imp.source, imp.target, 'any', { hazardWeight: 0, riskWeight: 0 }
            );
            const routes  = routeRes.data?.routes || [];
            const fastest = routes.find(r => r.type === 'FASTEST') || routes[0];
            if (!fastest?.geometry?.features?.length) return null;

            return fastest.geometry.features
              .filter(f => f.geometry?.coordinates?.length)
              .map(f => ({
                ...f,
                properties: {
                  ...f.properties,
                  _status:    imp.status || 'DELAYED',
                  _delay_pct: imp.delay_pct || 0,
                  _from:      imp.source_name || imp.source,
                  _to:        imp.target_name || imp.target,
                  _baseline:  fastest.travel_time_hr,
                },
              }));
          } catch { return null; }
        })).then(results => {
          if (runIdRef.current !== thisRun) return; // simulation was cancelled or replaced
          setRoutesFetching(false);
          const allFeats = results.filter(Boolean).flat();
          setImpactedRoutes(allFeats.length > 0 ? allFeats : null);
        }).catch(() => {
          if (runIdRef.current === thisRun) setRoutesFetching(false);
        });
      }

      setRightOpen(true);
    } catch (err) {
      const errMsg = err?.response?.data?.error || err?.message || 'Simulation failed.';
      setError(errMsg);
    }
    setLoading(false);
  }, [targets, scenarioType, severity, duration]);

  // Auto-run when navigated from chat — track by URL params so each new navigation re-fires
  const autoRanFor = useRef('');
  useEffect(() => {
    const urlTarget = searchParams.get('target') || '';
    if (!urlTarget || !targets.length || !facilities.length) return;
    if (autoRanFor.current === urlTarget) return; // already ran for this exact param set
    // Only auto-run when current targets match URL params (not manually added targets)
    if (!targets.some(t => urlTarget.split(',').includes(t))) return;
    autoRanFor.current = urlTarget;
    const timer = setTimeout(() => runSimulation(), 800);
    return () => clearTimeout(timer);
  }, [targets, facilities, searchParams, runSimulation]);

  const selectedScenario = SCENARIO_TYPES.find(s => s.id === scenarioType) || SCENARIO_TYPES[0];
  const targetFacilities = useMemo(() => targets.map(id => facilities.find(f => f.asset_id === id)).filter(Boolean), [targets, facilities]);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-gray-100">
      {/* Full-screen map */}
      <div className="absolute inset-0">
        <ScenarioMap
          targets={targets}
          affectedIds={affectedIds}
          isRunning={loading}
          impactedRoutes={impactedRoutes}
          showCorridors={showCorridors}
          hasResults={!!result}
          onFacilityClick={handleFacilityClick}
        />
      </div>

      {/* ── Map impact legend — bottom-left ── */}
      {result && (
        <div className="absolute bottom-6 left-3 z-20 bg-white shadow-xl rounded-2xl border border-gray-200 overflow-hidden" style={{ minWidth: 210 }}>

          {/* Header */}
          <div className="px-3 py-2.5 bg-gray-50 border-b border-gray-100">
            <div className="text-xs font-bold text-slate-700">Disruption Map</div>
            <div className="text-xs text-gray-400 mt-0.5">Actual road/rail routes affected</div>
          </div>

          {/* Legend rows */}
          <div className="px-3 py-2.5 space-y-2">
            {/* UNREACHABLE */}
            <div className="flex items-center gap-2.5">
              <svg width="32" height="10" className="flex-shrink-0">
                <rect x="0" y="3" width="32" height="5" rx="2.5" fill="#E24B4A" opacity="0.2"/>
                <rect x="0" y="3.5" width="32" height="4" rx="2" fill="#E24B4A"/>
              </svg>
              <div className="min-w-0">
                <div className="text-xs font-bold text-red-600">Route cut off</div>
                <div className="text-xs text-gray-400">No alternative available</div>
              </div>
            </div>

            {/* HIGH DELAY */}
            <div className="flex items-center gap-2.5">
              <svg width="32" height="10" className="flex-shrink-0">
                <line x1="0" y1="5" x2="32" y2="5" stroke="#EF9F27" strokeWidth="3.5"
                      strokeDasharray="7,4" strokeLinecap="round"/>
              </svg>
              <div className="min-w-0">
                <div className="text-xs font-bold text-amber-600">High delay — &gt;50%</div>
                <div className="text-xs text-gray-400">Significantly longer journey</div>
              </div>
            </div>

            {/* MODERATE DELAY */}
            <div className="flex items-center gap-2.5">
              <svg width="32" height="10" className="flex-shrink-0">
                <line x1="0" y1="5" x2="32" y2="5" stroke="#EAB308" strokeWidth="2.5"
                      strokeDasharray="5,5" strokeLinecap="round"/>
              </svg>
              <div className="min-w-0">
                <div className="text-xs font-bold text-yellow-600">Moderate delay — &lt;50%</div>
                <div className="text-xs text-gray-400">Alternative routes exist</div>
              </div>
            </div>
          </div>

          {/* Sync counter */}
          <div className="px-3 pb-2.5 border-t border-gray-100 pt-2">
            {routesFetching && !impactedRoutes ? (
              <div className="text-xs text-blue-500 flex items-center gap-1.5">
                <svg className="animate-spin w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Fetching route paths from network…
              </div>
            ) : impactedRoutes ? (
              <>
                <div className="text-xs text-gray-500 leading-relaxed">
                  <span className="font-bold text-slate-700">
                    {new Set(impactedRoutes.map(f => f.properties?._from + '→' + f.properties?._to)).size}
                  </span> representative routes plotted
                  {result?.total_affected > 0 && (
                    <span className="text-gray-400"> of {result.total_affected} total affected</span>
                  )}
                </div>
                <div className="text-xs text-gray-400 mt-1 leading-tight">
                  Multiple affected routes often share the same physical corridor — lines may overlap.
                </div>
                <div className="text-xs text-blue-500 mt-1">Hover any line for corridor details</div>
              </>
            ) : (
              <div className="text-xs text-gray-400">No routes to visualize</div>
            )}
          </div>

          {/* Visibility toggle */}
          <div className="border-t border-gray-100">
            <button onClick={() => setShowCorridors(v => !v)}
              className={`w-full text-xs font-semibold py-2 transition ${
                showCorridors ? 'text-red-600 hover:bg-red-50' : 'text-gray-400 hover:bg-gray-50'
              }`}>
              {showCorridors ? '👁 Hide route overlays' : '👁 Show route overlays'}
            </button>
          </div>
        </div>
      )}

      {/* Loading spinner before legend appears */}
      {routesFetching && !impactedRoutes && result && !showCorridors === false && (
        <div className="absolute bottom-6 left-3 z-20 bg-white/96 rounded-xl border border-blue-200 shadow-lg px-3 py-2 text-xs text-blue-600 flex items-center gap-2">
          <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          Plotting route paths on map…
        </div>
      )}

      {/* Running overlay animation */}
      {loading && (
        <div className="absolute inset-0 z-30 pointer-events-none">
          <div className="absolute inset-0 bg-white/50 animate-pulse" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
            <div className="w-20 h-20 mx-auto mb-4 relative">
              <div className="absolute inset-0 border-4 border-red-400/40 rounded-full animate-ping" />
              <div className="absolute inset-2 border-4 border-red-500/60 rounded-full animate-pulse" />
              <div className="absolute inset-4 bg-red-500 rounded-full flex items-center justify-center text-2xl">⚡</div>
            </div>
            <div className="text-slate-800 font-black text-lg drop-shadow-sm">Simulating…</div>
            <div className="text-gray-500 text-sm mt-1 drop-shadow-sm">Recalculating 861 freight corridors</div>
          </div>
        </div>
      )}

      {/* Shared topbar */}
      <Topbar mode="floating" title="Scenario Simulator" />

      {/* Panel toggles */}
      <div className="absolute top-[56px] right-3 z-20 flex gap-1.5 mt-1.5">
        <button onClick={() => setLeftOpen(o => !o)}
          className="bg-white border border-gray-200 text-slate-700 text-xs font-bold px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition shadow-sm">
          {leftOpen ? '◀ Setup' : '▶ Setup'}
        </button>
        {result && (
          <button onClick={() => setRightOpen(o => !o)}
            className="bg-white border border-gray-200 text-slate-700 text-xs font-bold px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition shadow-sm">
            {rightOpen ? 'Results ▶' : '◀ Results'}
          </button>
        )}
      </div>

      {/* ── LEFT PANEL — Setup ── */}
      <div className={`absolute top-0 left-0 bottom-0 z-10 flex flex-col transition-transform duration-300 ${leftOpen ? 'translate-x-0' : '-translate-x-full'}`} style={{ width: 320 }}>
        <div className="absolute inset-0 bg-white border-r border-gray-200 shadow-md" />
        <div className="relative flex flex-col h-full overflow-y-auto" style={{ paddingTop: 62 }}>
          <div className="px-4 pb-4 space-y-4 flex-1">

            {/* Step 1: Pick targets */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-black ${targets.length > 0 ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
                  {targets.length > 0 ? '✓' : '1'}
                </div>
                <div className="text-xs font-bold text-slate-700">Choose Target{targets.length > 1 ? 's' : ''}</div>
                {targets.length > 0 && (
                  <button onClick={() => { setTargets([]); clearSimulation(); }}
                    className="ml-auto text-red-500 hover:text-red-600 text-xs transition">
                    Clear all
                  </button>
                )}
              </div>

              {/* Targets list */}
              <div className="space-y-1.5 mb-2">
                {targetFacilities.length > 0 ? (
                  targetFacilities.map(f => (
                    <TargetChip
                      key={f.asset_id}
                      assetId={f.asset_id}
                      name={f.display_name || f.name || resolveNodeName(f)}
                      nodeType={f.node_type}
                      onRemove={id => { setTargets(p => p.filter(t => t !== id)); clearSimulation(); }}
                    />
                  ))
                ) : (
                  <div className="border-2 border-dashed border-gray-200 rounded-xl py-5 text-center text-xs text-gray-400">
                    <div className="text-2xl mb-1.5">🖱️</div>
                    Click any terminal on the map<br />to add it as a target
                  </div>
                )}
              </div>

              {/* Quick picker */}
              {targets.length === 0 && facilities.length > 0 && (
                <div>
                  <div className="text-xs text-gray-400 mb-1.5">Or pick quickly:</div>
                  <select
                    onChange={e => { if (e.target.value) { setTargets([e.target.value]); e.target.value = ''; } }}
                    className="w-full bg-white border border-gray-300 text-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-slate-400">
                    <option value="">Select a terminal…</option>
                    {['port','dryport','station','rail_station'].map(type => {
                      const group = facilities.filter(f => f.node_type === type);
                      if (!group.length) return null;
                      const label = { port:'Sea Ports', dryport:'Inland Terminals', station:'Rail Stations', rail_station:'Rail Stations' }[type];
                      return (
                        <optgroup key={type} label={label}>
                          {group.map(f => <option key={f.asset_id} value={f.asset_id}>{f.display_name || f.name}</option>)}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>

            {/* Step 2: Pick scenario */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-xs font-black">2</div>
                <div className="text-xs font-bold text-slate-700">Choose What Happens</div>
              </div>
              <div className="space-y-1">
                {SCENARIO_TYPES.map(s => (
                  <button key={s.id} onClick={() => { setScenarioType(s.id); clearSimulation(); }}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition group ${
                      scenarioType === s.id ? 'border-slate-300 bg-gray-50' : 'border-gray-100 hover:bg-gray-50'
                    }`}>
                    <div className="flex items-center gap-2.5">
                      <span className="text-lg flex-shrink-0">{s.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs font-bold ${scenarioType === s.id ? 'text-slate-900' : 'text-slate-600'}`}>{s.label}</div>
                        {scenarioType === s.id && (
                          <div className="text-xs text-gray-400 mt-0.5 leading-relaxed">{s.desc}</div>
                        )}
                      </div>
                      {scenarioType === s.id && <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Step 3: Configure */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-xs font-black">3</div>
                <div className="text-xs font-bold text-slate-700">Configure</div>
              </div>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-gray-500">Severity</span>
                    <span className="text-slate-800 font-bold">{Math.round(severity * 100)}%</span>
                  </div>
                  <input type="range" min={0.1} max={1.0} step={0.05} value={severity}
                    onChange={e => setSeverity(+e.target.value)}
                    className="w-full h-2 accent-red-500 cursor-pointer" />
                  <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                    <span>Minor (10%)</span><span>Complete (100%)</span>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-bold text-gray-500 mb-1.5">Duration</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {[6, 12, 24, 48, 72, 168].map(h => (
                      <button key={h} onClick={() => setDuration(h)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition ${
                          duration === h ? 'bg-slate-800 text-white border-slate-800' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}>
                        {h < 24 ? `${h}h` : `${h/24}d`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Run button */}
            <button
              onClick={runSimulation}
              disabled={!targets.length || loading}
              className="w-full py-3.5 rounded-2xl font-black text-sm transition text-white disabled:opacity-40"
              style={{ backgroundColor: targets.length && !loading ? selectedScenario.color : '#d1d5db' }}>
              {loading
                ? <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Simulating…
                  </span>
                : targets.length
                ? `${selectedScenario.icon} Run "${selectedScenario.label}" Scenario`
                : 'Select a terminal to simulate'}
            </button>

            {/* Legend */}
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 text-xs">
              <div className="text-gray-400 font-bold uppercase tracking-wide mb-2">Map Legend</div>
              {[
                { color: '#E24B4A', label: 'Selected target (disrupted)' },
                { color: '#EF9F27', label: 'Affected terminal (delay)' },
                { color: '#D85A30', label: 'Sea Port' },
                { color: '#534AB7', label: 'Inland Terminal' },
                { color: '#1D9E75', label: 'Rail Station' },
              ].map(({ color, label }) => (
                <div key={label} className="flex items-center gap-2 mb-1.5 text-gray-500">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                  {label}
                </div>
              ))}
            </div>

          </div>
        </div>
      </div>

      {/* ── RIGHT PANEL — Results ── */}
      {(result || loading || error) && rightOpen && (
        <div className="absolute top-0 right-0 bottom-0 z-10 flex flex-col" style={{ width: 360 }}>
          <div className="absolute inset-0 bg-white border-l border-gray-200 shadow-md" />
          <div className="relative flex flex-col h-full" style={{ paddingTop: 62 }}>
            <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
              <div className="text-slate-900 font-black text-sm">
                {selectedScenario.icon} {selectedScenario.label} Results
              </div>
              <div className="text-gray-400 text-xs mt-0.5">
                {targetFacilities.map(f => f.display_name || f.name || f.asset_id).join(', ')} · {Math.round(severity * 100)}% severity
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <ImpactResults
                result={result}
                loading={loading}
                error={error}
                scenarioType={scenarioType}
                impactedRoutes={impactedRoutes}
                routesFetching={routesFetching}
              />

              {/* AI narrative analysis — appears after numeric results */}
              {result && !loading && (
                <AIInsight
                  result={result}
                  targetNames={targetFacilities.map(f => f.display_name || f.name || f.asset_id)}
                  scenarioType={scenarioType}
                  severity={severity}
                />
              )}

              {/* Pipeline offline analysis (Monte Carlo, corridors, economic, recovery) — always shown when data exists */}
              <div className={`${result && !loading ? 'mt-4 pt-4 border-t border-gray-100' : 'mt-2'}`}>
                <PipelineAnalysis />
              </div>

              {result && !loading && (
                <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
                  <div className="text-xs text-gray-400 font-bold uppercase tracking-wide mb-2">Map Controls</div>

                  <div className="text-xs text-gray-400 font-bold uppercase tracking-wide mb-1">Next Steps</div>
                  <Link to="/routes"
                    className="flex items-center gap-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-slate-700 transition">
                    🛣️ Find alternative routes avoiding this disruption
                  </Link>
                  <button onClick={() => { clearSimulation(); setRightOpen(false); }}
                    className="w-full flex items-center gap-2 bg-gray-50 hover:bg-gray-100 border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 transition">
                    ↺ Run another simulation
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
