/**
 * RouteVisualizationMap
 *
 * Key features:
 * - Segments colored by RISK TIER by default (CRITICAL=red, HIGH=orange, etc.)
 * - Toggle to color by transport mode
 * - Hover popup on route segments showing risk details
 * - Facility nodes colored by their live risk tier
 * - Progressive road background load (cached)
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { combinedApi, networkApi } from '../../api/networkApi';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { TIER_COLOR } from '../../styles/tokens';

// ── Module-level edge cache ───────────────────────────────────────────────────
const _cache = {};
const CACHE_TTL = 25 * 60 * 1000;
function cacheGet(k) { const c = _cache[k]; return c && Date.now() - c.ts < CACHE_TTL ? c.v : null; }
function cacheSet(k, v) { _cache[k] = { v, ts: Date.now() }; }

// ── MapLibre expressions ──────────────────────────────────────────────────────
const RISK_TIER_EXPR = [
  'match', ['get', 'risk_tier'],
  'CRITICAL', TIER_COLOR.CRITICAL,
  'HIGH',     TIER_COLOR.HIGH,
  'MEDIUM',   TIER_COLOR.MEDIUM,
  'LOW',      TIER_COLOR.LOW,
  '#534AB7',
];

const MODE_COLOR_EXPR = [
  'match', ['get', 'mode'],
  'road',       '#534AB7',
  'rail',       '#1D9E75',
  'intermodal', '#EF9F27',
  '#534AB7',
];

const FACILITY_RISK_EXPR = [
  'match', ['get', 'risk_tier'],
  'CRITICAL', TIER_COLOR.CRITICAL,
  'HIGH',     TIER_COLOR.HIGH,
  'MEDIUM',   TIER_COLOR.MEDIUM,
  'LOW',      TIER_COLOR.LOW,
  '#64748B',
];

function normalizeGeoJSON(geojson) {
  if (!geojson) return null;
  if (typeof geojson === 'string') { try { return JSON.parse(geojson); } catch { return null; } }
  if (geojson.type === 'FeatureCollection') {
    return {
      ...geojson,
      features: (geojson.features || []).map(f => ({
        ...f,
        geometry: typeof f?.geometry === 'string' ? normalizeGeoJSON(f.geometry) : f?.geometry,
      })),
    };
  }
  return geojson;
}

function sqDist(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = (a[0] || 0) - (b[0] || 0);
  const dy = (a[1] || 0) - (b[1] || 0);
  return dx * dx + dy * dy;
}

function geometryEndpoints(geometry) {
  if (!geometry || !geometry.coordinates) return { start: null, end: null };
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates;
    if (!coords.length) return { start: null, end: null };
    return { start: coords[0], end: coords[coords.length - 1] };
  }
  if (geometry.type === 'MultiLineString') {
    const parts = geometry.coordinates || [];
    if (!parts.length) return { start: null, end: null };
    const first = parts[0] || [];
    const last = parts[parts.length - 1] || [];
    if (!first.length || !last.length) return { start: null, end: null };
    return { start: first[0], end: last[last.length - 1] };
  }
  return { start: null, end: null };
}

function reverseGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return geometry;
  if (geometry.type === 'LineString') {
    return { ...geometry, coordinates: [...geometry.coordinates].reverse() };
  }
  if (geometry.type === 'MultiLineString') {
    const reversedParts = [...geometry.coordinates].reverse().map((part) => [...part].reverse());
    return { ...geometry, coordinates: reversedParts };
  }
  return geometry;
}

function orientRouteFeatures(routeGeo) {
  if (!routeGeo?.features?.length) return routeGeo;
  let prevEnd = null;
  const oriented = routeGeo.features.map((feature) => {
    const geom = feature?.geometry;
    const { start, end } = geometryEndpoints(geom);
    if (!start || !end) return feature;

    let nextFeature = feature;
    if (prevEnd) {
      const startDist = sqDist(prevEnd, start);
      const endDist = sqDist(prevEnd, end);
      if (endDist < startDist) {
        nextFeature = { ...feature, geometry: reverseGeometry(geom) };
      }
    }

    prevEnd = geometryEndpoints(nextFeature.geometry).end;
    return nextFeature;
  });

  return { ...routeGeo, features: oriented };
}

function riskTierLabel(tier) {
  return { CRITICAL: 'Critical Risk — Avoid', HIGH: 'High Risk', MEDIUM: 'Moderate Risk', LOW: 'Low Risk' }[tier] || tier;
}

// ── Risk summary from route features ─────────────────────────────────────────
function routeRiskSummary(features) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const kmByTier = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let totalKm = 0;
  for (const f of (features || [])) {
    const p = f.properties || {};
    const tier = p.risk_tier || 'LOW';
    const km = parseFloat(p.length_km || 0);
    counts[tier] = (counts[tier] || 0) + 1;
    kmByTier[tier] = (kmByTier[tier] || 0) + km;
    totalKm += km;
  }
  return { counts, kmByTier, totalKm };
}

// ── Main Component ────────────────────────────────────────────────────────────
const RouteVisualizationMap = ({ selectedRoute = null, onMapReady }) => {
  const mapContainer = useRef(null);
  const map          = useRef(null);
  const popup        = useRef(null);
  const routeMarkers = useRef([]);
  const [ready,       setReady]       = useState(false);
  const [colorByRisk, setColorByRisk] = useState(true);
  const [showRoads,   setShowRoads]   = useState(true);
  const [showRail,    setShowRail]    = useState(true);
  const [roadLoading, setRoadLoading] = useState(false);
  const [roadCount,   setRoadCount]   = useState(0);

  const { data: facilities } = useQuery({
    queryKey: ['combined-facilities-route'],
    queryFn: () => combinedApi.getNodes({ type: 'port,dryport,station,rail_station' }).then(r => r.data),
    staleTime: 120000,
  });
  const { data: pkBound } = useQuery({
    queryKey: ['pakistan-boundary'],
    queryFn: () => networkApi.getPakistanBoundary().then(r => r.data).catch(() => null),
    staleTime: Infinity,
  });

  // ── Init map ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (map.current) return;
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [68, 30], zoom: 5, antialias: true,
    });
    map.current.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.current.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.current.on('load', () => {
      setReady(true);
      if (onMapReady) onMapReady(map.current);
    });
    return () => { if (popup.current) popup.current.remove(); };
  }, []);

  // ── Pakistan boundary ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !pkBound || map.current.getSource('pk')) return;
    map.current.addSource('pk', { type: 'geojson', data: pkBound });
    map.current.addLayer({ id: 'pk-fill', type: 'fill',   source: 'pk', paint: { 'fill-color': '#e8f4f8', 'fill-opacity': 0.12 } });
    map.current.addLayer({ id: 'pk-line', type: 'line',   source: 'pk', paint: { 'line-color': '#334155', 'line-width': 1.5, 'line-opacity': 0.6 } });
  }, [pkBound, ready]);

  // ── Road background (cached, first 2000 only for speed) ──────────────────
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const add = (feats) => {
      const fc = { type: 'FeatureCollection', features: feats };
      if (map.current.getSource('roads')) { map.current.getSource('roads').setData(fc); return; }
      map.current.addSource('roads', { type: 'geojson', data: fc });
      map.current.addLayer({
        id: 'roads-layer', type: 'line', source: 'roads',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['downcase', ['get', 'road_type']], 'motorway', '#D85A30', 'trunk', '#EF9F27', 'primary', '#378ADD', '#C4C9D4'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 10, 2],
          'line-opacity': 0.45,
        },
      });
    };
    const cached = cacheGet('road');
    if (cached) { add(cached); setRoadCount(cached.length); return; }
    setRoadLoading(true);
    (async () => {
      const r = await combinedApi.getEdges({ mode: 'road', limit: 2000, offset: 0 }).catch(() => null);
      if (cancelled) return;
      const feats = r?.data?.features || [];
      add(feats);
      if (feats.length) cacheSet('road', feats);
      setRoadCount(feats.length);
      setRoadLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ready]);

  // ── Rail background ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const add = (feats) => {
      const fc = { type: 'FeatureCollection', features: feats };
      if (map.current.getSource('rail')) { map.current.getSource('rail').setData(fc); return; }
      map.current.addSource('rail', { type: 'geojson', data: fc });
      map.current.addLayer({
        id: 'rail-layer', type: 'line', source: 'rail',
        paint: { 'line-color': '#1D9E75', 'line-width': 2, 'line-opacity': 0.5, 'line-dasharray': [5, 3] },
      });
    };
    const cached = cacheGet('rail');
    if (cached) { add(cached); return; }
    combinedApi.getEdges({ mode: 'rail' }).then(r => {
      if (!cancelled && r?.data?.features) { cacheSet('rail', r.data.features); add(r.data.features); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [ready]);

  // ── Facility nodes with live risk coloring ────────────────────────────────
  useEffect(() => {
    if (!ready || !facilities) return;
    if (map.current.getSource('fac')) { map.current.getSource('fac').setData(facilities); return; }
    map.current.addSource('fac', { type: 'geojson', data: facilities });

    map.current.addLayer({
      id: 'fac-glow', type: 'circle', source: 'fac',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 16, 12, 30],
        'circle-color': FACILITY_RISK_EXPR, 'circle-opacity': 0.12,
      },
    });
    map.current.addLayer({
      id: 'fac-circle', type: 'circle', source: 'fac',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 12, 14],
        'circle-color': FACILITY_RISK_EXPR, 'circle-opacity': 0.95,
        'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff',
      },
    });
    map.current.addLayer({
      id: 'fac-labels', type: 'symbol', source: 'fac',
      layout: {
        'text-field': ['coalesce', ['get', 'display_name'], ['get', 'name'], ['get', 'asset_id']],
        'text-size': 11, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true,
      },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#fff', 'text-halo-width': 2.5 },
      minzoom: 5,
    });

    // Hover popup on facilities
    map.current.on('mouseenter', 'fac-circle', e => {
      map.current.getCanvas().style.cursor = 'pointer';
      const f = e.features[0].properties;
      const name = f.display_name || f.name || f.asset_id;
      const riskC = TIER_COLOR[f.risk_tier] || '#6B7280';
      const riskPct = Math.round((f.composite_risk || 0) * 100);
      const hazPct  = Math.round((f.composite_hazard || 0) * 100);
      const typeMap = { port: '🚢 Sea Port', dryport: '🏭 Inland Terminal', station: '🚂 Railway Station', rail_station: '🚂 Railway Station' };
      if (popup.current) popup.current.remove();
      popup.current = new maplibregl.Popup({ offset: 14, closeButton: false, maxWidth: '220px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div style="background:#fff;padding:12px 14px;border-radius:10px;font-family:system-ui">
          <div style="font-weight:800;font-size:13px;color:#0f172a;margin-bottom:4px">${name}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px">${typeMap[f.node_type] || f.node_type}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="background:${riskC}15;color:${riskC};border:1px solid ${riskC}35;border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">${f.risk_tier || 'N/A'}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;font-size:11px;color:#94a3b8">
            <span>Risk score</span><span style="color:#0f172a;font-weight:700;text-align:right">${riskPct}%</span>
            <span>Threat level</span><span style="color:#0f172a;font-weight:700;text-align:right">${hazPct}%</span>
          </div>
        </div>`)
        .addTo(map.current);
    });
    map.current.on('mouseleave', 'fac-circle', () => {
      map.current.getCanvas().style.cursor = '';
      if (popup.current) { popup.current.remove(); popup.current = null; }
    });
  }, [facilities, ready]);

  // ── Route segments — colored by risk tier or mode ─────────────────────────
  useEffect(() => {
    if (!ready) return;

    // Remove any markers from the previously selected route.
    routeMarkers.current.forEach(marker => marker.remove());
    routeMarkers.current = [];

    // Remove old route layers
    ['route-casing','route-disruption-glow','route-main','route-critical-dash','route-intermodal'].forEach(id => {
      if (map.current.getLayer(id)) map.current.removeLayer(id);
    });
    if (map.current.getSource('route')) map.current.removeSource('route');

    const routeGeo = orientRouteFeatures(normalizeGeoJSON(selectedRoute?.geometry));
    if (!routeGeo?.features?.length) return;

    map.current.addSource('route', { type: 'geojson', data: routeGeo });

    const colorExpr = colorByRisk ? RISK_TIER_EXPR : MODE_COLOR_EXPR;

    // White casing (all modes)
    map.current.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 11, 'line-opacity': 0.3 },
    });

    // Disruption glow: wide low-opacity layer for CRITICAL/HIGH segments
    map.current.addLayer({
      id: 'route-disruption-glow', type: 'line', source: 'route',
      filter: ['in', ['get', 'risk_tier'], ['literal', ['CRITICAL', 'HIGH']]],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['match', ['get', 'risk_tier'], 'CRITICAL', TIER_COLOR.CRITICAL, TIER_COLOR.HIGH],
        'line-width': 18,
        'line-opacity': 0.15,
        'line-blur': 4,
      },
    });

    // Main route — non-intermodal (solid)
    map.current.addLayer({
      id: 'route-main', type: 'line', source: 'route',
      filter: ['!=', ['get', 'mode'], 'intermodal'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': colorExpr, 'line-width': 6, 'line-opacity': 0.95 },
    });

    // CRITICAL segment animated dash overlay
    map.current.addLayer({
      id: 'route-critical-dash', type: 'line', source: 'route',
      filter: ['==', ['get', 'risk_tier'], 'CRITICAL'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#fff',
        'line-width': 3,
        'line-opacity': 0.7,
        'line-dasharray': [2, 4],
      },
    });

    // Intermodal (dashed access links)
    map.current.addLayer({
      id: 'route-intermodal', type: 'line', source: 'route',
      filter: ['==', ['get', 'mode'], 'intermodal'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': colorByRisk ? colorExpr : '#EF9F27', 'line-width': 4, 'line-opacity': 0.85, 'line-dasharray': [4, 3] },
    });

    // Build a lookup from edge_id → journey segment (for richer popup info)
    const edgeToSegment = {};
    (selectedRoute?.journey_segments || []).forEach(seg => {
      (seg.edge_ids || []).forEach(eid => { edgeToSegment[eid] = seg; });
    });

    const modeLabel = { road: '🛣️ Road', rail: '🚂 Railway', intermodal: '🔗 Terminal Access' };
    const tierLabel = { CRITICAL: 'Critical Risk', HIGH: 'High Risk', MEDIUM: 'Moderate Risk', LOW: 'Safe' };

    // Hover / click popup on route segments
    const showRoutePopup = (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p   = f.properties;
      const tid = p.asset_id || '';
      const seg = edgeToSegment[tid];
      const tier    = p.risk_tier || 'LOW';
      const tc      = TIER_COLOR[tier] || '#6B7280';
      const riskPct = Math.round((p.composite_risk || 0) * 100);
      const hazPct  = Math.round((p.composite_hazard || 0) * 100);
      const km      = parseFloat(p.length_km || 0).toFixed(1);
      const min     = Math.round(parseFloat(p.travel_time_hr || 0) * 60);
      const rt      = (p.road_type || '').replace(/_/g, ' ') || 'Road';
      const ml      = modeLabel[p.mode] || p.mode || 'Road';

      // Show journey leg context if available
      const legInfo = seg
        ? `<div style="margin-top:8px;padding:6px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:10px;color:#64748b">
            Leg ${seg.step}: ${seg.length_km} km · ${seg.travel_time_min} min · ${seg.edge_count} segments
           </div>`
        : '';

      if (popup.current) popup.current.remove();
      popup.current = new maplibregl.Popup({ offset: 12, closeButton: false, maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setHTML(`<div style="background:#fff;padding:12px 14px;border-radius:10px;font-family:system-ui">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:12px;font-weight:800;color:#0f172a;text-transform:capitalize">${rt}</span>
            <span style="background:${tc}15;color:${tc};border:1px solid ${tc}35;border-radius:99px;padding:2px 8px;font-size:10px;font-weight:700">${tierLabel[tier] || tier}</span>
          </div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px">${ml}</div>
          <div style="display:grid;grid-template-columns:auto 1fr;column-gap:16px;row-gap:3px;font-size:11px">
            <span style="color:#94a3b8">This segment</span><span style="color:#0f172a;font-weight:700;text-align:right">${km} km · ${min} min</span>
            <span style="color:#94a3b8">Risk score</span><span style="font-weight:700;text-align:right;color:${tc}">${riskPct}%</span>
            <span style="color:#94a3b8">Hazard level</span><span style="color:#0f172a;font-weight:700;text-align:right">${hazPct}%</span>
            <span style="color:#94a3b8">Speed</span><span style="color:#0f172a;font-weight:700;text-align:right">${p.avg_speed_kmh || '—'} km/h</span>
          </div>
          ${legInfo}
          ${riskPct > 50 ? `<div style="margin-top:8px;padding:6px 8px;background:${tc}12;border-radius:6px;border:1px solid ${tc}30;font-size:10px;color:${tc};font-weight:600">⚠ High risk — consider the safer route</div>` : ''}
        </div>`)
        .addTo(map.current);
    };

    ['route-main', 'route-intermodal'].forEach(id => {
      map.current.on('mouseenter', id, e => { map.current.getCanvas().style.cursor = 'pointer'; showRoutePopup(e); });
      map.current.on('mousemove',  id, showRoutePopup);
      map.current.on('mouseleave', id, () => {
        map.current.getCanvas().style.cursor = '';
        if (popup.current) { popup.current.remove(); popup.current = null; }
      });
    });

    // Add origin & destination markers from journey segments
    const segs = selectedRoute?.journey_segments || [];
    if (segs.length > 0) {
      const origin = segs[0];
      const dest   = segs[segs.length - 1];

      const addMarker = (lon, lat, color, label) => {
        if (lon == null || lat == null) return;
        const el = document.createElement('div');
        el.style.cssText = `
          width:28px;height:28px;border-radius:50%;
          background:${color};border:3px solid #fff;
          box-shadow:0 2px 8px rgba(0,0,0,0.4);
          display:flex;align-items:center;justify-content:center;
          font-size:12px;cursor:default;
        `;
        el.title = label;
        const marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map.current);
        routeMarkers.current.push(marker);
      };

      addMarker(origin.from_lon, origin.from_lat, '#22C55E', `START: ${origin.from_name || 'Origin'}`);
      addMarker(dest.to_lon, dest.to_lat, '#E24B4A', `END: ${dest.to_name || 'Destination'}`);
    }

    // Fit bounds to route
    const coords = routeGeo.features.flatMap(f => {
      const g = f.geometry;
      if (!g?.coordinates) return [];
      if (g.type === 'LineString') return g.coordinates;
      if (g.type === 'MultiLineString') return g.coordinates.flat();
      return [];
    });
    if (coords.length) {
      const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
      map.current.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 70, duration: 900, maxZoom: 9 }
      );
    }
  }, [selectedRoute, ready, colorByRisk]);

  // ── Color mode update (no source rebuild needed) ──────────────────────────
  useEffect(() => {
    if (!ready || !map.current.getLayer('route-main')) return;
    const expr = colorByRisk ? RISK_TIER_EXPR : MODE_COLOR_EXPR;
    map.current.setPaintProperty('route-main', 'line-color', expr);
    map.current.setPaintProperty('route-casing', 'line-color', '#fff');
    if (map.current.getLayer('route-intermodal')) {
      map.current.setPaintProperty('route-intermodal', 'line-color', colorByRisk ? expr : '#EF9F27');
    }
  }, [colorByRisk, ready]);

  // ── Layer visibility ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !map.current.getLayer('roads-layer')) return;
    map.current.setLayoutProperty('roads-layer', 'visibility', showRoads ? 'visible' : 'none');
  }, [showRoads, ready]);
  useEffect(() => {
    if (!ready || !map.current.getLayer('rail-layer')) return;
    map.current.setLayoutProperty('rail-layer', 'visibility', showRail ? 'visible' : 'none');
  }, [showRail, ready]);

  // ── Risk summary for selected route ──────────────────────────────────────
  const routeGeo = normalizeGeoJSON(selectedRoute?.geometry);
  const summary  = routeRiskSummary(routeGeo?.features);
  const bd  = selectedRoute?.mode_breakdown;
  const seg = selectedRoute?.segments;
  const hz  = selectedRoute?.hazard_summary;

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="absolute inset-0" />

      {/* ── Disruption alert banner — shows when route has CRITICAL/HIGH segments ── */}
      {summary && (summary.kmByTier.CRITICAL > 0 || summary.kmByTier.HIGH > 0) && (
        <div className="absolute top-16 left-1/2 z-20 pointer-events-none"
             style={{ transform: 'translateX(-50%)' }}>
          <div className="flex items-center gap-2 bg-white/95 border border-red-200 shadow-lg rounded-full px-4 py-2 text-xs font-semibold whitespace-nowrap">
            {summary.kmByTier.CRITICAL > 0 && (
              <span className="flex items-center gap-1.5 text-red-600">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                {summary.kmByTier.CRITICAL.toFixed(0)} km CRITICAL risk
              </span>
            )}
            {summary.kmByTier.CRITICAL > 0 && summary.kmByTier.HIGH > 0 && <span className="text-gray-300">·</span>}
            {summary.kmByTier.HIGH > 0 && (
              <span className="flex items-center gap-1.5 text-amber-600">
                <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                {summary.kmByTier.HIGH.toFixed(0)} km HIGH risk
              </span>
            )}
            <span className="text-gray-400 ml-1">on this route</span>
          </div>
        </div>
      )}

      {/* ── Map legend — bottom-left ── */}
      <div className="absolute bottom-14 left-3 z-10 bg-white/95 rounded-xl border border-gray-200 p-3 shadow-lg" style={{ minWidth: 140 }}>
        <div className="text-gray-400 text-xs font-bold uppercase tracking-wide mb-2">
          {colorByRisk ? 'Route Risk' : 'Transport Mode'}
        </div>
        {colorByRisk ? (
          <>
            {['CRITICAL','HIGH','MEDIUM','LOW'].map(t => (
              <div key={t} className="flex items-center gap-2 text-xs mb-1">
                <div className="w-4 h-1.5 rounded" style={{ backgroundColor: TIER_COLOR[t] }} />
                <span className="text-slate-700">{t}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            {[['#534AB7','🛣️ Road'],['#1D9E75','🚂 Rail'],['#EF9F27','🔗 Access']].map(([c,l]) => (
              <div key={l} className="flex items-center gap-2 text-xs mb-1">
                <div className="w-4 h-1.5 rounded" style={{ backgroundColor: c }} />
                <span className="text-slate-600">{l}</span>
              </div>
            ))}
          </>
        )}
        <div className="border-t border-gray-100 mt-2 pt-2">
          <div className="text-gray-400 text-xs font-bold mb-1">Terminals</div>
          {[['#D85A30','🚢 Sea Port'],['#534AB7','🏭 ICD'],['#1D9E75','🚂 Station']].map(([c,l]) => (
            <div key={l} className="flex items-center gap-1.5 text-xs mb-0.5">
              <div className="w-2.5 h-2.5 rounded-full border-2 border-white" style={{ backgroundColor: c }} />
              <span className="text-slate-500">{l}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Layer controls — bottom-center ── */}
      <div className="absolute bottom-4 z-10 flex items-center gap-2 bg-white/95 rounded-full px-3 py-2 border border-gray-200 shadow-lg"
        style={{ left: '50%', transform: 'translateX(-50%)' }}>
        <button onClick={() => setColorByRisk(v => !v)}
          className={`text-xs font-bold px-2.5 py-1 rounded-full transition border ${colorByRisk ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-200 text-gray-400 hover:text-slate-700 hover:bg-gray-50'}`}>
          {colorByRisk ? '● Risk colors' : '○ Mode colors'}
        </button>
        <div className="w-px h-4 bg-gray-200" />
        <button onClick={() => setShowRoads(v => !v)}
          className={`text-xs font-semibold px-2.5 py-1 rounded-full transition border ${showRoads ? 'bg-slate-700 border-slate-700 text-white' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}>
          Roads {roadLoading ? '…' : `(${roadCount.toLocaleString()})`}
        </button>
        <button onClick={() => setShowRail(v => !v)}
          className={`text-xs font-semibold px-2.5 py-1 rounded-full transition border ${showRail ? 'text-white border-transparent' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}
          style={showRail ? { backgroundColor: '#1D9E75' } : {}}>
          Rail
        </button>
      </div>
    </div>
  );
};

export default RouteVisualizationMap;
