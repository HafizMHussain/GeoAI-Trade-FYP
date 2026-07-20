import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8000;

// ── Mock Data Generation ───────────────────────────────────────────────

const nodes = [
  { properties: { asset_id: 'node_khi_port', name: 'Karachi Seaport', node_type: 'port', composite_risk: 0.1, risk_tier: 'LOW', importance_index: 5, handling_capacity_index: 5, hazard_flood: 0.05, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [66.975, 24.83] } },
  { properties: { asset_id: 'node_hyd', name: 'Hyderabad Junction', node_type: 'road_intersection', composite_risk: 0.2, risk_tier: 'LOW', importance_index: 4, handling_capacity_index: 4, hazard_flood: 0.1, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [68.36, 25.39] } },
  
  // PRIMARY ROUTE (N-5) - AFFECTED BY FLOOD
  { properties: { asset_id: 'node_sukkur', name: 'Sukkur Logistics Hub', node_type: 'dryport', composite_risk: 0.95, risk_tier: 'CRITICAL', alert_level: 'CRITICAL', importance_index: 5, handling_capacity_index: 4, hazard_flood: 0.98, is_chokepoint: true, status: 'CRITICAL' }, geometry: { type: 'Point', coordinates: [68.85, 27.70] } },
  { properties: { asset_id: 'node_multan', name: 'Multan Dryport', node_type: 'dryport', composite_risk: 0.4, risk_tier: 'MEDIUM', importance_index: 4, handling_capacity_index: 4, hazard_flood: 0.3, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [71.43, 30.19] } },

  // ALTERNATIVE ROUTE (N-55) - SAFE
  { properties: { asset_id: 'node_dadu', name: 'Dadu Checkpoint', node_type: 'road_intersection', composite_risk: 0.15, risk_tier: 'LOW', importance_index: 2, handling_capacity_index: 2, hazard_flood: 0.05, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [67.77, 26.73] } },
  { properties: { asset_id: 'node_larkana', name: 'Larkana Depot', node_type: 'station', composite_risk: 0.18, risk_tier: 'LOW', importance_index: 3, handling_capacity_index: 3, hazard_flood: 0.08, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [68.21, 27.55] } },
  { properties: { asset_id: 'node_dgkhan', name: 'D.G. Khan Transit', node_type: 'road_intersection', composite_risk: 0.12, risk_tier: 'LOW', importance_index: 3, handling_capacity_index: 2, hazard_flood: 0.04, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [70.63, 30.05] } },

  // DESTINATIONS
  { properties: { asset_id: 'node_lahore', name: 'Lahore Dryport', node_type: 'dryport', composite_risk: 0.1, risk_tier: 'LOW', importance_index: 5, handling_capacity_index: 5, hazard_flood: 0.05, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [74.35, 31.52] } },
  { properties: { asset_id: 'node_isb', name: 'Islamabad Terminal', node_type: 'dryport', composite_risk: 0.05, risk_tier: 'LOW', importance_index: 5, handling_capacity_index: 4, hazard_flood: 0.02, is_chokepoint: false }, geometry: { type: 'Point', coordinates: [73.04, 33.68] } },
];

