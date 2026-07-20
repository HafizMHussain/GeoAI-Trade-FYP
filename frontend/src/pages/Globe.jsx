import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  Viewer, Entity,
  EllipseGraphics, PointGraphics, LabelGraphics, PolylineGraphics,
} from 'resium';
import { Link, NavLink } from 'react-router-dom';
import { combinedApi, networkApi } from '../api/networkApi';
import { TIER_COLOR } from '../styles/tokens';
import { resolveNodeName } from '../utils/nearestCity';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN;

// ── Pakistan map bounds (lon 60-78, lat 23-38 + margin) ──────────────────────
const PK_BOUNDS = { minLon: 55, maxLon: 83, minLat: 20, maxLat: 42 };
const PK_CENTER = { lon: 68.0, lat: 30.5, height: 2900000 };

// ── Visual config ─────────────────────────────────────────────────────────────
const TYPE_COLOR = { port:'#D85A30', dryport:'#534AB7', station:'#1D9E75', rail_station:'#1D9E75' };
const TYPE_LABEL = {
  port:'Sea Port', dryport:'Inland Container Terminal',
  station:'Railway Station', rail_station:'Railway Station',
};
// Larger dots for more important nodes, visible at Pakistan scale
const DOT_SIZE = { port: 20, dryport: 15, station: 13, rail_station: 13 };

const ROUTE_COLOR  = { SAFEST:'#22C55E', FASTEST:'#3B82F6', BALANCED:'#F59E0B', SHORTEST:'#8B5CF6' };
const ROUTE_LABELS = { SAFEST:'🛡 Safest', FASTEST:'⚡ Fastest', BALANCED:'⚖️ Balanced', SHORTEST:'📏 Shortest' };
const MODE_LABEL   = { road:'Road', rail:'Railway', intermodal:'Terminal Connector' };

const NAV_LINKS = [
  { to:'/map',      label:'Risk Map' },
  { to:'/routes',   label:'Routes' },
  { to:'/scenario', label:'Scenarios' },
  { to:'/globe',    label:'3D Globe' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function hex(color, a = 1.0) {
  const c = Cesium.Color.fromCssColorString(color || '#6B7280');
  return new Cesium.Color(c.red, c.green, c.blue, a);
}

// Convert internal IDs like "Junction_1534", "Rail_Junction_13" to human names
function laymanName(name, lat, lon) {
  if (!name) return lat != null ? resolveNodeName({ lat, lon }) : 'Network Point';
  if (/^(Rail_?|Road_?)?Junction_?\d+$/i.test(name.trim())) {
    return lat != null ? resolveNodeName({ lat, lon }) : 'Network Junction';
  }
  return name;
}

function friendlyTime(min) {
  if (!min || min < 1) return '< 1 min';
  if (min >= 60) return `${Math.floor(min/60)}h ${min%60 > 0 ? `${min%60}m` : ''}`.trim();
  return `${min} min`;
}

// Build Cesium positions from route geometry (actual road/rail shapes) or journey segments
function routePositions(route) {
  // Try geometry first (actual road/rail shapes)
  if (route?.geometry?.features?.length) {
    const pts = [];
    route.geometry.features.forEach(f => {
      const coords =
        f.geometry?.type === 'LineString'      ? f.geometry.coordinates :
        f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates.flat() : [];
      coords.forEach(([lon, lat]) => {
        if (Number.isFinite(lon) && Number.isFinite(lat))
          pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, 6000));
      });
    });
    if (pts.length >= 2) return pts;
  }
  // Fallback: node-to-node straight lines from journey_segments
  const segs = route?.journey_segments;
  if (!Array.isArray(segs) || !segs.length) return [];
  const pts = [];
  segs.forEach((s, i) => {
    if (i === 0 && s.from_lon != null) pts.push(Cesium.Cartesian3.fromDegrees(s.from_lon, s.from_lat, 8000));
    if (s.to_lon != null)              pts.push(Cesium.Cartesian3.fromDegrees(s.to_lon,   s.to_lat,   8000));
  });
  return pts;
}

