/**
 * Route Planner — uses network_edges + network_nodes from PostGIS.
 *
 * Four distinct route alternatives:
 *   FASTEST  — pure travel time (no hazard penalty)
 *   SAFEST   — avoids hazard/risk zones (hw=3.5, rw=3.5)
 *   BALANCED — user's avoidance toggle
 *   SHORTEST — fewest kilometres
 *
 * Layout: Left sidebar (form) | Map (center) | Right sidebar (results)
 */
import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { networkApi, combinedApi, hazardApi } from '../api/networkApi';
import RouteVisualizationMap from '../components/map/RouteVisualizationMap';
import Topbar from '../components/Topbar';
import { TIER_COLOR } from '../styles/tokens';
import { resolveNodeName } from '../utils/nearestCity';

// ── Constants ────────────────────────────────────────────────────────────────

const ROUTE_META = {
  FASTEST:  { icon: '⚡', label: 'Fastest',  tagline: 'Pure travel time', order: 2 },
  SAFEST:   { icon: '🛡', label: 'Safest',   tagline: 'Avoids flood, shutdown & risk zones', order: 1 },
  BALANCED: { icon: '⚖️', label: 'Balanced', tagline: 'Speed + safety', order: 3 },
  SHORTEST: { icon: '📏', label: 'Shortest', tagline: 'Fewest kilometres', order: 4 },
};

const MODE_META = {
  road:       { icon: '🛣️', label: 'Road',           color: '#534AB7' },
  rail:       { icon: '🚂', label: 'Railway',         color: '#1D9E75' },
  intermodal: { icon: '🔗', label: 'Terminal Access', color: '#EF9F27' },
};

const NODE_TYPE_ICON  = { port:'🚢', dryport:'🏭', station:'🚂', rail_station:'🚂', road_intersection:'⬡', rail_intersection:'⬡' };
const NODE_TYPE_LABEL = { port:'Sea Port', dryport:'Inland Container Terminal', station:'Railway Station', rail_station:'Railway Station', road_intersection:'Road Junction', rail_intersection:'Rail Junction' };

function tierColor(tier) { return TIER_COLOR[tier] || '#6B7280'; }
function tierLabel(tier) {
  return { CRITICAL: 'Critical Risk', HIGH: 'High Risk', MEDIUM: 'Moderate Risk', LOW: 'Safe' }[tier] || tier;
}
function facilityLabel(f) {
  if (!f) return '';
  return f.display_name || f.name || resolveNodeName(f) || f.asset_id || '';
}
function isFacility(t) { return ['port','dryport','station','rail_station'].includes(t); }
function segmentNodeName(seg, side) {
  const name = seg[`${side}_name`];
  if (name) return name;
  return resolveNodeName({ name:'', node_type: seg[`${side}_node_type`]||'', asset_id: seg[`${side}_asset_id`]||'', lat: seg[`${side}_lat`], lon: seg[`${side}_lon`] });
}

// ── Searchable Facility Combobox ─────────────────────────────────────────────