const edges = [
  // Primary (N-5)
  { properties: { asset_id: 'edge_khi_hyd', mode: 'road', road_type: 'motorway', composite_risk: 0.1, risk_tier: 'LOW', travel_time_hr: 2.0, length_km: 160 }, geometry: { type: 'LineString', coordinates: [[66.975, 24.83], [68.36, 25.39]] } },
  { properties: { asset_id: 'edge_hyd_suk', mode: 'road', road_type: 'trunk', composite_risk: 0.98, risk_tier: 'CRITICAL', alert_level: 'CRITICAL', hazard_flood: 0.99, travel_time_hr: 3.5, length_km: 320 }, geometry: { type: 'LineString', coordinates: [[68.36, 25.39], [68.85, 27.70]] } },
  { properties: { asset_id: 'edge_suk_mul', mode: 'road', road_type: 'trunk', composite_risk: 0.85, risk_tier: 'HIGH', hazard_flood: 0.8, travel_time_hr: 4.5, length_km: 410 }, geometry: { type: 'LineString', coordinates: [[68.85, 27.70], [71.43, 30.19]] } },
  { properties: { asset_id: 'edge_mul_lhr', mode: 'road', road_type: 'motorway', composite_risk: 0.2, risk_tier: 'LOW', travel_time_hr: 3.5, length_km: 340 }, geometry: { type: 'LineString', coordinates: [[71.43, 30.19], [74.35, 31.52]] } },

  // Secondary (N-55)
  { properties: { asset_id: 'edge_hyd_dad', mode: 'road', road_type: 'primary', composite_risk: 0.1, risk_tier: 'LOW', travel_time_hr: 2.0, length_km: 150 }, geometry: { type: 'LineString', coordinates: [[68.36, 25.39], [67.77, 26.73]] } },
  { properties: { asset_id: 'edge_dad_lar', mode: 'road', road_type: 'primary', composite_risk: 0.1, risk_tier: 'LOW', travel_time_hr: 1.5, length_km: 110 }, geometry: { type: 'LineString', coordinates: [[67.77, 26.73], [68.21, 27.55]] } },
  { properties: { asset_id: 'edge_lar_dgk', mode: 'road', road_type: 'primary', composite_risk: 0.15, risk_tier: 'LOW', travel_time_hr: 4.5, length_km: 380 }, geometry: { type: 'LineString', coordinates: [[68.21, 27.55], [70.63, 30.05]] } },
  { properties: { asset_id: 'edge_dgk_mul', mode: 'road', road_type: 'primary', composite_risk: 0.2, risk_tier: 'LOW', travel_time_hr: 1.2, length_km: 90 }, geometry: { type: 'LineString', coordinates: [[70.63, 30.05], [71.43, 30.19]] } },
];

const mockCombinedNodes = { type: 'FeatureCollection', features: nodes };
const mockCombinedEdges = { type: 'FeatureCollection', features: edges };

const mockMetrics = {
  total_nodes: 9,
  total_edges: 8,
  total_length_km: 1960,
  avg_travel_time_hr: 22.7
};

const mockHazardSummary = {
  alert_counts: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 6 },
  flood: { status: 'CRITICAL', triggered: 1, max_score: 0.98 },
  cyclone: { status: 'OK', triggered: 0, max_score: 0 },
  strike: { status: 'OK', triggered: 0, max_score: 0 },
  accident: { status: 'OK', triggered: 0, max_score: 0 },
  pipeline_status: { running: false, last_run: Date.now() / 1000 - 300 }
};

const mockRiskDistribution = {
  nodes: { critical: 1, high: 0, medium: 1, low: 7, total: 9, chokepoints: 1, max_risk: 0.95, avg_risk: 0.25 },
  edges: { critical: 1, high: 1, medium: 0, low: 6, total: 8 }
};

const mockChokepoints = [
  { asset_id: 'node_sukkur', name: 'Sukkur Logistics Hub', node_type: 'dryport', risk_tier: 'CRITICAL', betweenness_centrality: 0.9, composite_risk: 0.95 }
];

const mockKpiHistory = Array.from({length: 24}).map((_, i) => ({
  timestamp: (Date.now() / 1000) - (i * 15 * 60),
  triggered_nodes: i < 5 ? 1 : 0
}));