// ── Facility marker (dot + ring + label — no 3D model, fast) ─────────────────
function FacilityMarker({ feature, isSelected, isFrom, isTo, onSelect }) {
  const p      = feature.properties;
  const coords = feature.geometry?.coordinates;
  if (!coords) return null;
  const [lon, lat] = coords;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const pos       = Cesium.Cartesian3.fromDegrees(lon, lat, 50);
  const typeColor = TYPE_COLOR[p.node_type] || '#6B7280';
  const riskColor = TIER_COLOR[p.risk_tier] || '#94a3b8';
  const name      = resolveNodeName(p);
  const dotSize   = DOT_SIZE[p.node_type] || 12;

  const markerColor = isFrom ? '#22C55E' : isTo ? '#EF4444' : typeColor;
  const ringColor   = isFrom ? '#22C55E' : isTo ? '#EF4444' : isSelected ? '#F59E0B' : riskColor;
  const dotPx       = isSelected || isFrom || isTo ? dotSize + 7 : dotSize;

  return (
    <Entity position={pos} name={name} onClick={() => onSelect(p)}>
      {/* Filled dot: facility type colour, outline = risk tier colour */}
      <PointGraphics
        pixelSize={dotPx}
        color={hex(markerColor)}
        outlineColor={hex(ringColor)}
        outlineWidth={isSelected || isFrom || isTo ? 4 : 2.5}
        disableDepthTestDistance={Number.POSITIVE_INFINITY}
      />

      {/* Glow halo — visible within 700 km altitude */}
      <EllipseGraphics
        semiMinorAxis={isSelected || isFrom || isTo ? 18000 : 12000}
        semiMajorAxis={isSelected || isFrom || isTo ? 18000 : 12000}
        height={100}
        material={hex(ringColor, 0.14)}
        outline
        outlineColor={hex(ringColor, 0.5)}
        outlineWidth={1.5}
        distanceDisplayCondition={new Cesium.DistanceDisplayCondition(0, 700000)}
      />

      {/* Name label — visible within 400 km (or 1.2M if selected/from/to) */}
      <LabelGraphics
        text={isFrom ? `🟢 FROM: ${name}` : isTo ? `🔴 TO: ${name}` : name}
        font={`${isSelected || isFrom || isTo ? 'bold ' : ''}13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`}
        fillColor={isFrom ? hex('#22C55E') : isTo ? hex('#EF4444') : Cesium.Color.WHITE}
        outlineColor={Cesium.Color.BLACK}
        outlineWidth={2}
        style={Cesium.LabelStyle.FILL_AND_OUTLINE}
        verticalOrigin={Cesium.VerticalOrigin.BOTTOM}
        pixelOffset={new Cesium.Cartesian2(0, -dotPx / 2 - 6)}
        distanceDisplayCondition={new Cesium.DistanceDisplayCondition(
          0,
          isSelected || isFrom || isTo ? 1200000 : 400000
        )}
        disableDepthTestDistance={Number.POSITIVE_INFINITY}
        showBackground
        backgroundColor={hex('#0f172a', 0.75)}
        backgroundPadding={new Cesium.Cartesian2(6, 4)}
      />
    </Entity>
  );
}

// ── Route polyline ────────────────────────────────────────────────────────────
function RoutePolyline({ route }) {
  const pts = useMemo(() => routePositions(route), [route]);
  if (!route || pts.length < 2) return null;
  const color = hex(ROUTE_COLOR[route.type] || '#F59E0B', 0.95);
  return (
    <>
      <Entity>
        <PolylineGraphics positions={pts} width={9}
          material={new Cesium.ColorMaterialProperty(hex('#000', 0.2))}
          followSurface={false} arcType={Cesium.ArcType.NONE} />
      </Entity>
      <Entity>
        <PolylineGraphics positions={pts} width={4.5}
          material={new Cesium.PolylineGlowMaterialProperty({ glowPower:0.35, color })}
          followSurface={false} arcType={Cesium.ArcType.NONE} />
      </Entity>
    </>
  );
}

