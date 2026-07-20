# Pakistan TradeLink — Frontend Rewrite Plan v2
## GeoResilience Intelligence Platform · FYP 2 · April 2026

> **Scope:** Full frontend rewrite with correct data flow, routing model, name resolution, and live pipeline sync.
> **Skipped:** AIS port monitor, 3D layers, LLM chatbot (deferred).
> **Live data confirmed:** 12,570 nodes · 14,122 edges · 40K km · 240 CRITICAL · 2,677 HIGH hazard alerts · Flood CRITICAL (919 triggered, 88% max score)

---

## The Core User Story (What This Platform Actually Does)

There are two kinds of users:

**An investor** opens the dashboard and asks: *"Is Pakistan's supply chain under threat today? Which assets are critical right now?"*

**A trucker or logistics manager** opens the route planner and asks: *"I need to move cargo from Lahore Dryport to Karachi Port. Which route is safe right now given the current flood situation?"*

Both users rely on the same data pipeline:

```
network_model.py (runs once)
  → stores 12,570 nodes + 14,122 edges in PostGIS
  → computes centrality, travel times, 861 corridors

hazard_model.py (runs every 30 minutes)
  → fetches live flood / cyclone / strike / accident data
  → scores every node and edge: hazard_flood, hazard_strike...
  → writes to hazard_nodes_latest + hazard_edges_latest
  → TODAY: 240 CRITICAL nodes, flood at 88% triggered 919 nodes

risk_engine.py (runs every 60 minutes, 5 min after hazard)
  → applies UNDRR formula: Risk = Hazard × Exposure × Vulnerability
  → writes risk_nodes_latest + risk_edges_latest
  → tags chokepoints, computes network_criticality_risk

Dashboard refreshes (every 30 seconds via React Query)
  → map re-colors nodes/edges with new risk/hazard tiers
  → KPI panel updates counts in real time
  → trucker sees: "Route via M-9 is HIGH risk — avoid"
```

**This is the primary value proposition.** The network is static. The hazard and risk scores are live. The map is the lens that makes live data spatially understandable.

---

## Critical Implementation Detail: Node & Edge Name Resolution

### The Problem

Your PostGIS database stores nodes and edges with computer-generated IDs:
- Nodes: `road_int_4521`, `rail_int_28`, `port_1`, `dryport_5`
- Edges: `road_12973`, `rail_7`, `access_6`

Road intersections and rail intersections have **no human-readable name** — they are topology nodes derived from line endpoints. Only facilities (ports, dryports, stations) have real names.

### The Rule

```
IF node_type IN ('port', 'dryport', 'station', 'rail_station'):
  → Display: stored name from network_nodes table
    e.g. "Karachi Port", "Lahore Dryport", "Kotri Junction"

IF node_type IN ('road_intersection', 'rail_intersection'):
  → Display: reverse-geocoded place name OR nearest city + distance
    e.g. "Near Hyderabad (M-9 Junction, km 42)" 
    e.g. "Near Sukkur (N-55 / N-70 Interchange)"
  → Fallback if geocoding unavailable: "Road Junction · 25.23°N 68.37°E"
```

### How to Implement Name Resolution

**Option A — Reverse geocoding at query time (recommended for facility nodes)**

The `combined_nodes` endpoint should already return `display_name` from the network_nodes table. For facility nodes, this is populated. For intersections, it may be null.

**Option B — Static city proximity lookup (for intersection nodes)**

Keep a client-side lookup of Pakistan's major cities (lat/lon → city name). When displaying an intersection node, find the nearest city within 30 km and show "Near [City]".

```js
// src/utils/nearestCity.js
const PAKISTAN_CITIES = [
  { name: 'Karachi',   lat: 24.861, lon: 67.011 },
  { name: 'Lahore',    lat: 31.558, lon: 74.352 },
  { name: 'Islamabad', lat: 33.738, lon: 73.084 },
  { name: 'Peshawar',  lat: 34.015, lon: 71.579 },
  { name: 'Quetta',    lat: 30.183, lon: 67.001 },
  { name: 'Multan',    lat: 30.197, lon: 71.478 },
  { name: 'Faisalabad',lat: 31.417, lon: 73.079 },
  { name: 'Hyderabad', lat: 25.396, lon: 68.374 },
  { name: 'Sukkur',    lat: 27.706, lon: 68.867 },
  { name: 'Gwadar',    lat: 25.122, lon: 62.325 },
  // ... add 40 more tehsil-level towns
];

export function resolveNodeName(node) {
  if (node.display_name)  return node.display_name;
  if (node.name)          return node.name;
  
  // For intersections: find nearest city
  const nearest = PAKISTAN_CITIES.reduce((best, city) => {
    const d = haversineKm(node.lat, node.lon, city.lat, city.lon);
    return d < best.dist ? { city, dist: d } : best;
  }, { city: null, dist: Infinity });
  
  if (nearest.dist < 30) {
    return `Near ${nearest.city.name}`;
  }
  return `Junction · ${node.lat.toFixed(2)}°N ${node.lon.toFixed(2)}°E`;
}
```