// Hardcoded route response showing N-55 being used because N-5 is blocked
const mockAdvancedRoutes = {
  routes: [
    {
      type: 'SAFEST',
      distance_km: 1070,
      travel_time_hr: 14.7,
      segments: { road: { km: 1070 } },
      journey_segments: [
        { from_name: 'Karachi Seaport', to_name: 'Hyderabad Junction', mode: 'road', max_risk_tier: 'LOW', length_km: 160, travel_time_min: 120, from_lon: 66.975, from_lat: 24.83, to_lon: 68.36, to_lat: 25.39 },
        { from_name: 'Hyderabad Junction', to_name: 'Dadu Checkpoint', mode: 'road', max_risk_tier: 'LOW', length_km: 150, travel_time_min: 120, from_lon: 68.36, from_lat: 25.39, to_lon: 67.77, to_lat: 26.73 },
        { from_name: 'Dadu Checkpoint', to_name: 'Larkana Depot', mode: 'road', max_risk_tier: 'LOW', length_km: 110, travel_time_min: 90, from_lon: 67.77, from_lat: 26.73, to_lon: 68.21, to_lat: 27.55 },
        { from_name: 'Larkana Depot', to_name: 'D.G. Khan Transit', mode: 'road', max_risk_tier: 'LOW', length_km: 380, travel_time_min: 270, from_lon: 68.21, from_lat: 27.55, to_lon: 70.63, to_lat: 30.05 },
        { from_name: 'D.G. Khan Transit', to_name: 'Multan Dryport', mode: 'road', max_risk_tier: 'LOW', length_km: 90, travel_time_min: 72, from_lon: 70.63, from_lat: 30.05, to_lon: 71.43, to_lat: 30.19 },
        { from_name: 'Multan Dryport', to_name: 'Lahore Dryport', mode: 'road', max_risk_tier: 'LOW', length_km: 340, travel_time_min: 210, from_lon: 71.43, from_lat: 30.19, to_lon: 74.35, to_lat: 31.52 }
      ]
    }
  ]
};

// ── API Endpoints ──────────────────────────────────────────────────────

app.get('/api/nodes/combined/', (req, res) => res.json(mockCombinedNodes));
app.get('/api/edges/combined/', (req, res) => res.json(mockCombinedEdges));
app.get('/api/network/metrics/', (req, res) => res.json(mockMetrics));
app.get('/api/hazard/summary/', (req, res) => res.json(mockHazardSummary));
app.get('/api/risk/distribution/', (req, res) => res.json(mockRiskDistribution));
app.get('/api/risk/chokepoints/', (req, res) => res.json(mockChokepoints));
app.get('/api/hazard/kpi-history/', (req, res) => res.json(mockKpiHistory));
app.get('/api/network/advanced-routes/', (req, res) => res.json(mockAdvancedRoutes));

app.get('/api/network/disruption-impact/', (req, res) => {
  res.json({
    total_affected: 45,
    top_impacts: [
      { source_name: 'Karachi Seaport', target_name: 'Lahore Dryport', status: 'UNREACHABLE', delay_pct: 0 },
      { source_name: 'Hyderabad Junction', target_name: 'Multan Dryport', status: 'UNREACHABLE', delay_pct: 0 },
      { source_name: 'Karachi Seaport', target_name: 'Islamabad Terminal', status: 'DELAYED', delay_pct: 45 },
    ]
  });
});

app.post('/api/hazard/run/', (req, res) => res.json({ status: 'success', message: 'Mock pipeline triggered' }));
app.get('/api/hazard/run/', (req, res) => res.json({ running: false, last_run: Date.now() / 1000 }));

// Fallback for any other route
app.use((req, res) => {
  res.json({});
});

export default app;

// Only start a listener when run directly (local dev), not when imported
// by a serverless host such as Vercel.
if (process.env.VERCEL === undefined) {
  app.listen(PORT, () => {
    console.log(`\n========================================================`);
    console.log(`🎯 STANDALONE MOCK BACKEND (PORT ${PORT})`);
    console.log(`========================================================`);
    console.log(`Ready for Demo Video!`);
    console.log(`Leave this running and start your frontend normally with:`);
    console.log(`  npm run dev`);
    console.log(`The frontend will automatically talk to this mock server.`);
    console.log(`========================================================\n`);
  });
}