function FacilityCombobox({ label, value, onChange, facilities, icon }) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  const selected = useMemo(() => facilities.find(f => f.asset_id === value), [facilities, value]);

  const grouped = useMemo(() => {
    const q = search.toLowerCase();
    const match = (f) => facilityLabel(f).toLowerCase().includes(q) || (f.asset_id || '').toLowerCase().includes(q);
    return [
      { group: '🚢 Sea Ports',                    type: 'port',     items: facilities.filter(f => f.node_type === 'port'         && match(f)) },
      { group: '🏭 Inland Container Terminals',   type: 'dryport',  items: facilities.filter(f => f.node_type === 'dryport'      && match(f)) },
      { group: '🚂 Railway Stations',             type: 'station',  items: facilities.filter(f => ['station','rail_station'].includes(f.node_type) && match(f)) },
    ].filter(g => g.items.length > 0);
  }, [facilities, search]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const riskTier = selected?.risk_tier;
  const riskC    = riskTier ? tierColor(riskTier) : null;

  return (
    <div ref={ref} className="relative">
      <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1.5">{icon} {label}</div>
      <button type="button" onClick={() => { setOpen(o => !o); setSearch(''); }}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-white border border-gray-200 hover:border-gray-400 rounded-xl text-sm transition text-left shadow-sm">
        {selected ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex-shrink-0">{NODE_TYPE_ICON[selected.node_type] || '📍'}</span>
            <span className="text-slate-800 font-semibold truncate">{facilityLabel(selected)}</span>
            {riskC && (
              <span className="text-xs font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: riskC + '20', color: riskC, border: `1px solid ${riskC}40` }}>
                {riskTier}
              </span>
            )}
          </div>
        ) : (
          <span className="text-gray-400">Select terminal or station…</span>
        )}
        <svg className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden" style={{ maxHeight: 280 }}>
          <div className="p-2 border-b border-gray-100 sticky top-0 bg-white">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search terminals…"
              className="w-full px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-slate-800 text-xs placeholder-gray-400 outline-none focus:border-gray-400"
            />
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 220 }}>
            {grouped.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-400 text-center">No matching terminals</div>
            )}
            {grouped.map(({ group, items }) => (
              <div key={group}>
                <div className="px-3 py-1.5 text-xs font-bold text-gray-400 bg-gray-50 sticky top-0">{group}</div>
                {items.map(f => {
                  const rc = f.risk_tier ? tierColor(f.risk_tier) : null;
                  return (
                    <button key={f.asset_id} type="button"
                      onClick={() => { onChange(f.asset_id); setOpen(false); setSearch(''); }}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-gray-50 ${f.asset_id === value ? 'bg-gray-50' : ''}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span>{NODE_TYPE_ICON[f.node_type] || '📍'}</span>
                        <div className="min-w-0">
                          <div className="text-slate-800 font-medium truncate">{facilityLabel(f)}</div>
                          <div className="text-gray-400">{NODE_TYPE_LABEL[f.node_type]}</div>
                        </div>
                      </div>
                      {rc && (
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: rc + '15', color: rc, border: `1px solid ${rc}30` }}>
                          {f.risk_tier}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Journey Timeline ─────────────────────────────────────────────────────────

function JourneyTimeline({ route, onSegmentClick }) {
  const segs = route?.journey_segments;
  if (!segs?.length) return null;

  return (
    <div className="border border-gray-200 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div>
          <div className="text-slate-800 font-bold text-sm">Journey Breakdown</div>
          <div className="text-gray-400 text-xs">{segs.length} leg{segs.length > 1 ? 's' : ''} · click a leg to fly map</div>
        </div>
        <div className="text-right">
          <div className="text-slate-900 font-black">{route.travel_time_hr?.toFixed(1)}h</div>
          <div className="text-gray-400 text-xs">{route.distance_km?.toFixed(0)} km</div>
        </div>
      </div>
      <div className="px-3 py-2 bg-white">
        {segs.map((seg, idx) => {
          const mm      = MODE_META[seg.mode] || MODE_META.road;
          const tc      = tierColor(seg.max_risk_tier);
          const fromNm  = segmentNodeName(seg, 'from');
          const toNm    = segmentNodeName(seg, 'to');
          const isFirst = idx === 0;
          const isLast  = idx === segs.length - 1;

          return (
            <div key={seg.step}>
              {isFirst && (
                <div className="flex items-center gap-2.5 py-1.5">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0"
                    style={{ backgroundColor: '#22C55E20', border: '2px solid #22C55E' }}>
                    {NODE_TYPE_ICON[seg.from_node_type] || '📍'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-slate-800 text-xs font-bold truncate">{fromNm || 'Origin'}</div>
                    <div className="text-gray-400 text-xs">{NODE_TYPE_LABEL[seg.from_node_type] || seg.from_node_type}</div>
                  </div>
                  <div className="text-green-600 text-xs font-bold">START</div>
                </div>
              )}

              <button onClick={() => onSegmentClick?.(seg)}
                className="w-full flex items-start gap-2.5 py-1 px-1 rounded-xl hover:bg-gray-50 transition text-left group">
                <div className="flex flex-col items-center w-6 flex-shrink-0 pt-0.5">
                  <div className="w-px flex-1 min-h-[24px]" style={{
                    backgroundColor: mm.color,
                    backgroundImage: seg.mode === 'rail'
                      ? `repeating-linear-gradient(to bottom, ${mm.color} 0, ${mm.color} 5px, transparent 5px, transparent 9px)`
                      : seg.mode === 'intermodal'
                      ? `repeating-linear-gradient(to bottom, ${mm.color} 0, ${mm.color} 3px, transparent 3px, transparent 6px)`
                      : undefined,
                  }} />
                </div>
                <div className="flex-1 min-w-0 pb-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold" style={{ color: mm.color }}>{mm.icon} {mm.label}</span>
                    {seg.road_type && <span className="text-gray-400 text-xs capitalize">{seg.road_type.replace(/_/g,' ')}</span>}
                    <span className="text-xs font-bold px-1.5 py-0.5 rounded-full border"
                      style={{ color: tc, borderColor: tc+'40', backgroundColor: tc+'12' }}>
                      {tierLabel(seg.max_risk_tier)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                    <span className="font-semibold text-slate-700">{seg.length_km.toFixed(1)} km</span>
                    <span>{seg.travel_time_min} min</span>
                    <span className="text-gray-300">{seg.edge_count} segments</span>
                  </div>
                  {seg.max_risk_tier !== 'LOW' && (
                    <div className="text-xs mt-0.5 font-medium" style={{ color: tc }}>
                      ⚠ {Math.round((seg.avg_composite_risk||0)*100)}% risk · {Math.round((seg.avg_composite_hazard||0)*100)}% hazard
                    </div>
                  )}
                </div>
              </button>

              {!isLast && (
                <div className="flex items-center gap-2.5 py-1">
                  <div className="w-6 flex justify-center flex-shrink-0">
                    <div className="w-2.5 h-2.5 rounded-full border-2 border-gray-300 bg-white" />
                  </div>
                  <div className="text-xs text-gray-400 truncate">{toNm || 'Junction'}</div>
                  <div className="ml-auto text-gray-300 text-xs flex-shrink-0">mode change</div>
                </div>
              )}

              {isLast && (
                <div className="flex items-center gap-2.5 py-1.5">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0"
                    style={{ backgroundColor: '#E24B4A20', border: '2px solid #E24B4A' }}>
                    {NODE_TYPE_ICON[seg.to_node_type] || '🏁'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-slate-800 text-xs font-bold truncate">{toNm || 'Destination'}</div>
                    <div className="text-gray-400 text-xs">{NODE_TYPE_LABEL[seg.to_node_type] || seg.to_node_type}</div>
                  </div>
                  <div className="text-red-500 text-xs font-bold">END</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Route Summary Card ───────────────────────────────────────────────────────

function RouteCard({ route, isSelected, onSelect, base }) {
  const meta   = ROUTE_META[route.type] || ROUTE_META.FASTEST;
  const hz     = route.hazard_summary || {};
  const bd     = route.mode_breakdown || {};
  const tdiff  = base && route.type !== base.type ? route.travel_time_hr - base.travel_time_hr : null;
  const avgHaz = Math.round((hz.avg_composite_hazard || 0) * 100);
  const maxTier = avgHaz >= 75 ? 'CRITICAL' : avgHaz >= 50 ? 'HIGH' : avgHaz >= 30 ? 'MEDIUM' : 'LOW';
  const tc     = tierColor(maxTier);

  return (
    <div onClick={onSelect} className={`rounded-2xl border cursor-pointer transition-all overflow-hidden bg-white ${
        isSelected ? 'border-amber-400 shadow-md' : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
      }`}>

      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2.5 border-b ${isSelected ? 'border-amber-100 bg-amber-50/60' : 'border-gray-100 bg-gray-50'}`}>
        <div className="flex items-center gap-2">
          <span className="text-lg">{meta.icon}</span>
          <div>
            <div className="text-slate-800 font-bold text-sm">{meta.label}</div>
            <div className="text-gray-400 text-xs">{meta.tagline}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {isSelected && <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full border border-amber-200">On Map</span>}
          <span className="text-xs font-bold px-2 py-0.5 rounded-full border"
            style={{ color: tc, borderColor: tc+'45', backgroundColor: tc+'12' }}>
            {tierLabel(maxTier)}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="px-3 py-2.5 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-50 rounded-xl p-2.5 border border-gray-100">
            <div className="text-gray-400 text-xs">Travel Time</div>
            <div className="text-slate-900 font-black text-xl mt-0.5">
              {route.travel_time_hr?.toFixed(1)}<span className="text-xs font-normal text-gray-400"> hrs</span>
            </div>
            {tdiff !== null && (
              <div className={`text-xs font-semibold mt-0.5 ${tdiff > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                {tdiff > 0 ? `+${tdiff.toFixed(1)}h` : `${Math.abs(tdiff).toFixed(1)}h faster`}
              </div>
            )}
          </div>
          <div className="bg-gray-50 rounded-xl p-2.5 border border-gray-100">
            <div className="text-gray-400 text-xs">Distance</div>
            <div className="text-slate-900 font-black text-xl mt-0.5">
              {route.distance_km?.toFixed(0)}<span className="text-xs font-normal text-gray-400"> km</span>
            </div>
          </div>
        </div>

        {/* Hazard bars */}
        <div className="bg-gray-50 rounded-xl px-2.5 py-2 space-y-1.5 border border-gray-100">
          {[
            { label: 'Flood / threat', v: hz.avg_composite_hazard || 0,         color: tc },
            { label: 'Risk (H×E×V)',  v: hz.avg_composite_risk || 0,            color: '#8B5CF6' },
            { label: 'Network risk',  v: hz.avg_network_criticality_risk || 0,  color: '#EF9F27' },
          ].map(({ label, v, color }) => (
            <div key={label} className="flex items-center gap-2">
              <div className="text-gray-400 text-xs w-24 flex-shrink-0">{label}</div>
              <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.round(v*100)}%`, backgroundColor: color }} />
              </div>
              <div className="text-slate-700 text-xs font-bold w-7 text-right">{Math.round(v*100)}%</div>
            </div>
          ))}
        </div>

        {/* Mode breakdown */}
        {(bd.road_km > 0 || bd.rail_km > 0) && (
          <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100">
            {bd.road_pct  > 0 && <div style={{ width:`${bd.road_pct}%`,  backgroundColor:'#534AB7' }} />}
            {bd.rail_pct  > 0 && <div style={{ width:`${bd.rail_pct}%`,  backgroundColor:'#1D9E75' }} />}
            {bd.intermodal_pct > 0 && <div style={{ width:`${Math.max(bd.intermodal_pct,2)}%`, backgroundColor:'#EF9F27' }} />}
          </div>
        )}

        {avgHaz >= 50 && (
          <div className="text-xs rounded-xl px-2.5 py-1.5 border"
            style={{ backgroundColor: tc+'12', borderColor: tc+'30', color: tc }}>
            {avgHaz >= 75 ? '🔴 Critical hazard — use the Safest route' : '⚠ Moderate hazard — proceed with caution'}
          </div>
        )}
        {route.rail_note && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-2.5 py-1.5 text-xs text-amber-700">ℹ️ {route.rail_note}</div>
        )}
      </div>
    </div>
  );
}

// ── Advanced Cost Calculator ──────────────────────────────────────────────────

const VEHICLES = [
  { id: 'truck20', icon: '🚛', label: '20-Ton Truck',      fuelEff: 5.0, tollMW: 130, tollPri: 40,  wageHr: 900,  capTons: 20 },
  { id: 'truck40', icon: '🏗',  label: '40-Ton Container', fuelEff: 4.0, tollMW: 200, tollPri: 65,  wageHr: 1100, capTons: 40 },
  { id: 'reefer',  icon: '❄️', label: 'Reefer Truck',      fuelEff: 3.5, tollMW: 180, tollPri: 55,  wageHr: 1200, capTons: 15 },
  { id: 'rail',    icon: '🚂', label: 'Rail Container',    fuelEff: null, ratePerTonKm: 8, wageHr: 0, capTons: 60 },
];
const RISK_INS = { CRITICAL: 3.5, HIGH: 2.2, MEDIUM: 1.4, LOW: 1.0 };

function fmt(n) { return Math.round(n).toLocaleString('en-PK'); }

function CostRow({ icon, label, value, sub, bold, warn }) {
  return (
    <div className={`flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0 ${bold ? 'font-bold' : ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-base flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className={`text-xs ${bold ? 'text-slate-900' : 'text-slate-700'}`}>{label}</div>
          {sub && <div className="text-gray-400 text-xs">{sub}</div>}
        </div>
      </div>
      <div className={`text-xs font-bold flex-shrink-0 ml-2 ${bold ? 'text-slate-900 text-sm' : warn ? 'text-amber-600' : 'text-slate-700'}`}>
        PKR {fmt(value)}
      </div>
    </div>
  );
}

function AdvancedCostCalculator({ route }) {
  const [vehicleId,  setVehicleId]  = useState('truck20');
  const [cargoTons,  setCargoTons]  = useState(10);
  const [cargoValue, setCargoValue] = useState(500000);
  const [fuelPrice,  setFuelPrice]  = useState(280);
  const [showDetail, setShowDetail] = useState(true);

  const distKm = route?.distance_km || 0;
  const timeHr = route?.travel_time_hr || 0;
  const hz     = route?.hazard_summary || {};
  const bd     = route?.mode_breakdown || {};
  const avgHaz = Math.round((hz.avg_composite_hazard || 0) * 100);
  const riskT  = avgHaz >= 75 ? 'CRITICAL' : avgHaz >= 50 ? 'HIGH' : avgHaz >= 30 ? 'MEDIUM' : 'LOW';

  const veh = VEHICLES.find(v => v.id === vehicleId) || VEHICLES[0];

  // Cost model
  const roadKm = bd.road_km || distKm;
  const railKm = bd.rail_km || 0;
  const mwKm   = roadKm * 0.35; // estimate 35% motorway
  const priKm  = roadKm * 0.45;

  let fuelCost = 0, tollCost = 0, railCost = 0;
  if (veh.id === 'rail') {
    railCost = cargoTons * railKm * veh.ratePerTonKm;
    fuelCost = roadKm > 0 ? (roadKm / VEHICLES[0].fuelEff) * fuelPrice : 0;
    tollCost = mwKm * VEHICLES[0].tollMW + priKm * VEHICLES[0].tollPri;
  } else {
    fuelCost = (distKm / veh.fuelEff) * fuelPrice;
    tollCost = mwKm * veh.tollMW + priKm * veh.tollPri;
  }

  const driverCost   = timeHr * veh.wageHr;
  const insMulti     = RISK_INS[riskT] || 1.0;
  const insCost      = cargoValue * 0.003 * insMulti;       // 0.3% base × risk
  const hazSurcharge = fuelCost * (avgHaz / 100) * 0.12;    // up to 12% fuel surcharge for detours
  const delayHr      = timeHr * (avgHaz / 100) * 0.18;      // potential delay
  const delayCost    = delayHr * veh.wageHr;

  const subtotal = fuelCost + railCost + tollCost + driverCost + insCost + hazSurcharge + delayCost;
  const perTon   = cargoTons > 0 ? subtotal / cargoTons : 0;
  const perKm    = distKm    > 0 ? subtotal / distKm    : 0;

  const riskColor = { CRITICAL: '#E24B4A', HIGH: '#EF9F27', MEDIUM: '#EAB308', LOW: '#22C55E' }[riskT];

  return (
    <div className="border border-gray-200 rounded-2xl overflow-hidden bg-white">
      <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
        <div>
          <div className="text-slate-800 font-bold text-sm">Advanced Cost Estimator</div>
          <div className="text-gray-400 text-xs">{distKm.toFixed(0)} km · {timeHr.toFixed(1)}h · Risk: <span className="font-bold" style={{ color: riskColor }}>{riskT}</span></div>
        </div>
        <button onClick={() => setShowDetail(p => !p)} className="text-xs text-gray-400 hover:text-slate-700 transition">
          {showDetail ? 'Collapse ▲' : 'Expand ▼'}
        </button>
      </div>

      <div className="px-3 py-3 space-y-3">
        {/* Vehicle selector */}
        <div>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Vehicle Type</div>
          <div className="grid grid-cols-2 gap-1.5">
            {VEHICLES.map(v => (
              <button key={v.id} onClick={() => setVehicleId(v.id)}
                className={`text-left px-2.5 py-2 rounded-xl border text-xs transition ${vehicleId === v.id ? 'bg-slate-900 border-slate-900 text-white' : 'border-gray-200 hover:bg-gray-50 text-slate-700'}`}>
                <div className="text-base mb-0.5">{v.icon}</div>
                <div className="font-semibold">{v.label}</div>
                <div className={`text-xs ${vehicleId === v.id ? 'text-white/60' : 'text-gray-400'}`}>
                  {v.fuelEff ? `${v.fuelEff} km/l` : `PKR ${v.ratePerTonKm}/ton·km`} · {v.capTons}t cap
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Sliders */}
        {showDetail && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-500">Cargo weight</span>
                  <span className="font-bold text-slate-700">{cargoTons} tons</span>
                </div>
                <input type="range" min={1} max={veh.capTons} value={Math.min(cargoTons, veh.capTons)}
                  onChange={e => setCargoTons(+e.target.value)}
                  className="w-full h-1.5 accent-slate-700" />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-500">Fuel price</span>
                  <span className="font-bold text-slate-700">PKR {fuelPrice}/L</span>
                </div>
                <input type="range" min={250} max={340} step={5} value={fuelPrice}
                  onChange={e => setFuelPrice(+e.target.value)}
                  className="w-full h-1.5 accent-amber-500" />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-500">Cargo declared value</span>
                <span className="font-bold text-slate-700">PKR {fmt(cargoValue)}</span>
              </div>
              <input type="range" min={50000} max={5000000} step={50000} value={cargoValue}
                onChange={e => setCargoValue(+e.target.value)}
                className="w-full h-1.5 accent-blue-500" />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>PKR 50K</span><span>PKR 50L</span>
              </div>
            </div>
          </>
        )}

        {/* Breakdown */}
        {showDetail && (
          <div className="bg-gray-50 rounded-xl px-3 py-2 border border-gray-100">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Cost Breakdown</div>
            {veh.id === 'rail' ? (
              <CostRow icon="🚂" label="Rail freight" sub={`${cargoTons}t × ${railKm.toFixed(0)} km @ PKR ${veh.ratePerTonKm}`} value={railCost} />
            ) : (
              <CostRow icon="⛽" label="Fuel" sub={`${distKm.toFixed(0)} km ÷ ${veh.fuelEff} km/L × PKR ${fuelPrice}`} value={fuelCost} />
            )}
            <CostRow icon="🛣" label="Tolls & levies" sub={`${mwKm.toFixed(0)} km motorway + ${priKm.toFixed(0)} km primary`} value={tollCost} />
            {driverCost > 0 && <CostRow icon="👤" label="Driver wages" sub={`${timeHr.toFixed(1)}h × PKR ${veh.wageHr}/hr`} value={driverCost} />}
            <CostRow icon="🔒" label="Cargo insurance" sub={`0.3% × PKR ${fmt(cargoValue)} × ${insMulti}× risk`} value={insCost} />
            {hazSurcharge > 1 && <CostRow icon="⚠️" label="Hazard surcharge" sub={`${avgHaz}% route hazard → route detour cost`} value={hazSurcharge} warn />}
            {delayCost > 1 && <CostRow icon="⏱" label="Estimated delay cost" sub={`${delayHr.toFixed(1)}h potential delay`} value={delayCost} warn />}
          </div>
        )}

        {/* Total */}
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl px-3 py-3 border border-amber-100">
          <div className="flex items-center justify-between mb-1">
            <span className="text-gray-600 text-sm font-bold">Total Estimated Cost</span>
            <span className="text-2xl font-black text-amber-700">PKR {fmt(subtotal)}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
            <span>PKR {fmt(perTon)}/ton</span>
            <span>·</span>
            <span>PKR {perKm.toFixed(0)}/km</span>
            {avgHaz > 30 && (
              <>
                <span>·</span>
                <span className="text-amber-600 font-semibold">+{Math.round(avgHaz * 0.12)}% hazard premium</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// ── sessionStorage helpers ────────────────────────────────────────────────────
const STORAGE_KEY = 'ptl_last_route';
function saveSession(data) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}

export default function RoutePlanner() {
  const [searchParams] = useSearchParams();
  const mapRef = useRef(null);

  // Initialise from URL params first, fall back to sessionStorage, then empty
  const [from,        setFrom]        = useState(() => {
    const p = searchParams.get('from'); if (p) return p;
    return loadSession()?.from || '';
  });
  const [to,          setTo]          = useState(() => {
    const p = searchParams.get('to'); if (p) return p;
    return loadSession()?.to || '';
  });
  const [mode,        setMode]        = useState(() => {
    const p = searchParams.get('mode');
    if (p && ['any','road','rail'].includes(p)) return p;
    return loadSession()?.mode || 'any';
  });
  const [avoidRisk,   setAvoidRisk]   = useState(() => {
    const p = searchParams.get('avoidRisk');
    if (p !== null) return p !== '0';
    return loadSession()?.avoidRisk ?? true;
  });
  const [routes,      setRoutes]      = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error,       setError]       = useState(null);
  const [leftOpen,    setLeftOpen]    = useState(true);
  const [rightOpen,   setRightOpen]   = useState(true);

  const { data: facilityGeoJSON } = useQuery({
    queryKey: ['facilities-for-route'],
    queryFn: () => combinedApi.getNodes({ type: 'port,dryport,station,rail_station' }).then(r => r.data),
    staleTime: 120000,
  });
  const { data: hazSum } = useQuery({
    queryKey: ['hazard-summary'],
    queryFn: () => hazardApi.getSummary().then(r => r.data),
    refetchInterval: 30000,
  });

  const facilities = useMemo(
    () => (facilityGeoJSON?.features?.map(f => f.properties).filter(Boolean) || []),
    [facilityGeoJSON]
  );
  const fromFacility = useMemo(() => facilities.find(f => f.asset_id === from), [facilities, from]);
  const toFacility   = useMemo(() => facilities.find(f => f.asset_id === to),   [facilities, to]);

  const handleSwap = () => { const t = from; setFrom(to); setTo(t); };

  const handleSearch = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true); setError(null); setSelectedIdx(0); setRoutes(null);
    try {
      const hw = avoidRisk ? 1.8 : 0.2;
      const rw = avoidRisk ? 2.5 : 0.2;
      const res = await networkApi.getAdvancedRoutes(from, to, mode, { hazardWeight: hw, riskWeight: rw });
      const list = (res.data.routes || []).sort((a, b) => (ROUTE_META[a.type]?.order || 9) - (ROUTE_META[b.type]?.order || 9));
      if (!list.length) { setError('No route found between these terminals. Try a different mode.'); return; }
      setRoutes(list);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not calculate route. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [from, to, mode, avoidRisk]);

  // Track last URL params string so we detect when chat navigates with new from/to
  const lastParamsRef = useRef('');
  const autoSearched  = useRef(false);

  // Sync state from URL whenever params change — handles both first-mount and chat navigation
  useEffect(() => {
    const pFrom  = searchParams.get('from')   || '';
    const pTo    = searchParams.get('to')     || '';
    const pMode  = searchParams.get('mode')   || '';
    const pAvoid = searchParams.get('avoidRisk');
    const sig    = `${pFrom}|${pTo}|${pMode}`;

    if (!pFrom || !pTo) return;               // nothing to do
    if (sig === lastParamsRef.current) return; // same params, skip

    lastParamsRef.current = sig;
    autoSearched.current  = false;  // allow new auto-search

    setFrom(pFrom);
    setTo(pTo);
    if (pMode && ['any','road','rail'].includes(pMode)) setMode(pMode);
    if (pAvoid !== null) setAvoidRisk(pAvoid !== '0');
    setRoutes(null);
    setError(null);
  }, [searchParams]);

  // Auto-search once from+to are set and facilities are loaded
  useEffect(() => {
    if (autoSearched.current || !from || !to || facilities.length === 0) return;
    autoSearched.current = true;
    handleSearch();
  }, [from, to, facilities.length, handleSearch]);

  // Persist last successful search to sessionStorage
  useEffect(() => {
    if (routes && from && to) {
      saveSession({ from, to, mode, avoidRisk });
    }
  }, [routes, from, to, mode, avoidRisk]);

  const handleSegmentClick = useCallback((seg) => {
    if (!mapRef.current) return;
    const lat = seg.from_lat != null && seg.to_lat != null ? (seg.from_lat + seg.to_lat) / 2 : seg.from_lat ?? seg.to_lat;
    const lon = seg.from_lon != null && seg.to_lon != null ? (seg.from_lon + seg.to_lon) / 2 : seg.from_lon ?? seg.to_lon;
    if (lat != null && lon != null) mapRef.current.flyTo({ center: [lon, lat], zoom: 9, duration: 800 });
  }, []);

  const selectedRoute = routes?.[selectedIdx] ?? null;
  const floodActive   = hazSum?.flood?.status === 'CRITICAL' || hazSum?.flood?.status === 'ACTIVE';
  const routeCount    = routes?.length ?? 0;

  return (
    <div className="relative h-screen w-full overflow-hidden bg-gray-100">

      {/* Full-screen map */}
      <div className="absolute inset-0">
        <RouteVisualizationMap selectedRoute={selectedRoute} onMapReady={m => { mapRef.current = m; }} />
      </div>

      {/* Shared topbar */}
      <Topbar mode="floating" title="Route Planner" />

      {/* Panel toggle buttons */}
      <div className="absolute top-[56px] right-3 z-20 flex gap-1.5 mt-1.5">
        <button onClick={() => setLeftOpen(o => !o)}
          className="bg-white border border-gray-200 text-slate-700 text-xs font-bold px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition shadow-sm">
          {leftOpen ? '◀ Form' : '▶ Form'}
        </button>
        {routes && (
          <button onClick={() => setRightOpen(o => !o)}
            className="bg-white border border-gray-200 text-slate-700 text-xs font-bold px-2.5 py-1.5 rounded-lg hover:bg-gray-50 transition shadow-sm">
            {rightOpen ? 'Results ▶' : '◀ Results'}
          </button>
        )}
      </div>

      {/* ── LEFT PANEL ── */}
      <div className={`absolute top-0 left-0 bottom-0 z-10 flex flex-col transition-transform duration-300 ${leftOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ width: 300 }}>
        <div className="absolute inset-0 bg-white border-r border-gray-200 shadow-md" />
        <div className="relative flex flex-col h-full overflow-y-auto" style={{ paddingTop: 60 }}>
          <div className="px-4 pb-4 space-y-4 flex-1">

            {/* Flood warning */}
            {floodActive && (
              <div className="rounded-xl px-3 py-2.5 text-xs border mt-2 bg-red-50 border-red-200 text-red-700">
                <div className="font-bold mb-0.5">🌊 {hazSum?.flood?.status === 'CRITICAL' ? 'Flood CRITICAL' : 'Flooding Active'}</div>
                <div>{hazSum?.flood?.triggered || 0} locations affected · {Math.round((hazSum?.flood?.max_score||0)*100)}% intensity</div>
              </div>
            )}

            {/* Strike / shutdown warning */}
            {(hazSum?.strike?.triggered > 0 || hazSum?.strike?.status === 'ACTIVE' || hazSum?.strike?.status === 'CRITICAL') && (
              <div className="rounded-xl px-3 py-2.5 text-xs border mt-2 bg-amber-50 border-amber-200 text-amber-700">
                <div className="font-bold mb-0.5">🚫 Strike / Shutdown Active</div>
                <div>{hazSum?.strike?.triggered || 0} locations affected · {Math.round((hazSum?.strike?.max_score||0)*100)}% severity</div>
                {hazSum?.strike?.max_score >= 0.5 && <div className="font-semibold mt-0.5">⚠ City-wide disruption — the Safest route avoids affected areas</div>}
              </div>
            )}

            {/* Accident warning */}
            {(hazSum?.accident?.triggered > 0) && (
              <div className="rounded-xl px-3 py-2.5 text-xs border mt-2 bg-orange-50 border-orange-200 text-orange-700">
                <div className="font-bold mb-0.5">⚠️ Accident Alert</div>
                <div>{hazSum?.accident?.triggered || 0} road segments affected</div>
              </div>
            )}

            {/* Matched facility indicator — shows what the AI actually resolved */}
            {(fromFacility || toFacility) && routes && (
              <div className="rounded-xl px-3 py-2 text-xs bg-blue-50 border border-blue-100 text-blue-700">
                <div className="font-bold mb-1">✓ Route matched</div>
                {fromFacility && (
                  <div className="truncate">From: <span className="font-semibold">{fromFacility.display_name || fromFacility.name}</span></div>
                )}
                {toFacility && (
                  <div className="truncate">To: <span className="font-semibold">{toFacility.display_name || toFacility.name}</span></div>
                )}
              </div>
            )}

            <FacilityCombobox label="Starting From" value={from} onChange={setFrom} facilities={facilities} icon="📍" />

            <button onClick={handleSwap} disabled={!from && !to}
              className="w-full flex items-center justify-center gap-2 bg-gray-50 hover:bg-gray-100 disabled:opacity-30 text-gray-500 text-xs py-2 rounded-xl transition border border-gray-200">
              ↕ Swap
            </button>

            <FacilityCombobox label="Going To" value={to} onChange={setTo} facilities={facilities} icon="🏁" />

            {/* Transport mode */}
            <div>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Transport Mode</div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id:'any',  icon:'🚚', label:'Any' },
                  { id:'road', icon:'🛣️', label:'Road' },
                  { id:'rail', icon:'🚂', label:'Rail' },
                ].map(m => (
                  <button key={m.id} onClick={() => setMode(m.id)}
                    className={`py-2 rounded-xl text-xs text-center transition border ${mode===m.id ? 'bg-slate-800 text-white border-slate-800 font-bold' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                    <div className="text-base mb-0.5">{m.icon}</div>
                    <div className="font-semibold">{m.label}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Hazard avoidance toggle */}
            <div className={`rounded-xl border px-3 py-2.5 cursor-pointer transition ${avoidRisk ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-white'}`}
              onClick={() => setAvoidRisk(v => !v)}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className={`text-sm font-bold ${avoidRisk ? 'text-green-700' : 'text-gray-500'}`}>
                    {avoidRisk ? '🛡 Avoid Hazardous Roads' : '⚡ Fastest (ignore risk)'}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {avoidRisk ? 'Routes around flood, shutdown & risk zones' : 'May cross affected areas'}
                  </div>
                </div>
                <div className={`w-9 h-5 rounded-full relative flex-shrink-0 transition-colors ${avoidRisk ? 'bg-green-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${avoidRisk ? 'right-0.5' : 'left-0.5'}`} />
                </div>
              </div>
            </div>

            {/* Search button */}
            <button onClick={handleSearch} disabled={!from || !to || loading}
              className="w-full py-3 rounded-xl font-black text-sm transition text-white disabled:opacity-40"
              style={{ backgroundColor: (!from || !to || loading) ? '#d1d5db' : '#F59E0B' }}>
              {loading
                ? <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4}/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Finding routes…
                  </span>
                : `🔍 Find Routes${from && to ? '' : ' (select terminals)'}`}
            </button>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">{error}</div>
            )}

            {!routes && !loading && (
              <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 text-xs text-gray-400 space-y-1.5">
                <div className="font-bold text-gray-500 mb-1">How routing works</div>
                <div>• Uses PostGIS network_edges weighted by travel time, hazard score, and risk tier</div>
                <div>• Returns up to 4 alternatives: Safest · Fastest · Balanced · Shortest</div>
                <div>• Hazard avoidance penalises edges with high composite_hazard + risk_tier</div>
                <div>• Click any segment on map to see its risk breakdown</div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      {routes && rightOpen && (
        <div className="absolute top-0 right-0 bottom-0 z-10 flex flex-col" style={{ width: 380 }}>
          <div className="absolute inset-0 bg-white border-l border-gray-200 shadow-md" />
          <div className="relative flex flex-col h-full overflow-hidden" style={{ paddingTop: 60 }}>
            {/* Fixed header */}
            <div className="px-3 pt-2 pb-2 border-b border-gray-100 flex-shrink-0 bg-white">
              <div className="text-slate-900 font-black text-sm truncate">
                {facilityLabel(fromFacility) || from} → {facilityLabel(toFacility) || to}
              </div>
              <div className="text-gray-400 text-xs mt-0.5">
                {routeCount} route{routeCount > 1 ? 's' : ''} ·{' '}
                {avoidRisk ? 'Hazard avoidance ON' : 'Fastest mode'} ·{' '}
                {selectedRoute?.journey_segments?.length || 0} legs
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">

              {/* Route selection tabs */}
              <div className="grid grid-cols-2 gap-1.5">
                {routes.map((r, i) => {
                  const m = ROUTE_META[r.type] || ROUTE_META.FASTEST;
                  const hz = r.hazard_summary || {};
                  const avgH = Math.round((hz.avg_composite_hazard||0)*100);
                  const maxT = avgH >= 75 ? 'CRITICAL' : avgH >= 50 ? 'HIGH' : avgH >= 30 ? 'MEDIUM' : 'LOW';
                  const tc = tierColor(maxT);
                  return (
                    <button key={r.type} onClick={() => setSelectedIdx(i)}
                      className={`rounded-xl p-2.5 text-left transition border bg-white ${i===selectedIdx ? 'border-amber-400 shadow-sm' : 'border-gray-200 hover:border-gray-300'}`}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span>{m.icon}</span>
                        <span className="text-slate-800 font-bold text-xs">{m.label}</span>
                        {i===selectedIdx && <span className="text-amber-600 text-xs">✓</span>}
                      </div>
                      <div className="text-slate-900 font-black text-lg leading-tight">
                        {r.travel_time_hr?.toFixed(1)}<span className="text-xs font-normal text-gray-400">h</span>
                      </div>
                      <div className="text-gray-400 text-xs">{r.distance_km?.toFixed(0)} km</div>
                      <div className="mt-1.5 text-xs font-bold px-1.5 py-0.5 rounded-full border w-fit"
                        style={{ color: tc, borderColor: tc+'40', backgroundColor: tc+'12' }}>
                        {tierLabel(maxT)}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Selected route detail card */}
              {selectedRoute && <RouteCard route={selectedRoute} isSelected base={routes[0]} />}

              {/* Journey timeline */}
              {selectedRoute && <JourneyTimeline route={selectedRoute} onSegmentClick={handleSegmentClick} />}

              {/* Route risk breakdown */}
              {selectedRoute && (() => {
                const geo = selectedRoute?.geometry;
                const features = geo?.features || [];
                const kmByTier = { CRITICAL:0, HIGH:0, MEDIUM:0, LOW:0 };
                let totalKm = 0;
                features.forEach(f => {
                  const t = f.properties?.risk_tier || 'LOW';
                  const km = parseFloat(f.properties?.length_km || 0);
                  kmByTier[t] = (kmByTier[t]||0) + km;
                  totalKm += km;
                });
                const hasMix = Object.values(kmByTier).filter(v => v > 0).length > 1;
                if (!hasMix && kmByTier.LOW === totalKm) return null;
                return (
                  <div className="border border-gray-200 rounded-2xl overflow-hidden bg-white">
                    <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50 text-slate-800 font-bold text-sm">Risk Along Route</div>
                    <div className="px-3 py-3 space-y-2">
                      {['CRITICAL','HIGH','MEDIUM','LOW'].map(tier => {
                        const km = kmByTier[tier] || 0;
                        if (km === 0) return null;
                        const pct = totalKm > 0 ? km/totalKm*100 : 0;
                        const tc = TIER_COLOR[tier];
                        return (
                          <div key={tier} className="flex items-center gap-2">
                            <div className="w-14 text-xs font-bold" style={{ color: tc }}>{tier}</div>
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width:`${pct}%`, backgroundColor: tc }} />
                            </div>
                            <div className="text-gray-500 text-xs font-mono w-14 text-right">{km.toFixed(0)} km</div>
                          </div>
                        );
                      })}
                      {kmByTier.CRITICAL > 0 && (
                        <div className="text-xs text-red-700 bg-red-50 rounded-lg px-2.5 py-1.5 border border-red-200">
                          🔴 {kmByTier.CRITICAL.toFixed(0)} km in CRITICAL zone — consider the Safest route
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Comparison table */}
              {routes.length > 1 && (
                <div className="border border-gray-200 rounded-2xl overflow-hidden bg-white">
                  <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50 text-slate-800 font-bold text-sm">Comparison</div>
                  <div className="px-3 py-2.5 overflow-x-auto">
                    <table className="w-full text-xs min-w-[280px]">
                      <thead>
                        <tr>
                          <td className="pb-2 text-gray-300"></td>
                          {routes.map(r => <td key={r.type} className="pb-2 text-center text-gray-400 font-bold">{ROUTE_META[r.type]?.icon}</td>)}
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { label:'Time',   vals: routes.map(r => `${r.travel_time_hr?.toFixed(1)}h`) },
                          { label:'Dist.',  vals: routes.map(r => `${r.distance_km?.toFixed(0)}km`) },
                          { label:'Hazard', vals: routes.map(r => `${Math.round((r.hazard_summary?.avg_composite_hazard||0)*100)}%`) },
                          { label:'Risk',   vals: routes.map(r => `${Math.round((r.hazard_summary?.avg_composite_risk||0)*100)}%`) },
                        ].map(row => (
                          <tr key={row.label} className="border-t border-gray-100">
                            <td className="py-1.5 text-gray-400">{row.label}</td>
                            {row.vals.map((v, i) => (
                              <td key={i} className={`py-1.5 text-center font-semibold ${i===selectedIdx ? 'text-amber-600' : 'text-slate-700'}`}>{v}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Advanced cost estimator */}
              {selectedRoute && <AdvancedCostCalculator route={selectedRoute} />}

              {/* Quick links */}
              <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-400 space-y-1">
                <div className="font-bold text-gray-500 mb-1">Related tools</div>
                {from && <Link to={`/asset/${from}`} className="block hover:text-slate-700 transition">→ View {facilityLabel(fromFacility)} profile</Link>}
                {to   && <Link to={`/asset/${to}`}   className="block hover:text-slate-700 transition">→ View {facilityLabel(toFacility)} profile</Link>}
                {from && <Link to={`/scenario?target=${from}`} className="block hover:text-slate-700 transition">→ Simulate disruption at {facilityLabel(fromFacility)}</Link>}
                {to   && <Link to={`/scenario?target=${to}`}   className="block hover:text-slate-700 transition">→ Simulate disruption at {facilityLabel(toFacility)}</Link>}
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