**Option C — Backend `display_name` column (cleanest long-term)**

In `network_nodes`, add a `display_name` column populated by a one-time script:
- For facilities: copy from `name` column
- For intersections: run Python reverse geocoding using `nominatim` or the city CSV
- This means the frontend never needs to geocode — just reads `display_name`

This is the recommended approach. Run it once after `network_model.py`.

### Name Resolution in the Route Planner

When the route planner shows "Lahore Dryport → Karachi Port", the path passes through dozens of road intersections. Display the route as:

```
Lahore Dryport
  ↓  2.1 km  road_access
Near Lahore (M-2 Interchange)
  ↓  387 km  motorway (M-2)  ← MEDIUM risk
Near Gojra (M-3 Junction)
  ↓  ...
Near Multan (N-5 / N-55 Junction)
  ↓  465 km  trunk road (N-55)  ← HIGH risk ⚠
Near Hyderabad (M-9 Interchange)
  ↓  136 km  motorway (M-9)  ← CRITICAL risk 🔴
Karachi Port Access Road
  ↓  3.5 km  road_access
Karachi Port
```

Only show 4–6 "waypoints" (the major mode changes and risk tier changes). Do not list all 200+ intermediate road intersections.

---

## Real Data Context (From Your Current System)

Before designing each page, these are the actual numbers your UI must handle correctly:

| Metric | Value | UI implication |
|--------|-------|----------------|
| Total nodes | 12,570 | Never load all at once — always filter |
| Total edges | 14,122 | Paginate: 2,000 per batch, 8 batches |
| Facilities | 42 (3 ports + 9 dryports + 30 stations) | Always load fully — these are the important ones |
| Corridors | 861 | C(42,2) — all facility pairs |
| CRITICAL nodes | 240 | Show prominently — this is the alert |
| HIGH nodes | 2,677 | Show in risk bars |
| MEDIUM nodes | 3,662 | |
| LOW nodes | 5,991 | |
| Flood triggered | 919 nodes | Map hotspot layer |
| Flood max score | 88% | Show on hazard card |
| Avg travel time | 8.5 hours | Network health stat |
| Total length | ~40,000 km | Network health stat |

**Current hazard state: FLOOD CRITICAL.** Your UI must make this immediately obvious on first load. A user opening the dashboard right now should see "🌊 Flood CRITICAL — 919 nodes triggered" within 2 seconds, not buried in a sidebar.

---

## Information Architecture (Final)

```
Pakistan TradeLink
│
├── /  (Landing)
│   Purpose: System health at a glance + entry point
│   Primary audience: Investors, managers, first-time visitors
│
├── /map  (Risk Network Map)   ← PRIMARY TOOL
│   Purpose: See every node/edge, current risk, who is affected
│   Primary audience: Operations managers, logistics planners
│
├── /routes  (Route Planner)
│   Purpose: Find a safe route between two facilities right now
│   Primary audience: Truckers, freight forwarders
│
├── /scenario  (Scenario Simulator)
│   Purpose: "What if Karachi Port closes?" impact analysis
│   Primary audience: Risk managers, investors
│
└── /asset/:id  (Asset Profile)
    Purpose: Deep dive on one facility
    Primary audience: Port operators, supply chain analysts
```

---

## Phase 0 — Foundation (Day 1, Morning)

Non-negotiable before anything else.

### 0.1 Design Tokens

