import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { networkApi } from '../api/networkApi';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// ─── Design tokens ───────────────────────────────────────────────────────────
const NODE_COLORS = { port: '#D85A30', dryport: '#534AB7', rail_station: '#1D9E75' };
const NODE_LABELS = { port: 'Sea Port', dryport: 'Dry Port / Inland Terminal', rail_station: 'Railway Station' };

// ─── Shared components ────────────────────────────────────────────────────────
function SectionCard({ title, desc, children }) {
  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      {title && (
        <div className="px-4 py-3 border-b border-white/10">
          <div className="text-white font-semibold text-sm">{title}</div>
          {desc && <div className="text-white/40 text-xs mt-0.5">{desc}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

function StatPill({ label, value, sub }) {
  return (
    <div className="bg-slate-700/60 rounded-xl p-3">
      <div className="text-white font-bold text-lg leading-tight">{value}</div>
      <div className="text-white/70 text-xs font-semibold mt-0.5">{label}</div>
      {sub && <div className="text-white/40 text-xs mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Network Map ──────────────────────────────────────────────────────────────
function NetworkMap({ onNodeClick }) {
  const mapEl  = useRef(null);
  const mapRef = useRef(null);
  const popRef = useRef(null);
  const [ready, setReady]       = useState(false);
  const [layers, setLayers]     = useState({ rail: true, road: true, facilities: true });
  const [roadCount, setRoadCount] = useState(0);

  const { data: nodes }     = useQuery({ queryKey: ['network-nodes'],      queryFn: () => networkApi.getNodes({ type: 'port,dryport,rail_station' }).then(r => r.data) });
  const { data: railEdges } = useQuery({ queryKey: ['network-edges-rail'], queryFn: () => networkApi.getEdges({ mode: 'rail', limit: 5000 }).then(r => r.data), enabled: ready });
  const { data: pkBound }   = useQuery({ queryKey: ['pakistan-boundary'],  queryFn: () => networkApi.getPakistanBoundary().then(r => r.data).catch(() => null), enabled: ready });

  useEffect(() => {
    if (mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: mapEl.current,
      style: `https://api.maptiler.com/maps/topo/style.json?key=${import.meta.env.VITE_MAPTILER_KEY}`,
      center: [68, 30], zoom: 5, antialias: true,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
    mapRef.current.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    mapRef.current.on('load', () => setReady(true));
    return () => { if (popRef.current) popRef.current.remove(); };
  }, []);

  useEffect(() => {
    if (!ready || !pkBound || mapRef.current.getSource('pk')) return;
    mapRef.current.addSource('pk', { type: 'geojson', data: pkBound });
    mapRef.current.addLayer({ id: 'pk-fill', type: 'fill', source: 'pk', paint: { 'fill-color': '#e8f4f8', 'fill-opacity': 0.15 } });
    mapRef.current.addLayer({ id: 'pk-line', type: 'line', source: 'pk', paint: { 'line-color': '#334155', 'line-width': 1.5, 'line-opacity': 0.7 } });
  }, [pkBound, ready]);

  useEffect(() => {
    if (!ready || !railEdges) return;
    if (mapRef.current.getSource('rail')) { mapRef.current.getSource('rail').setData(railEdges); return; }
    mapRef.current.addSource('rail', { type: 'geojson', data: railEdges });
    mapRef.current.addLayer({ id: 'rail-layer', type: 'line', source: 'rail',
      paint: { 'line-color': '#1D9E75', 'line-width': 2.5, 'line-opacity': 0.65, 'line-dasharray': [5, 3] },
      layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'visible' } });
  }, [railEdges, ready]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      let feats = [], offset = 0;
      while (!cancelled) {
        const r = await networkApi.getEdges({ mode: 'road', limit: 2000, offset }).catch(() => null);
        if (!r?.data?.features?.length) break;
        feats = feats.concat(r.data.features);
        offset += 2000;
        if (r.data.pagination?.returned < 2000) break;
      }
      if (cancelled || !mapRef.current) return;
      setRoadCount(feats.length);
      const geo = { type: 'FeatureCollection', features: feats };
      if (mapRef.current.getSource('roads')) { mapRef.current.getSource('roads').setData(geo); return; }
      mapRef.current.addSource('roads', { type: 'geojson', data: geo });
      mapRef.current.addLayer({ id: 'roads-layer', type: 'line', source: 'roads',
        paint: {
          'line-color': ['match', ['get', 'road_type'],
            'motorway', '#D85A30', 'trunk', '#EF9F27',
            'primary', '#378ADD', 'Primary', '#378ADD', '#94A3B8'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 12, 3],
          'line-opacity': 0.55,
        },
        layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'visible' } });
    })();
    return () => { cancelled = true; };
  }, [ready]);

  useEffect(() => {
    if (!ready || !nodes) return;
    if (mapRef.current.getSource('fac')) { mapRef.current.getSource('fac').setData(nodes); return; }
    mapRef.current.addSource('fac', { type: 'geojson', data: nodes });
    mapRef.current.addLayer({ id: 'fac-glow', type: 'circle', source: 'fac',
      paint: { 'circle-radius': ['interpolate',['linear'],['zoom'],4,16,12,32],
        'circle-color': ['match',['get','node_type'],'port','#D85A30','dryport','#534AB7','rail_station','#1D9E75','#64748B'],
        'circle-opacity': 0.12, 'circle-stroke-width': 0 } });
    mapRef.current.addLayer({ id: 'fac-layer', type: 'circle', source: 'fac',
      paint: { 'circle-radius': ['interpolate',['linear'],['zoom'],4,6,12,13],
        'circle-color': ['match',['get','node_type'],'port','#D85A30','dryport','#534AB7','rail_station','#1D9E75','#64748B'],
        'circle-opacity': 0.95, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff' } });
    mapRef.current.addLayer({ id: 'fac-labels', type: 'symbol', source: 'fac',
      layout: { 'text-field': ['get','name'], 'text-size': 11, 'text-offset': [0,1.4], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#fff', 'text-halo-width': 2 },
      minzoom: 6 });

    mapRef.current.on('mouseenter', 'fac-layer', e => {
      mapRef.current.getCanvas().style.cursor = 'pointer';
      const f = e.features[0].properties;
      if (popRef.current) popRef.current.remove();
      const score = ((f.betweenness_centrality||0) / 0.308818 * 100).toFixed(0);
      const stars = '★'.repeat(Math.round((f.importance_index||1)/5*5)) + '☆'.repeat(5 - Math.round((f.importance_index||1)/5*5));
      popRef.current = new maplibregl.Popup({ offset: 12, closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<div style="padding:12px 16px;min-width:200px;font-family:system-ui">
          <div style="font-weight:700;font-size:14px;color:#0f172a">${f.name}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px">${NODE_LABELS[f.node_type] || f.node_type}</div>
          <div style="font-size:12px;color:#334155;margin-bottom:4px">
            <b>Criticality:</b> ${score}% of trade routes pass through here
          </div>
          <div style="font-size:12px;color:#334155">
            <b>Infrastructure rating:</b> ${f.importance_index||1}/5
          </div>
        </div>`)
        .addTo(mapRef.current);
    });
    mapRef.current.on('mouseleave', 'fac-layer', () => {
      mapRef.current.getCanvas().style.cursor = '';
      if (popRef.current) { popRef.current.remove(); popRef.current = null; }
    });
    mapRef.current.on('click', 'fac-layer', e => onNodeClick && onNodeClick(e.features[0].properties));
  }, [nodes, ready]);

  useEffect(() => {
    if (!ready || !mapRef.current.getLayer('roads-layer')) return;
    mapRef.current.setLayoutProperty('roads-layer', 'visibility', layers.road ? 'visible' : 'none');
  }, [layers.road, ready]);
  useEffect(() => {
    if (!ready || !mapRef.current.getLayer('rail-layer')) return;
    mapRef.current.setLayoutProperty('rail-layer', 'visibility', layers.rail ? 'visible' : 'none');
  }, [layers.rail, ready]);
  useEffect(() => {
    if (!ready) return;
    ['fac-layer','fac-labels','fac-glow'].forEach(id => {
      if (mapRef.current.getLayer(id)) mapRef.current.setLayoutProperty(id, 'visibility', layers.facilities ? 'visible' : 'none');
    });
  }, [layers.facilities, ready]);

  const toggle = k => setLayers(p => ({ ...p, [k]: !p[k] }));

  return (
    <div className="relative w-full h-full">
      <div ref={mapEl} className="absolute inset-0" />

      {/* Bottom-center layer toggles */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-slate-900 rounded-full px-4 py-2.5 border border-white/10 shadow-2xl">
        {[
          { key: 'road',       label: `Roads (${roadCount.toLocaleString()})`, color: '#D85A30' },
          { key: 'rail',       label: 'Railway Lines',                        color: '#1D9E75' },
          { key: 'facilities', label: 'Ports & Stations',                     color: '#534AB7' },
        ].map(item => (
          <button key={item.key} onClick={() => toggle(item.key)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full transition ${layers[item.key] ? 'text-white' : 'text-white/30 bg-white/5'}`}
            style={{ backgroundColor: layers[item.key] ? item.color + '33' : undefined, borderColor: layers[item.key] ? item.color + '80' : 'transparent', borderWidth: 1 }}>
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: layers[item.key] ? item.color : 'transparent', border: `1.5px solid ${item.color}` }} />
            {item.label}
          </button>
        ))}
        <div className="w-px h-4 bg-white/20" />
        {[['#D85A30','Motorway'],['#EF9F27','Trunk Rd'],['#378ADD','Primary Rd']].map(([c,l]) => (
          <div key={l} className="flex items-center gap-1 text-xs text-white/50">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: c }} />{l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab() {
  const { data: m } = useQuery({ queryKey: ['network-metrics'], queryFn: () => networkApi.getMetrics().then(r => r.data) });

  return (
    <div className="space-y-4">
      {/* Key numbers */}
      <SectionCard title="Pakistan Trade Network — At a Glance"
        desc="Total size and reach of the mapped road and rail infrastructure">
        <div className="grid grid-cols-2 gap-2">
          <StatPill label="Map Points (junctions + facilities)"    value={(m?.total_nodes||0).toLocaleString()} sub="Road intersections, ports, stations" />
          <StatPill label="Road & Rail Segments"                    value={(m?.total_edges||0).toLocaleString()} sub="Individual road and rail links" />
          <StatPill label="Total Network Coverage"                  value={`${((m?.total_length_km||0)/1000).toFixed(0)}K km`} sub="Combined road + rail distance" />
          <StatPill label="Average Journey Time"                    value={`${(m?.avg_travel_time_hr||0).toFixed(1)} hrs`} sub="Across all route pairs" />
          <StatPill label="Key Trade Facilities"                    value={m?.facility_nodes || 42} sub="Ports, dry ports, rail stations" />
          <StatPill label="Pre-calculated Trade Routes"             value={m?.corridors || 861} sub="Direct facility-to-facility paths" />
        </div>
      </SectionCard>

      {/* Transport mix */}
      <SectionCard title="How Goods Move" desc="Breakdown of transport types in the network">
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={[{name:'Road',count:14021,label:'Road (highways)'},{name:'Rail',count:28,label:'Railway'},{name:'Access',count:60,label:'Access links'}]} barCategoryGap="30%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12, color: '#fff' }} />
            <Bar dataKey="count" fill="#534AB7" radius={[4,4,0,0]} name="Segments" />
          </BarChart>
        </ResponsiveContainer>
        <div className="grid grid-cols-3 gap-2 mt-2 text-center text-xs">
          {[['🛣️','14,021 road segments','Highways & streets'],['🚂','28 rail segments','Railway lines'],['🔗','60 access links','Connect facilities to roads']].map(([i,v,d]) => (
            <div key={v} className="bg-slate-700/50 rounded-lg py-2">
              <div className="text-base">{i}</div>
              <div className="text-white font-semibold text-xs mt-0.5">{v}</div>
              <div className="text-white/40 text-xs">{d}</div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Plain-language network health */}
      <SectionCard title="Network Health" desc="How well the transport network performs overall">
        <div className="space-y-2.5 text-xs">
          {[
            { label: 'Overall Connectivity', val: '0.00822', bar: 8, note: 'How easily goods can move across the whole network (higher = better)' },
            { label: 'Local Clustering',      val: '0.058',  bar: 6, note: 'How well-connected local junctions are to each other' },
            { label: 'Most Critical Location',val: '0.31',   bar: 31, note: 'The highest share of routes passing through a single point (Lahore area)' },
            { label: 'Average Connections',   val: '2.2',    bar: 22, note: 'Average number of roads per junction — sparse but typical for Pakistan' },
          ].map(s => (
            <div key={s.label} className="bg-slate-700/40 rounded-lg px-3 py-2.5">
              <div className="flex justify-between items-center mb-1">
                <div className="text-white/70 font-semibold">{s.label}</div>
                <div className="text-white font-bold font-mono">{s.val}</div>
              </div>
              <div className="h-1 bg-white/10 rounded-full mb-1.5">
                <div className="h-1 bg-purple-500 rounded-full" style={{ width: `${s.bar}%` }} />
              </div>
              <div className="text-white/40">{s.note}</div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Criticality Tab ──────────────────────────────────────────────────────────
function CriticalityTab() {
  const { data, isLoading } = useQuery({ queryKey: ['network-criticality'], queryFn: () => networkApi.getCriticality().then(r => r.data) });
  const [search, setSearch]   = useState('');
  const [filter, setFilter]   = useState('all');
  if (isLoading) return <div className="text-center py-8 text-white/40 text-sm">Loading…</div>;

  const filtered = (data || []).filter(n =>
    (!search || n.name?.toLowerCase().includes(search.toLowerCase())) &&
    (filter === 'all' || n.node_type === filter)
  );

  const critLabel = pct => pct >= 25 ? { text: 'Critical', color: '#E24B4A' }
    : pct >= 12 ? { text: 'High',     color: '#EF9F27' }
    : pct >= 5  ? { text: 'Medium',   color: '#BA7517' }
    :             { text: 'Low',      color: '#3B6D11' };

  return (
    <div className="space-y-3">
      {/* Explanation */}
      <div className="bg-blue-900/30 border border-blue-500/30 rounded-xl px-4 py-3 text-xs text-blue-200">
        <b>What does this show?</b> Each facility is ranked by how many trade routes pass through it. A highly-ranked location is critical — if it closes, more shipments are disrupted.
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name…"
          className="flex-1 bg-slate-700 border border-white/10 text-white placeholder-white/30 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-white/30" />
        <select value={filter} onChange={e => setFilter(e.target.value)}
          className="bg-slate-700 border border-white/10 text-white rounded-lg px-2 py-2 text-xs focus:outline-none">
          <option value="all">All types</option>
          <option value="port">Sea Ports</option>
          <option value="dryport">Dry Ports</option>
          <option value="rail_station">Rail Stations</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-y-auto max-h-[calc(100vh-380px)] rounded-xl border border-white/10 bg-slate-800">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 sticky top-0">
            <tr>
              <th className="text-left px-3 py-3 text-white/40 font-semibold w-8">#</th>
              <th className="text-left px-3 py-3 text-white/40 font-semibold">Facility</th>
              <th className="text-left px-3 py-3 text-white/40 font-semibold">Route Share</th>
              <th className="text-left px-3 py-3 text-white/40 font-semibold w-16">Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.map(n => {
              const pct = ((n.betweenness_centrality||0) / 0.308818 * 100);
              const lbl = critLabel(pct);
              return (
                <tr key={n.asset_id} className="hover:bg-white/5 transition">
                  <td className="px-3 py-3 font-bold text-white/30">{n.rank}</td>
                  <td className="px-3 py-3">
                    <div className="font-semibold text-white">{n.name || n.asset_id}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: NODE_COLORS[n.node_type] || '#64748B' }} />
                      <span className="text-white/40">{NODE_LABELS[n.node_type] || n.node_type}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-white/10 rounded-full h-1.5">
                        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: lbl.color }} />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: lbl.color + '30', color: lbl.color }}>{lbl.text}</span>
                      <span className="text-white/40">{pct.toFixed(1)}% of routes</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-white font-bold text-sm">{n.importance_index || 1}<span className="text-white/30 text-xs">/5</span></div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Corridors Tab ────────────────────────────────────────────────────────────
function CorridorsTab() {
  const { data, isLoading } = useQuery({ queryKey: ['corridor-times'], queryFn: () => networkApi.getCorridorTimes().then(r => r.data) });
  if (isLoading) return <div className="text-center py-8 text-white/40 text-sm">Loading journey times…</div>;
  const corridors = (Array.isArray(data) ? data : (data?.results || [])).slice(0, 80);

  const timeInfo = t => !t
    ? { label: 'Unknown', color: '#475569', bg: '#47556920' }
    : t < 5
    ? { label: 'Fast',     color: '#22c55e', bg: '#22c55e20', detail: 'Under 5 hours' }
    : t < 12
    ? { label: 'Normal',   color: '#eab308', bg: '#eab30820', detail: '5 to 12 hours' }
    : t < 20
    ? { label: 'Long',     color: '#f97316', bg: '#f9731620', detail: '12 to 20 hours' }
    : { label: 'Very Long',color: '#ef4444', bg: '#ef444420', detail: 'Over 20 hours' };

  return (
    <div className="space-y-3">
      <div className="bg-blue-900/30 border border-blue-500/30 rounded-xl px-4 py-3 text-xs text-blue-200">
        <b>What does this show?</b> The estimated travel time between each pair of major facilities — useful for planning shipment schedules and comparing route options.
      </div>

      {/* Legend */}
      <div className="flex gap-2 flex-wrap">
        {[['Fast','#22c55e','< 5 hrs'],['Normal','#eab308','5–12 hrs'],['Long','#f97316','12–20 hrs'],['Very Long','#ef4444','20+ hrs']].map(([l,c,d]) => (
          <div key={l} className="flex items-center gap-1.5 text-xs">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: c }} />
            <span className="text-white/60">{l}</span>
            <span className="text-white/30">({d})</span>
          </div>
        ))}
      </div>

      <div className="overflow-y-auto max-h-[calc(100vh-390px)] rounded-xl border border-white/10 bg-slate-800">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 sticky top-0">
            <tr>
              <th className="text-left px-3 py-3 text-white/40 font-semibold">From</th>
              <th className="text-left px-3 py-3 text-white/40 font-semibold">To</th>
              <th className="text-left px-3 py-3 text-white/40 font-semibold">Journey Time</th>
              <th className="text-left px-3 py-3 text-white/40 font-semibold">Distance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {corridors.map((c, i) => {
              const ti = timeInfo(c.travel_time_hr);
              return (
                <tr key={i} className="hover:bg-white/5 transition">
                  <td className="px-3 py-2.5 font-medium text-white">{c.source_name || c.source}</td>
                  <td className="px-3 py-2.5 text-white/60">{c.target_name || c.target}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">{c.travel_time_hr ? `${c.travel_time_hr.toFixed(1)}h` : '—'}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: ti.bg, color: ti.color }}>{ti.label}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-white/50">{c.distance_km ? `${c.distance_km.toFixed(0)} km` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Disruption Tab ───────────────────────────────────────────────────────────
function DisruptionTab() {
  const [asset, setAsset]   = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const { data: assets } = useQuery({ queryKey: ['asset-list'], queryFn: () => networkApi.getNodes({ type: 'port,dryport,rail_station' }).then(r => r.data) });
  const facilities = (assets?.features || []).map(f => f.properties).filter(p => p.name);

  const simulate = async () => {
    if (!asset) return;
    setLoading(true);
    try {
      const res = await networkApi.getDisruptionImpact(asset, 'node');
      setResult(res.data);
    } catch { setResult({ error: true }); }
    setLoading(false);
  };

  const selectedFacility = facilities.find(f => f.asset_id === asset);

  return (
    <div className="space-y-4">
      <div className="bg-amber-900/30 border border-amber-500/30 rounded-xl px-4 py-3 text-xs text-amber-200">
        <b>What does this do?</b> Simulates closing one facility and calculates how many trade routes would be delayed or cut off entirely. Useful for understanding risk and planning alternatives.
      </div>

      <div>
        <div className="text-xs font-bold text-white/50 uppercase tracking-wide mb-1.5">Choose a Facility to Close</div>
        <select value={asset} onChange={e => { setAsset(e.target.value); setResult(null); }}
          className="w-full bg-slate-700 border border-white/10 text-white rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-white/30">
          <option value="" className="bg-slate-900">Select a facility…</option>
          {facilities.map(f => <option key={f.asset_id} value={f.asset_id} className="bg-slate-900">{f.name}</option>)}
        </select>
      </div>

      <button onClick={simulate} disabled={!asset || loading}
        className="w-full bg-red-600 hover:bg-red-500 disabled:bg-white/10 disabled:text-white/30 text-white font-bold py-3 rounded-xl text-sm transition">
        {loading ? 'Simulating closure…' : `Test: What if ${selectedFacility?.name || 'this facility'} closes?`}
      </button>

      {result && !result.error && (
        <div className="space-y-3">
          {/* Summary */}
          <div className="bg-red-900/30 border border-red-500/30 rounded-xl p-4">
            <div className="text-white/60 text-xs mb-1">
              Impact of closing {result.asset_name || selectedFacility?.name}
            </div>
            <div className="text-4xl font-bold text-red-400">{result.total_affected}</div>
            <div className="text-white/70 text-sm mt-1">trade routes would be affected</div>
            <div className="text-white/40 text-xs mt-0.5">out of 861 total pre-calculated routes</div>
          </div>

          {/* Individual impacts */}
          {result.top_impacts?.length > 0 && (
            <div>
              <div className="text-xs font-bold text-white/40 uppercase tracking-wide mb-2">Most Affected Routes</div>
              <div className="space-y-2">
                {result.top_impacts.map((imp, i) => (
                  <div key={i} className="bg-slate-800 border border-white/10 rounded-xl px-4 py-3">
                    <div className="text-white text-xs font-semibold mb-1.5">
                      {imp.source_name || imp.source}
                      <span className="text-white/30 mx-1.5">→</span>
                      {imp.target_name || imp.target}
                    </div>
                    {imp.status === 'UNREACHABLE'
                      ? <div className="flex items-center gap-2 text-xs flex-wrap">
                          <span className="bg-red-900/50 border border-red-500/40 text-red-300 px-2 py-0.5 rounded-full font-bold">No alternative route</span>
                          <span className="text-white/40">These two locations are completely cut off from each other</span>
                        </div>
                      : <div className="flex items-center gap-2 text-xs flex-wrap">
                          <span className="text-white/50">Was {imp.baseline?.toFixed(1)}h</span>
                          <span className="text-white/30">→</span>
                          <span className="text-orange-300 font-bold">Now {imp.disrupted?.toFixed(1)}h</span>
                          <span className={`px-2 py-0.5 rounded-full font-bold ${imp.delay_pct > 30 ? 'bg-red-900/40 text-red-300' : 'bg-amber-900/40 text-amber-300'}`}>
                            {imp.delay_pct?.toFixed(0)}% slower
                          </span>
                        </div>
                    }
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {result?.error && (
        <div className="bg-red-900/30 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-300">
          Simulation failed. Please try a different facility.
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'overview',    label: 'Overview',        icon: '📊', desc: 'Network size & health' },
  { id: 'criticality', label: 'Key Locations',   icon: '⭐', desc: 'Most important facilities' },
  { id: 'corridors',   label: 'Journey Times',   icon: '⏱️', desc: 'Travel time between facilities' },
  { id: 'disruption',  label: 'Risk Testing',    icon: '⚠️', desc: 'What if a facility closes?' },
];

export default function NetworkAnalysis() {
  const [tab, setTab]           = useState('overview');
  const [clickedNode, setClickedNode] = useState(null);

  return (
    <div className="h-screen flex flex-col bg-slate-950 overflow-hidden">
      {/* Header */}
      <div className="bg-slate-900 border-b border-white/10 px-6 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white font-bold text-lg tracking-tight">Pakistan Trade Network</h1>
            <p className="text-white/40 text-xs mt-0.5">Interactive map of roads, railways and trade facilities across Pakistan</p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            {[['#D85A30','Sea Ports (3)'],['#534AB7','Dry Ports (9)'],['#1D9E75','Rail Stations (30)']].map(([c,l]) => (
              <div key={l} className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c }} />
                <span className="text-white/50">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Map — 65% */}
        <div className="flex-1 min-w-0">
          <NetworkMap onNodeClick={setClickedNode} />
        </div>

        {/* Right panel — 35% */}
        <div className="w-[400px] flex-shrink-0 flex flex-col min-h-0 bg-slate-900 border-l border-white/10">
          {/* Tab bar */}
          <div className="flex border-b border-white/10 flex-shrink-0">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex-1 py-3 px-1 text-center transition border-b-2 ${
                  tab === t.id
                    ? 'border-purple-500 text-white'
                    : 'border-transparent text-white/30 hover:text-white/60'
                }`}>
                <div className="text-base leading-none">{t.icon}</div>
                <div className="text-xs font-semibold mt-1 leading-tight">{t.label}</div>
              </button>
            ))}
          </div>

          {/* Clicked node card */}
          {clickedNode && (
            <div className="bg-purple-900/40 border-b border-purple-500/30 px-4 py-3 flex items-start justify-between flex-shrink-0">
              <div>
                <div className="text-white font-bold text-sm">{clickedNode.name || clickedNode.asset_id}</div>
                <div className="text-purple-300 text-xs mt-0.5">{NODE_LABELS[clickedNode.node_type] || clickedNode.node_type}</div>
                <div className="text-white/50 text-xs mt-1">
                  {((clickedNode.betweenness_centrality||0)/0.308818*100).toFixed(1)}% of trade routes pass here
                </div>
              </div>
              <button onClick={() => setClickedNode(null)} className="text-white/30 hover:text-white text-xl leading-none ml-2">×</button>
            </div>
          )}

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {tab === 'overview'    && <OverviewTab />}
            {tab === 'criticality' && <CriticalityTab />}
            {tab === 'corridors'   && <CorridorsTab />}
            {tab === 'disruption'  && <DisruptionTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