// ── Location detail panel ─────────────────────────────────────────────────────
function LocationPanel({ node, onClose, onSetFrom, onFlyTo, routeFromId }) {
  if (!node) return null;
  const tc       = TIER_COLOR[node.risk_tier] || '#6B7280';
  const name     = resolveNodeName(node);
  const riskPct  = Math.round((node.composite_risk   || 0) * 100);
  const hazPct   = Math.round((node.composite_hazard || 0) * 100);
  const isFrom   = routeFromId === node.asset_id;

  return (
    <div style={{
      position:'absolute', right:16, top:68, width:316,
      background:'#fff', borderRadius:16,
      boxShadow:'0 20px 60px rgba(0,0,0,0.18)',
      overflow:'hidden', zIndex:40, maxHeight:'calc(100vh - 88px)',
      display:'flex', flexDirection:'column', border:'1px solid #e5e7eb',
    }}>
      {/* Header */}
      <div style={{ padding:'14px 16px 12px', background:'linear-gradient(to bottom,#f8fafc,#fff)', borderBottom:'1px solid #f1f5f9' }}>
        <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:800, fontSize:16, color:'#0f172a', lineHeight:1.25 }}>{name}</div>
            <div style={{ fontSize:12, color:'#94a3b8', marginTop:3 }}>{TYPE_LABEL[node.node_type] || node.node_type}</div>
          </div>
          <button onClick={onClose} style={{ color:'#cbd5e1', fontSize:22, cursor:'pointer', background:'none', border:'none', flexShrink:0 }}>×</button>
        </div>
        <div style={{ marginTop:10, display:'flex', gap:6, flexWrap:'wrap' }}>
          {node.risk_tier && (
            <span style={{ padding:'4px 12px', borderRadius:20, fontSize:12, fontWeight:700, color:tc, background:tc+'18', border:`1px solid ${tc}50` }}>
              {node.risk_tier}
            </span>
          )}
          {node.is_chokepoint && (
            <span style={{ padding:'4px 10px', borderRadius:20, fontSize:12, fontWeight:700, color:'#c2410c', background:'#fff7ed', border:'1px solid #fed7aa' }}>
              ⚠ Strategic Chokepoint
            </span>
          )}
        </div>
      </div>

      {/* Stats */}
      <div style={{ padding:'12px 16px', borderBottom:'1px solid #f1f5f9', overflowY:'auto', flex:1 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
          {[
            { label:'Overall Risk',     value:riskPct+'%',  color:tc },
            { label:'Hazard Level',     value:hazPct+'%',   color:'#f59e0b' },
            { label:'Importance',       value:`${node.importance_index||1}/5` },
            { label:'Capacity',         value:`${node.handling_capacity_index||1}/5` },
            { label:'Backup Routes',    value:`${node.redundancy_index||0}` },
            { label:'Trade Route Share',value:`${Math.min(Math.round((node.betweenness_centrality||0)*100*3.24),100)}%`, color:'#3b82f6' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background:'#f8fafc', borderRadius:10, padding:'8px 10px', textAlign:'center' }}>
              <div style={{ fontWeight:800, fontSize:14, color:color||'#0f172a' }}>{value}</div>
              <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>{label}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize:11, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:8 }}>
          Live Threat Levels
        </div>
        {[
          { key:'hazard_flood',    label:'🌊 Flooding',          color:'#378ADD' },
          { key:'hazard_cyclone',  label:'🌀 Cyclone / Storm',   color:'#534AB7' },
          { key:'hazard_strike',   label:'🚫 Labor Strike',      color:'#EF9F27' },
          { key:'hazard_accident', label:'⚠️ Road Accidents',    color:'#E24B4A' },
        ].map(({ key, label, color }) => {
          const pct = Math.round((node[key]||0)*100);
          return (
            <div key={key} style={{ marginBottom:7 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3, color:'#475569' }}>
                <span>{label}</span>
                <span style={{ fontWeight:700, color:'#0f172a' }}>{pct}%</span>
              </div>
              <div style={{ height:5, background:'#f1f5f9', borderRadius:99, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${pct}%`, background:color, borderRadius:99, transition:'width 0.3s' }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div style={{ padding:14, display:'flex', flexDirection:'column', gap:8 }}>
        <button onClick={() => onFlyTo(node)}
          style={{ padding:'9px 0', background:'#0f172a', color:'#fff', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer', border:'none' }}>
          🎯 Fly Camera to This Location
        </button>
        <button onClick={() => { onSetFrom(node); onClose(); }}
          style={{ padding:'9px 0', background:isFrom?'#22C55E':'#eff6ff', color:isFrom?'#fff':'#1d4ed8', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer', border:'none' }}>
          {isFrom ? '✓ Selected as Starting Point' : '🟢 Set as Route Starting Point'}
        </button>
        <Link to={`/routes?from=${node.asset_id}`}
          style={{ display:'block', textAlign:'center', padding:'9px 0', border:'1px solid #e2e8f0', color:'#334155', borderRadius:10, fontSize:13, fontWeight:700, textDecoration:'none' }}>
          🛣️ Open Route Planner
        </Link>
        <Link to={`/scenario?target=${node.asset_id}`}
          style={{ display:'block', textAlign:'center', padding:'9px 0', border:'1px solid #fed7aa', color:'#c2410c', borderRadius:10, fontSize:13, fontWeight:700, textDecoration:'none' }}>
          ⚡ Simulate This Location Closing
        </Link>
        <Link to={`/asset/${node.asset_id}`}
          style={{ display:'block', textAlign:'center', padding:'9px 0', border:'1px solid #e5e7eb', color:'#64748b', borderRadius:10, fontSize:13, fontWeight:700, textDecoration:'none' }}>
          📊 Full Profile &amp; Stats
        </Link>
      </div>
    </div>
  );
}

// ── Route result panel ────────────────────────────────────────────────────────
function RoutePanel({ routes, selectedRouteType, onSelectType, fromNode, toNode, onClear }) {
  if (!routes?.length) return null;
  const active = routes.find(r => r.type === selectedRouteType) || routes[0];
  const segs   = Array.isArray(active?.journey_segments) ? active.journey_segments : [];

  return (
    <div style={{
      position:'absolute', left:16, top:68, width:300,
      background:'#fff', borderRadius:16,
      boxShadow:'0 20px 60px rgba(0,0,0,0.18)',
      overflow:'hidden', zIndex:40, maxHeight:'calc(100vh - 88px)',
      display:'flex', flexDirection:'column', border:'1px solid #e5e7eb',
    }}>
      {/* Header */}
      <div style={{ padding:'14px 16px', borderBottom:'1px solid #f1f5f9' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
          <div style={{ fontWeight:800, fontSize:14, color:'#0f172a' }}>🗺️ Route Found</div>
          <button onClick={onClear} style={{ fontSize:12, color:'#9ca3af', cursor:'pointer', background:'none', border:'none', fontWeight:600, padding:'2px 6px' }}>✕ Clear</button>
        </div>
        <div style={{ fontSize:12, color:'#64748b', lineHeight:1.6 }}>
          <span style={{ fontWeight:700, color:'#0f172a' }}>{resolveNodeName(fromNode||{})}</span>
          <span style={{ margin:'0 6px', color:'#94a3b8' }}>→</span>
          <span style={{ fontWeight:700, color:'#0f172a' }}>{resolveNodeName(toNode||{})}</span>
        </div>
      </div>

      {/* Route type tabs */}
      <div style={{ display:'flex', padding:'8px 12px', gap:6, flexWrap:'wrap', borderBottom:'1px solid #f1f5f9' }}>
        {routes.map(r => {
          const isActive = (selectedRouteType || routes[0].type) === r.type;
          return (
            <button key={r.type} onClick={() => onSelectType(r.type)}
              style={{
                padding:'4px 10px', borderRadius:20, fontSize:11, fontWeight:700, cursor:'pointer', border:'none',
                background:isActive?(ROUTE_COLOR[r.type]||'#6B7280'):'#f1f5f9',
                color:isActive?'#fff':'#64748b',
              }}>
              {ROUTE_LABELS[r.type]||r.type}
            </button>
          );
        })}
      </div>

      {active && (
        <>
          {/* Stats row */}
          <div style={{ padding:'12px 16px', borderBottom:'1px solid #f1f5f9' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
              {[
                { label:'Distance', value:`${(active.distance_km||0).toFixed(0)} km` },
                { label:'Travel Time', value:friendlyTime(Math.round((active.travel_time_hr||0)*60)) },
                { label:'Stops',    value:segs.length },
              ].map(({ label, value }) => (
                <div key={label} style={{ background:'#f8fafc', borderRadius:8, padding:'7px 8px', textAlign:'center' }}>
                  <div style={{ fontWeight:800, fontSize:13, color:'#0f172a' }}>{value}</div>
                  <div style={{ fontSize:10, color:'#94a3b8', marginTop:2 }}>{label}</div>
                </div>
              ))}
            </div>
            {/* Mode breakdown */}
            {active.segments && typeof active.segments === 'object' && (
              <div style={{ display:'flex', gap:6, marginTop:8, flexWrap:'wrap' }}>
                {Object.entries(active.segments).filter(([,d]) => d?.km > 0).map(([mode, data]) => (
                  <span key={mode} style={{ fontSize:11, color:'#64748b', background:'#f1f5f9', padding:'3px 8px', borderRadius:10 }}>
                    {mode==='road'?'🛣️':mode==='rail'?'🚂':'🔗'} {(data.km).toFixed(0)} km {MODE_LABEL[mode]||mode}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Journey steps — with layman names */}
          <div style={{ overflowY:'auto', maxHeight:240, padding:'8px 0' }}>
            {segs.map((seg, i) => {
              const tc        = TIER_COLOR[seg.max_risk_tier] || '#22C55E';
              const modeColor = { road:'#534AB7', rail:'#1D9E75', intermodal:'#EF9F27' }[seg.mode] || '#94a3b8';
              const fromLabel = laymanName(seg.from_name, seg.from_lat, seg.from_lon);
              const toLabel   = laymanName(seg.to_name,   seg.to_lat,   seg.to_lon);
              const isFirst   = i === 0;
              const isLast    = i === segs.length - 1;
              return (
                <div key={i} style={{ display:'flex', gap:10, padding:'6px 16px', alignItems:'flex-start', background:isFirst||isLast?'#f8fafc':'transparent' }}>
                  {/* Mode colour bar */}
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingTop:4, flexShrink:0 }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', background:isFirst?'#22C55E':isLast?'#EF4444':modeColor, border:'2px solid white', boxShadow:'0 0 0 1px '+modeColor }} />
                    {!isLast && <div style={{ width:2, height:24, background:modeColor, margin:'2px 0', borderRadius:1, opacity:0.5 }} />}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'#0f172a' }}>
                      {isFirst ? fromLabel : isLast ? toLabel : fromLabel}
                    </div>
                    {!isLast && (
                      <div style={{ display:'flex', gap:8, marginTop:3, fontSize:11, color:'#94a3b8', flexWrap:'wrap' }}>
                        <span style={{ color:modeColor, fontWeight:600 }}>{MODE_LABEL[seg.mode]||seg.mode}</span>
                        <span>{(seg.length_km||0).toFixed(1)} km</span>
                        <span>{friendlyTime(seg.travel_time_min)}</span>
                        {seg.max_risk_tier && seg.max_risk_tier !== 'LOW' && (
                          <span style={{ color:tc, fontWeight:700 }}>⚠ {seg.max_risk_tier}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ padding:14 }}>
        <Link to={`/routes?from=${fromNode?.asset_id}&to=${toNode?.asset_id}`}
          style={{ display:'block', textAlign:'center', padding:'9px 0', background:'#0f172a', color:'#fff', borderRadius:10, fontSize:13, fontWeight:700, textDecoration:'none' }}>
          Open Full Route Planner →
        </Link>
      </div>
    </div>
  );
}

// ── Main Globe page ───────────────────────────────────────────────────────────
export default function Globe() {
  const viewerRef   = useRef(null);
  const handlerRef  = useRef(null);
  const pkDSRef     = useRef(null);
  const [searchParams] = useSearchParams();

  const handleNodeSelectRef = useRef(null);
  const featuresRef         = useRef([]);

  const [selected,          setSelected]          = useState(null);
  const [filterType,        setFilterType]        = useState('all');
  const [routeFrom,         setRouteFrom]         = useState(null);
  const [routes,            setRoutes]            = useState(null);
  const [routeLoading,      setRouteLoading]      = useState(false);
  const [routeError,        setRouteError]        = useState(null);
  const [selectedRouteType, setSelectedRouteType] = useState(null);

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: facilityNodes, isLoading } = useQuery({
    queryKey: ['combined-facilities'],
    queryFn: () => combinedApi.getNodes({ type:'port,dryport,station,rail_station' }).then(r => r.data),
    staleTime: 300000,
  });
  const { data: pkBound } = useQuery({
    queryKey: ['pakistan-boundary'],
    queryFn: () => networkApi.getPakistanBoundary().then(r => r.data).catch(() => null),
    staleTime: Infinity,
  });

  const features = useMemo(() => facilityNodes?.features || [], [facilityNodes]);
  const filtered = useMemo(() => {
    if (filterType === 'all') return features;
    if (filterType === 'station') return features.filter(f => ['station','rail_station'].includes(f.properties.node_type));
    return features.filter(f => f.properties.node_type === filterType);
  }, [features, filterType]);

  const counts = useMemo(() => ({
    port:    features.filter(f => f.properties.node_type === 'port').length,
    dryport: features.filter(f => f.properties.node_type === 'dryport').length,
    station: features.filter(f => ['station','rail_station'].includes(f.properties.node_type)).length,
  }), [features]);

  useEffect(() => { featuresRef.current = features; }, [features]);

  // ── Pakistan boundary ─────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement;
    if (!viewer || !pkBound) return;
    if (pkDSRef.current) try { viewer.dataSources.remove(pkDSRef.current); } catch (_) {}

    Cesium.GeoJsonDataSource.load(pkBound, {
      stroke:        Cesium.Color.fromCssColorString('#1a73e8').withAlpha(0.95),
      fill:          Cesium.Color.fromCssColorString('#1a73e8').withAlpha(0.08),
      strokeWidth:   3,
      clampToGround: true,
    }).then(ds => {
      viewer.dataSources.add(ds);
      pkDSRef.current = ds;
    }).catch(() => {});

    return () => { if (pkDSRef.current) try { viewer.dataSources.remove(pkDSRef.current); } catch (_) {} };
  }, [pkBound]);

  // ── Viewer setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current?.cesiumElement;
    if (!viewer) return;

    // Visual settings
    viewer.scene.globe.enableLighting          = false;
    viewer.scene.fog.enabled                   = false;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 80000;    // 80 km minimum zoom
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 3800000;  // 3800 km max (whole Pakistan visible)

    // Initial flight to Pakistan
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(PK_CENTER.lon, PK_CENTER.lat, PK_CENTER.height),
      orientation: { heading:0, pitch:Cesium.Math.toRadians(-38), roll:0 },
      duration: 2.5,
    });

    // Soft clamp: snap back to Pakistan if user pans too far away
    const snapBack = () => {
      try {
        const cart = Cesium.Cartographic.fromCartesian(viewer.camera.position);
        const lon  = Cesium.Math.toDegrees(cart.longitude);
        const lat  = Cesium.Math.toDegrees(cart.latitude);
        const cLon = Math.max(PK_BOUNDS.minLon, Math.min(PK_BOUNDS.maxLon, lon));
        const cLat = Math.max(PK_BOUNDS.minLat, Math.min(PK_BOUNDS.maxLat, lat));
        if (Math.abs(lon - cLon) > 4 || Math.abs(lat - cLat) > 4) {
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(cLon, cLat, cart.height),
            duration: 0.8,
          });
        }
      } catch (_) {}
    };
    viewer.camera.moveEnd.addEventListener(snapBack);

    // Click handler — reads from refs so it always has latest state
    if (handlerRef.current) try { handlerRef.current.destroy(); } catch (_) {}
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(e => {
      const picked = viewer.scene.pick(e.position);
      // Ignore non-facility picks (Pakistan boundary etc.)
      if (!Cesium.defined(picked) || !picked.primitive?._facilityProps) return;
      handleNodeSelectRef.current?.(picked.primitive._facilityProps);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handlerRef.current = handler;

    return () => {
      try { handler.destroy(); } catch (_) {}
      try { viewer.camera.moveEnd.removeEventListener(snapBack); } catch (_) {}
    };
  }, []); // mount only

  // ── Route calculation ─────────────────────────────────────────────────────
  const handleNodeSelect = useCallback((props) => {
    if (routeFrom && routeFrom.asset_id !== props.asset_id) {
      const toNode = props;
      setRouteLoading(true);
      setRouteError(null);
      setSelected(null);
      networkApi.getAdvancedRoutes(routeFrom.asset_id, toNode.asset_id, 'any', { hazardWeight:0.5, riskWeight:0.5 })
        .then(res => {
          const list = res.data?.routes || [];
          if (!list.length) { setRouteError('No route found between these locations.'); return; }
          setRoutes({ list, from:routeFrom, to:toNode });
          setSelectedRouteType(list[0]?.type || null);
          setRouteFrom(null);
          // Fly back to show whole route
          viewerRef.current?.cesiumElement?.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(PK_CENTER.lon, PK_CENTER.lat, 2100000),
            duration: 1.5,
          });
        })
        .catch(err => setRouteError(err.response?.data?.error || 'Could not compute route — check both locations are connected.'))
        .finally(() => setRouteLoading(false));
    } else {
      setSelected(props);
      setRoutes(null);
    }
  }, [routeFrom]);

  useEffect(() => { handleNodeSelectRef.current = handleNodeSelect; }, [handleNodeSelect]);

  // ── URL param navigation (from chatbot) ───────────────────────────────────
  useEffect(() => {
    if (!features.length) return;
    const flyToId = searchParams.get('flyTo');
    const fromId  = searchParams.get('from');
    const toId    = searchParams.get('to');

    if (flyToId) {
      const f = features.find(ft => ft.properties.asset_id === flyToId);
      if (f) {
        setSelected(f.properties);
        const [lon, lat] = f.geometry.coordinates;
        viewerRef.current?.cesiumElement?.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, 220000),
          duration: 2,
        });
      }
    }
    if (fromId && toId) {
      const fromF = features.find(ft => ft.properties.asset_id === fromId);
      const toF   = features.find(ft => ft.properties.asset_id === toId);
      if (fromF) setRouteFrom(fromF.properties);
      if (fromF && toF) handleNodeSelectRef.current?.(toF.properties);
    }
  }, [searchParams, features]);

  const flyToNode = useCallback((p) => {
    const f = featuresRef.current.find(ft => ft.properties.asset_id === p.asset_id);
    const coords = f?.geometry?.coordinates;
    if (coords) {
      viewerRef.current?.cesiumElement?.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(coords[0], coords[1], 180000),
        duration: 1.5,
      });
    }
  }, []);

  const clearRoute = useCallback(() => {
    setRoutes(null); setRouteFrom(null); setRouteError(null); setSelectedRouteType(null);
  }, []);

  const activeRoute = routes?.list?.find(r => r.type === selectedRouteType) || routes?.list?.[0];

  return (
    <div style={{ position:'relative', width:'100vw', height:'100vh', overflow:'hidden', background:'#0a0f1a' }}>

      {/* ── Topbar ── */}
      <div style={{
        position:'absolute', top:0, left:0, right:0, zIndex:50,
        background:'rgba(255,255,255,0.97)', borderBottom:'1px solid #e5e7eb',
        backdropFilter:'blur(8px)', height:52,
        display:'flex', alignItems:'center', padding:'0 16px', gap:0,
      }}>
        <Link to="/" style={{ fontSize:12, color:'#9ca3af', textDecoration:'none', marginRight:12, flexShrink:0 }}>← Home</Link>
        <span style={{ color:'#e5e7eb', marginRight:12 }}>|</span>
        <span style={{ fontWeight:800, fontSize:14, color:'#0f172a', marginRight:16, flexShrink:0 }}>
          🌏 3D Pakistan Trade Network
        </span>
        <div style={{ display:'flex', gap:2 }}>
          {NAV_LINKS.map(({ to, label }) => (
            <NavLink key={to} to={to} style={({ isActive }) => ({
              padding:'5px 12px', borderRadius:8, fontSize:12, fontWeight:600,
              color:isActive?'#0f172a':'#9ca3af', background:isActive?'#f1f5f9':'transparent',
              textDecoration:'none',
            })}>{label}</NavLink>
          ))}
        </div>
        <div style={{ flex:1 }} />

        {/* Route mode banner */}
        {routeFrom && (
          <div style={{ display:'flex', alignItems:'center', gap:8, marginRight:12, padding:'5px 12px', background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:20 }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:'#22C55E' }} />
            <span style={{ fontSize:12, fontWeight:700, color:'#166534' }}>
              From: {resolveNodeName(routeFrom)} — click a destination
            </span>
            <button onClick={() => setRouteFrom(null)} style={{ color:'#16a34a', cursor:'pointer', background:'none', border:'none', fontSize:14 }}>×</button>
          </div>
        )}
        {routeLoading && (
          <div style={{ display:'flex', alignItems:'center', gap:6, marginRight:12, fontSize:12, color:'#3b82f6', fontWeight:600 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ animation:'spin 1s linear infinite' }}>
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity=".25"/>
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            </svg>
            Calculating route…
          </div>
        )}
        {routeError && (
          <div style={{ marginRight:12, fontSize:12, color:'#ef4444', fontWeight:600, maxWidth:240 }}>
            {routeError}
            <button onClick={() => setRouteError(null)} style={{ marginLeft:4, cursor:'pointer', background:'none', border:'none', color:'#ef4444', fontWeight:800 }}>×</button>
          </div>
        )}

        {/* Filter tabs */}
        <div style={{ display:'flex', gap:4, marginRight:12 }}>
          {[
            { id:'all',     label:'All' },
            { id:'port',    label:`🚢 ${counts.port}` },
            { id:'dryport', label:`🏭 ${counts.dryport}` },
            { id:'station', label:`🚂 ${counts.station}` },
          ].map(({ id, label }) => (
            <button key={id} onClick={() => setFilterType(id)}
              style={{
                padding:'4px 12px', borderRadius:20, fontSize:11, fontWeight:700, cursor:'pointer', border:'none',
                color:filterType===id?'#fff':'#64748b', background:filterType===id?'#0f172a':'#f1f5f9',
              }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ borderLeft:'1px solid #e5e7eb', paddingLeft:12, fontSize:11, color:'#94a3b8' }}>
          {isLoading ? 'Loading…' : `${filtered.length} facilities`}
        </div>
      </div>

      {/* ── Cesium Viewer ── */}
      <Viewer
        ref={viewerRef}
        style={{ width:'100%', height:'100%' }}
        animation={false} timeline={false} baseLayerPicker={false}
        geocoder={false} homeButton={false} navigationHelpButton={false}
        sceneModePicker={false} infoBox={false} selectionIndicator={false}
        full
      >
        {filtered.map(f => (
          <FacilityMarker
            key={f.properties.asset_id}
            feature={f}
            isSelected={selected?.asset_id === f.properties.asset_id}
            isFrom={routeFrom?.asset_id === f.properties.asset_id}
            isTo={routes?.to?.asset_id === f.properties.asset_id}
            onSelect={handleNodeSelect}
          />
        ))}
        {activeRoute && <RoutePolyline route={activeRoute} />}
      </Viewer>

      {/* ── Panels ── */}
      {selected && !routes && (
        <LocationPanel
          node={selected}
          onClose={() => setSelected(null)}
          onSetFrom={p => { setRouteFrom(p); setRoutes(null); }}
          onFlyTo={flyToNode}
          routeFromId={routeFrom?.asset_id}
        />
      )}
      {routes && (
        <RoutePanel
          routes={routes.list}
          selectedRouteType={selectedRouteType}
          onSelectType={setSelectedRouteType}
          fromNode={routes.from}
          toNode={routes.to}
          onClear={clearRoute}
        />
      )}

      {/* ── Legend ── */}
      <div style={{
        position:'absolute', bottom:36, left:16, zIndex:30,
        background:'rgba(255,255,255,0.96)', borderRadius:12,
        padding:'10px 14px', boxShadow:'0 4px 20px rgba(0,0,0,0.14)',
        border:'1px solid #e5e7eb', minWidth:210,
      }}>
        <div style={{ fontSize:10, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:8 }}>
          Facility Types (dot colour)
        </div>
        {[
          { color:'#D85A30', icon:'🚢', label:`${counts.port} Sea Ports` },
          { color:'#534AB7', icon:'🏭', label:`${counts.dryport} Inland Terminals` },
          { color:'#1D9E75', icon:'🚂', label:`${counts.station} Rail Stations` },
        ].map(({ color, icon, label }) => (
          <div key={label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
            <div style={{ width:10, height:10, borderRadius:'50%', background:color, flexShrink:0 }} />
            <div style={{ fontSize:12, fontWeight:600, color:'#1e293b' }}>{icon} {label}</div>
          </div>
        ))}
        <div style={{ borderTop:'1px solid #f1f5f9', marginTop:4, paddingTop:8 }}>
          <div style={{ fontSize:10, color:'#94a3b8', marginBottom:4 }}>Ring outline = risk level</div>
          <div style={{ display:'flex', gap:8 }}>
            {[['#E24B4A','CRITICAL'],['#EF9F27','HIGH'],['#1D9E75','LOW']].map(([c,l]) => (
              <div key={l} style={{ display:'flex', alignItems:'center', gap:4 }}>
                <div style={{ width:10, height:10, borderRadius:'50%', background:'transparent', border:`2px solid ${c}` }} />
                <span style={{ fontSize:10, color:'#64748b' }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Hint ── */}
      {!isLoading && !routeFrom && !routes && !selected && (
        <div style={{
          position:'absolute', bottom:36, left:'50%', transform:'translateX(-50%)',
          zIndex:30, pointerEvents:'none',
          background:'rgba(15,23,42,0.78)', color:'#fff',
          borderRadius:20, padding:'7px 18px', fontSize:12, fontWeight:600,
          backdropFilter:'blur(8px)', whiteSpace:'nowrap',
        }}>
          Click any facility to inspect · set a starting point to plan a route
        </div>
      )}
    </div>
  );
}