```js
// src/styles/tokens.js — single source of truth for all colors

export const TIER_COLOR = {
  CRITICAL: '#E24B4A',
  HIGH:     '#EF9F27',
  MEDIUM:   '#EAB308',
  LOW:      '#22C55E',
  NONE:     '#6B7280',
};

export const TIER_BG = {
  CRITICAL: '#E24B4A22',
  HIGH:     '#EF9F2722',
  MEDIUM:   '#EAB30822',
  LOW:      '#22C55E22',
};

export const NODE_COLOR = {
  port:             '#D85A30',
  dryport:          '#534AB7',
  station:          '#1D9E75',
  rail_station:     '#1D9E75',
  road_intersection:'#64748B',
  rail_intersection:'#64748B',
};

export const EDGE_COLOR = {
  motorway: '#D85A30',
  trunk:    '#EF9F27',
  primary:  '#378ADD',
  rail:     '#1D9E75',
  access:   '#94A3B8',
};

// MapLibre GL expression: color by risk_tier property
export const RISK_TIER_EXPR = [
  'match', ['get', 'risk_tier'],
  'CRITICAL', TIER_COLOR.CRITICAL,
  'HIGH',     TIER_COLOR.HIGH,
  'MEDIUM',   TIER_COLOR.MEDIUM,
  'LOW',      TIER_COLOR.LOW,
  TIER_COLOR.NONE
];

// MapLibre GL expression: color by alert_level property (hazard)
export const ALERT_LEVEL_EXPR = [
  'match', ['get', 'alert_level'],
  'CRITICAL', TIER_COLOR.CRITICAL,
  'HIGH',     TIER_COLOR.HIGH,
  'MEDIUM',   TIER_COLOR.MEDIUM,
  'LOW',      TIER_COLOR.LOW,
  TIER_COLOR.NONE
];
```

### 0.2 Shared UI Components

Extract these once. Never duplicate.

```
src/components/ui/
├── TierBadge.jsx      — colored pill for CRITICAL/HIGH/MEDIUM/LOW
├── ScoreBar.jsx       — horizontal progress bar 0–100%
├── NodeTypeBadge.jsx  — "Sea Port" / "Dry Port" / "Rail Station" badge
├── LoadingSpinner.jsx — small inline spinner
└── ErrorBoundary.jsx  — catches map crashes
```

### 0.3 API Health Check

Add to `App.jsx` on mount: call `hazardApi.getPipelineStatus()`. If the response shows `last_run` was more than 2 hours ago, show a global banner: *"⚠ Pipeline data may be stale — last run X hours ago."* This protects users from acting on outdated hazard data.

---

## Phase 1 — Landing Page (Day 1, Afternoon)

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ NAVBAR: Pakistan TradeLink    [Risk Map] [Routes] [Scenarios]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  HERO                          │  LIVE SYSTEM STATUS           │
│  ─────────────────────         │  ────────────────────         │
│  Pakistan TradeLink            │  Pipeline: ● Idle             │
│  Real-time risk intelligence   │  Last run: 21 min ago         │
│  for Pakistan's trade network  │                               │
│                                │  🌊 Flood     CRITICAL        │
│  [Open Risk Map →]             │     ████████████ 88%          │
│  [Plan a Route →]              │     919 nodes triggered       │
│                                │                               │
│                                │  🌀 Cyclone   OK              │
│                                │  🚫 Strike    OK              │
│                                │  ⚠️ Accident  OK              │
├────────────────────────────────┴─────────────────────────────  │
│                                                                 │
│  🔴 CRITICAL ALERT TICKER (only shown when CRITICAL > 0)        │
│  ← scrolling: "240 CRITICAL nodes · Flood 88% · 919 triggered →"│
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  NETWORK AT A GLANCE                                            │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │12,570  │ │14,122  │ │40K km  │ │ 42     │ │ 861    │       │
│  │Nodes   │ │Edges   │ │Length  │ │Facilit.│ │Corridor│       │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘       │
├─────────────────────────────────────────────────────────────────┤
│  RISK DISTRIBUTION (from live risk_engine data)                 │
│  CRITICAL ████ 240   HIGH ████████████ 2,677                   │
│  MEDIUM  ████████████████ 3,662   LOW ██████████████████ 5,991 │
├─────────────────────────────────────────────────────────────────┤
│  THREE TOOLS                                                    │
│  [🗺 Risk Network Map] [🛣 Route Planner] [⚠ Scenario Sim]      │
│   See all nodes/edges   Find safe route  Test disruptions       │
└─────────────────────────────────────────────────────────────────┘
```

### Critical alert ticker

Show only when `hazSum.alert_counts.CRITICAL > 0`. Use CSS `marquee` behavior via animation:

```
🔴 FLOOD CRITICAL · 919 nodes triggered · 88% max intensity · 240 nodes at CRITICAL risk tier
```

This is visible before the user scrolls at all.

### Data queries for Landing

```js
riskApi.getDistribution()      // risk bars: 240 CRITICAL / 2677 HIGH / etc.
hazardApi.getSummary()         // hazard cards: flood CRITICAL 919 triggered
networkApi.getMetrics()        // 12,570 nodes / 14,122 edges / 40K km
hazardApi.getPipelineStatus()  // last run time
```

All four queries, nothing more. Page loads fast.

---

## Phase 2 — Risk Network Map (Days 2–4, Core Work)

### 2.1 Page Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ TOPBAR (52px, always visible)                                       │
│ Title + pipeline status                                             │
│ [Risk|Hazard|Network] color mode    [Roads][Rail][Facilities][Hotsp]│
│ [History ⏱]   [▶ Run Now]  [↻]                                     │
├──────────────────────────────────────────┬──────────────────────────┤
│                                          │  RIGHT PANEL             │
│  MAP (fills remaining height)            │  (360px, scrollable)     │
│                                          │                          │
│  ← MapLibre GL canvas                    │  Default: KPI Panel      │
│                                          │                          │
│  Legend (bottom-left, 120px)             │  On facility click:      │
│                                          │  → Node Detail panel     │
│  Edge tooltip (top-left, appears on      │                          │
│  edge click, auto-dismisses 6s)          │  On chokepoint click:    │
│                                          │  → flies map + detail    │
│  Network loading progress bar            │                          │
│  (bottom-left, during initial load)      │                          │
├──────────────────────────────────────────┴──────────────────────────┤
│  TIME SLIDER (56px, only visible in History mode)                   │
│  ← ──────────────────────────────────── →  [timestamp]  [12/48]   │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 What the Map Shows

**Always loaded (non-toggleable):**
- Pakistan boundary stroke
- Facility nodes (42: ports + dryports + stations) — always visible, colored by current risk tier
- These are the named, important nodes users care about

**Toggleable layers:**
- **Roads** — 14,122 road edges, paginated, colored by risk tier
- **Rail** — 36 rail lines, colored by risk tier
- **Hotspots** — CRITICAL + HIGH risk intersection nodes (non-facility)
- **Facilities** label toggle — show/hide text labels on facility nodes

**History overlay (only in History mode):**
- Nodes from a past timestamp, colored by `alert_level` at that time

### 2.3 Loading Strategy for 14,122 Edges

Loading all road edges at once would freeze the browser. Use this approach:

```
Step 1: Load facility nodes (42 records) — instant
Step 2: Load rail edges (36 records) — instant
Step 3: Load road edges page 1 (0–2000) — show these immediately
Step 4: Load road edges page 2 (2000–4000) — append to map source
Step 5: Continue until pagination says no more records
Step 6: Show "loading" progress bar: "Loading roads… 4,000 / 14,122"
```

The map is usable from step 1. Roads progressively fill in. User is not blocked.

### 2.4 The Live Hazard Connection

**This is the key difference from a static map.** Every 30 minutes, the hazard pipeline runs and updates `hazard_nodes_latest`. Every 60 minutes, the risk engine updates `risk_nodes_latest`.

The frontend must reflect this:

```js
// Facility nodes and hotspots requery every 2 minutes
useQuery(['combined-facilities'], () => combinedApi.getNodes({type: 'port,dryport,station'}), 
         { refetchInterval: 120_000 })

// KPI panel requeries every 30 seconds
useQuery(['hazard-summary'], () => hazardApi.getSummary(), 
         { refetchInterval: 30_000 })

// When new data arrives, map colors update automatically via useEffect
useEffect(() => {
  if (!facilityNodes || !ready) return;
  mapRef.current.getSource('facilities').setData(facilityNodes);
}, [facilityNodes, ready]);
```

When the flood pipeline runs and 919 nodes get triggered, within 2 minutes the map re-colors those nodes CRITICAL, the KPI panel updates the counts, and the alert ticker re-appears if it was dismissed.

### 2.5 Color Mode Switching

Three modes toggled from topbar. Never rebuild layers — update paint properties live:

**Risk mode** (default): `risk_tier` column → TIER_COLOR map expression
- Shows: "Which assets are statistically most at risk?"
- Use: Daily operations review, investor briefings

**Hazard mode**: `alert_level` column → TIER_COLOR map expression
- Shows: "What is actively happening right now?"
- Use: Emergency response, trucker routing decisions
- **Note:** In flood CRITICAL state, hazard mode shows 919 bright-red nodes vs risk mode which distributes based on H×E×V formula

**Network mode**: `node_type` / `road_type` → NODE_COLOR / EDGE_COLOR map expression
- Shows: Physical infrastructure without any risk coloring
- Use: Understanding the network structure, identifying rail vs road

```js
// Switching modes — correct approach
const applyColorMode = (mode) => {
  const edgeExpr = mode === 'risk'    ? RISK_TIER_EXPR    :
                   mode === 'hazard'  ? ALERT_LEVEL_EXPR  : ROAD_TYPE_EXPR;
  const nodeExpr = mode === 'risk'    ? RISK_TIER_EXPR    :
                   mode === 'hazard'  ? ALERT_LEVEL_EXPR  : NODE_TYPE_EXPR;

  ['roads-layer', 'rail-layer'].forEach(id => {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', edgeExpr);
  });
  ['fac-circle', 'hotspots-layer'].forEach(id => {
    if (map.getLayer(id)) map.setPaintProperty(id, 'circle-color', nodeExpr);
  });
};
```

### 2.6 KPI Panel — Four Sections

**Section 1: Network Health** (static, 5-min stale)
```
12,570  |  14,122  |  40K km  |  8.5h   |  42     |  861
Nodes      Edges      Length    Avg Time  Facilities  Corridors
```

**Section 2: Risk Distribution** (2-min refresh)
Horizontal bars, counts from your confirmed data:
```
Nodes (12,570 total)
CRITICAL  ████  240
HIGH      ████████████  2,677
MEDIUM    ████████████████  3,662
LOW       ██████████████████████  5,991

[3 chokepoints identified] — orange banner if chokepoints > 0
```

**Section 3: Active Hazards** (30-sec refresh)
Four cards using confirmed data:
```
🌊 Flood    [CRITICAL]     🌀 Cyclone  [OK]
  Triggered: 919             Triggered: 0
  Max score: ████████ 88%    Max score: 0%

🚫 Strike   [OK]           ⚠️ Accident [OK]
  Triggered: 0               Triggered: 0
  Max score: 0%              Max score: 0%
```

Alert level counts: `240 CRITICAL  2,677 HIGH  3,662 MEDIUM  5,991 LOW`

**Section 4: Top Chokepoints** (2-min refresh)
List of top 10 from `riskApi.getChokepoints(10)`. Each row shows:
- Rank number, risk tier dot, `display_name` (resolved name), type, tier badge
- Click → map flies to asset + opens Node Detail

### 2.7 Node Detail Panel (replaces KPI panel on click)

Shows when a facility node is clicked. Uses resolved `display_name`.

```
┌────────────────────────────────────────────┐
│ Karachi Port                          [×]  │
│ Sea Port  ·  [CRITICAL]  ·  ⭐ Chokepoint  │
├────────────────────────────────────────────┤
│ RISK                    HAZARD             │
│ Composite: 84%          Flood:  ████ 88%   │
│ Network:   72%          Cyclone:     0%    │
│ Tier: [CRITICAL]        Strike:     0%     │
│                         Accident:   0%     │
├────────────────────────────────────────────┤
│ NETWORK METRICS                            │
│ Betweenness  0.2541     Importance   5/5   │
│ Degree       0.0812     Capacity     5/5   │
│ Closeness    0.3012     Redundancy   3/3   │
├────────────────────────────────────────────┤
│ [View Full Profile]                        │
│ [Plan Route From Here]                     │
│ [Simulate Closure]                         │
└────────────────────────────────────────────┘
```

### 2.8 History Time Slider

The hazard pipeline appends to `hazard_nodes_log` every 30 minutes. Over 24 hours, that is 48 snapshots. Over a week, 336.

The time slider lets users replay the flood event progression:

```
⏱ HISTORY MODE ACTIVE
← ─────────────●────────────── →
   2026-04-20 06:00           (12 / 48)    [Loading…]
```

Dragging to a past timestamp:
1. Calls `historyApi.getNodes('20260420_0600')`
2. Shows returned nodes as overlay layer, colored by that moment's `alert_level`
3. Non-overlay layers remain visible (roads, rail, facility circles) for context

This lets a trucker see: *"Yesterday at 6am the flood was smaller. By 2pm it had spread to 600+ nodes. Now at 919 it's at peak."*

---

## Phase 3 — Route Planner with Live Risk (Day 5)

### 3.1 The Core Flow

```
User picks:  Origin    →  Destination  →  [Find Routes]
             [dropdown]   [dropdown]
             Shows: display_name of each facility
             
Map shows the route as colored segments by risk tier
Results panel shows 3 options side by side
```

### 3.2 Facility Dropdown

Both origin and destination dropdowns must show `display_name` not `asset_id`:

```js
// Load all 42 facilities for dropdowns
const { data: facilities } = useQuery(['facilities-list'],
  () => combinedApi.getNodes({ type: 'port,dryport,station' })
);

// In dropdown:
facilities?.features.map(f => ({
  value: f.properties.asset_id,   // "dryport_5"
  label: f.properties.display_name // "Lahore Dryport"
}))
```

Pre-fill from URL param: `/routes?from=dryport_5` → "Lahore Dryport" pre-selected.

### 3.3 Route Results Panel

Three routes returned by the API (fastest / safest / balanced). Show comparison table:

```
┌──────────────────────────────────────────────────────────┐
│  Lahore Dryport → Karachi Port                           │
│  3 routes found · Current hazard: FLOOD CRITICAL         │
├────────────────┬───────────────┬──────────────────────── │
│                │ ⚡ Fastest    │ 🛡 Safest   │ ⚖ Balanced│
├────────────────┼───────────────┼─────────────┼───────────┤
│ Travel time    │ 10.7h         │ 14.2h       │ 12.1h     │
│ Distance       │ 1,187 km      │ 1,420 km    │ 1,290 km  │
│ Max risk       │ [CRITICAL]    │ [LOW]       │ [MEDIUM]  │
│ Avg risk score │ 0.72          │ 0.19        │ 0.38      │
│ Mode           │ Road          │ Road+Rail   │ Road      │
├────────────────┴───────────────┴─────────────┴───────────┤
│  [Select Fastest]    [Select Safest ✓]   [Select Balanced]│
└──────────────────────────────────────────────────────────┘
```

**Right now, with flood CRITICAL, the safest route takes 3.5 more hours but avoids 700 km of HIGH/CRITICAL risk roads.** This difference is exactly what a trucker needs to see.

### 3.4 Route Risk Segment Display

When a route is selected, the map shows it as colored line segments:

```
Lahore Dryport ──── [LOW: 387km M-2] ──── [MEDIUM: 165km N-5] ──── [CRITICAL: 136km M-9] ──── Karachi Port
                     green                  yellow                    red
```

Each color change is a segment break where the risk tier changes. A legend below the map explains the colors.

### 3.5 Waypoint Display Using Resolved Names

Route detail panel shows key waypoints using the name resolution system:

```
Route via M-2 / N-5 / M-9 (Fastest)

START   Lahore Dryport
  ↓  2.1km  access road  [LOW]
        Near Lahore — M-2 Interchange
  ↓  387km  motorway (M-2)  [LOW]
        Near Multan — N-5 Junction
  ↓  465km  trunk road (N-5)  ← ⚠ MEDIUM RISK
        Near Hyderabad — M-9 Interchange
  ↓  136km  motorway (M-9)  ← 🔴 CRITICAL RISK (flood)
        Karachi Port Access
  ↓  3.5km  access road  [LOW]
END     Karachi Port

⚠ WARNING: Final 136km (M-9) is in CRITICAL flood zone.
  Consider: Route via Rail adds 3.5 hours but avoids flooded corridor.
```

This is actionable intelligence. The trucker knows exactly where the risk is and how to avoid it.

---

## Phase 4 — Scenario Simulator (Day 6, Morning)

### 4.1 Purpose

"What if Karachi Port closes today — given the current flood situation?"

The scenario engine uses `scenario_engine.pkl` (from risk_engine.py) to simulate network disruptions.

### 4.2 Layout

```
┌─────────────────────────────────────────────────────────┐
│ HEADER (floating, 52px)                                 │
│ "Scenario Simulator"  [2 targets selected]  [Hide Panel]│
├─────────────────────────────────────────┬───────────────┤
│                                         │               │
│  FULL-SCREEN MAP                        │ CONTROL PANEL  │
│  (dark theme)                           │ (320px)        │
│                                         │                │
│  Click facilities → add as targets      │ Targets list   │
│  Red = selected target                  │ Scenario type  │
│  Amber = affected corridor asset        │ Severity       │
│                                         │ Duration       │
│                                         │ [▶ Run]        │
│                                         │                │
│                                         │ Results panel  │
└─────────────────────────────────────────┴───────────────┘
```

### 4.3 Scenario Types with Clear Descriptions

```
🚫 Node Closure
   "Completely removes this facility from the network.
    Simulates: port shutdown, dryport closure, station blockade."

🚧 Road/Rail Closure
   "Blocks a specific edge. Routes must detour.
    Simulates: road washout, bridge closure, track blockage."

📉 Capacity Reduction
   "Reduces throughput to X%. Paths still exist but take longer.
    Simulates: flood congestion, partial strike, maintenance."

🌊 Flood Scenario
   "Applies flood hazard weights from current model at given severity.
    Simulates: escalating flood affecting all exposed nodes."

🌀 Cyclone Scenario
   "Applies cyclone disruption to coastal facilities.
    Simulates: Category 2 / 3 / 4 landfall near Karachi."

🛑 Strike Scenario
   "Shuts down selected facilities' operations.
    Simulates: dock worker action, transport dharna."

⚠️ Accident Scenario
   "Degrades selected edges based on accident risk model.
    Simulates: M-9 pile-up, ML-1 derailment."
```

### 4.4 Results Panel

After running a scenario:

```
┌─────────────────────────────────────────────────────┐
│ SCENARIO RESULTS                                    │
│ Karachi Port Closure · Severity 100% · 24 hours    │
├─────────────────────────────────────────────────────┤
│  Trade routes affected: 38                          │
│  Unreachable pairs:     12  ← 12 corridors lost    │
│  Avg delay:            +340%                        │
│  Est. economic impact: $4.2M / day                 │
├─────────────────────────────────────────────────────┤
│ MOST AFFECTED ROUTES                               │
│  Lahore Dryport → Karachi Port    NO ALTERNATIVE   │
│  ISB Dryport → Karachi Port       +520% delay      │
│  Gwadar → Lahore Dryport          +180% delay      │
│  ... (scroll for more)                             │
└─────────────────────────────────────────────────────┘
```

---

## Phase 5 — Asset Profile Cleanup (Day 6, Afternoon)

### 5.1 Header with Real Name

```
┌──────────────────────────────────────────────────────────────┐
│ ← Back to Risk Map                                           │
│                                                              │
│  Karachi Port                     [Plan Route] [Simulate]   │
│  Sea Port  ·  [CRITICAL]  ·  ⭐ Chokepoint                  │
│  Coordinates: 24.86°N 67.01°E  ·  asset_id: port_1         │
└──────────────────────────────────────────────────────────────┘
```

**Always show `asset_id` in small text.** This helps developers and operations staff cross-reference with DB records.

### 5.2 Content Sections

**Row 1 (full width):** 6 network metric cards — betweenness, closeness, degree, importance, capacity, redundancy

**Row 2 (3 columns):**
- Left: MapLibre mini-map centered on asset (zoom 9, non-interactive)
- Right: Centrality radar chart (betweenness / closeness / degree / importance / capacity)

**Row 3 (3 columns):**
- Hazard scores: flood / cyclone / strike / accident bars + composite
- Risk scores: flood / cyclone / strike / accident + composite + network criticality tier
- Hazard history chart (from `hazard_nodes_log` timestamps)

**Empty state for history chart:**
```
If timestamps < 2:
  "Run hazard_model.py at least twice to see history."
  Shows single current score as large stat card instead.
```

**Row 4 (full width):** Reachability to other facilities

Filter to show only facility-to-facility paths. Headers: Destination / Type / Travel Time / Distance / Risk Score.

```
Destination          Type        Time    Distance  Risk
──────────────────── ─────────── ─────── ───────── ──────
Port Qasim           Sea Port    0.5h    22 km     LOW
Karachi Dryport      Dry Port    1.2h    48 km     MEDIUM ⚠
Hyderabad Dryport    Dry Port    2.1h    165 km    HIGH  ⚠
Gwadar Port          Sea Port    8.3h    570 km    LOW
Lahore Dryport       Dry Port    10.7h   1,187 km  CRITICAL 🔴
...
```

---

## Phase 6 — Navigation & Global Polish (Day 7)

### 6.1 Navbar

```
Pakistan TradeLink    [Risk Map]  [Routes]  [Scenarios]
```

Three links only. Asset Profile and Landing are accessed from within the tool, not the navbar.

On full-screen pages (`/map`, `/routes`, `/scenario`): navbar hides. A small floating header strip shows only the page title and a "←" back-to-home link.

### 6.2 Pipeline Status Badge

Show in the Risk Map topbar at all times:

```
● Idle   Last run: 21 min ago      or      ● Running...
```

When `pipelineStatus.running === true`, show spinning indicator and disable "Run Now" button.

If last run was more than 90 minutes ago: show amber warning badge — the system may not be reflecting current conditions.

### 6.3 Loading States

**Page-level:** Skeleton content while initial data loads (not blank white page)

**Map-level:** Progress bar while edge batches load:
```
Loading roads…  ████████░░░░░░░  4,000 / 14,122
```

**API errors:** Toast notification via `react-hot-toast`:
```
⚠ Could not load hazard data — retrying...   [×]
```

### 6.4 Error Boundaries

Wrap every page and the MapLibre canvas:

```jsx
<ErrorBoundary>
  <RiskNetworkMap ... />
</ErrorBoundary>
```

MapLibre GL can throw if WebGL is unavailable (older devices, certain browsers). The error boundary catches this and shows: "Map requires WebGL. Please use Chrome, Firefox, or Safari on a modern device."

---

## File Structure (After Full Rewrite)

```
frontend/src/
│
├── api/
│   ├── networkApi.js           ← unchanged, all endpoints
│   └── index.js                ← NEW: re-exports all API modules
│
├── styles/
│   └── tokens.js               ← NEW: all colors, all expressions
│
├── utils/
│   ├── nearestCity.js          ← NEW: node name resolution
│   └── formatters.js           ← NEW: travel time / distance formatting
│
├── components/
│   ├── ErrorBoundary.jsx       ← NEW
│   ├── ui/
│   │   ├── TierBadge.jsx       ← NEW
│   │   ├── ScoreBar.jsx        ← NEW
│   │   ├── NodeTypeBadge.jsx   ← NEW
│   │   └── LoadingSpinner.jsx  ← NEW
│   ├── map/
│   │   ├── RiskNetworkMap.jsx  ← extracted from Dashboard.jsx
│   │   ├── ScenarioMap.jsx     ← extracted from ScenarioSimulator.jsx
│   │   └── RouteVisualizationMap.jsx  ← keep existing
│   └── panels/
│       ├── KpiPanel.jsx        ← extracted from Dashboard.jsx
│       ├── NodeDetail.jsx      ← extracted from Dashboard.jsx
│       └── EdgeTooltip.jsx     ← extracted from Dashboard.jsx
│
├── pages/
│   ├── Landing.jsx             ← rewrite (Phase 1)
│   ├── Dashboard.jsx           ← rewrite (Phase 2, becomes /map)
│   ├── RoutePlanner.jsx        ← polish (Phase 3)
│   ├── ScenarioSimulator.jsx   ← polish (Phase 4)
│   └── AssetProfile.jsx        ← cleanup (Phase 5)
│
└── App.jsx                     ← update routes + nav (Phase 6)
```

---

## Priority Order & Timeline

| Phase | Page / Task | Days | What users gain |
|-------|-------------|------|-----------------|
| **0** | Tokens + shared UI + API health check | 0.5 | No more mismatched colors; API errors visible |
| **2** | Risk Network Map | 3.0 | Full live map with hazard coloring, node details, history slider |
| **1** | Landing page | 0.5 | Investors see system health in 2 seconds |
| **3** | Route Planner | 1.0 | Truckers get risk-aware routing with resolved place names |
| **6** | Navigation + polish | 0.5 | Clean UX flow between tools |
| **4** | Scenario Simulator | 0.5 | Meaningful scenario results with affected map |
| **5** | Asset Profile | 0.5 | Complete per-facility intelligence |

**Total: 6.5 working days for a solo developer.**

---

## What NOT to Build Yet (Scope Guard)

These are explicitly deferred. Do not start any of these until all 7 phases above are stable:

- LLM chatbot interface
- AIS vessel positions and port stress index
- 3D extruded layers (deck.gl ColumnLayer for TEU bars)
- Monte Carlo histogram chart
- Cascade failure animation
- PDF / PNG map export
- WebSocket live push (polling every 30s is sufficient)
- Mobile-responsive layout (desktop-first for FYP demo)

---

## Quick Wins (Do Today, Under 1 Hour Each)

1. **Show the flood CRITICAL state on the landing page** — hard to miss, shows the platform is live
2. **Fix chokepoint click in KPI panel** — it should fly the map to the asset (currently just updates panel)
3. **Set `refetchInterval: 30_000` on `hazardApi.getSummary()`** — ensures KPI cards reflect latest pipeline run
4. **Add `display_name` fallback** — if `display_name` is null, show `name`; if that's null, show `asset_id`
5. **Hide intermodal edges by default** — reduces visual noise; let users turn them on if needed

---

*Pakistan TradeLink · Frontend Rewrite Plan v2.0 · April 2026*
*Data confirmed: 12,570 nodes · 14,122 edges · 240 CRITICAL · Flood CRITICAL 88% · 919 triggered*