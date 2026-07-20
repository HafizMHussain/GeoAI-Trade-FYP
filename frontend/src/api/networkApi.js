import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

const client = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// ── Network (topology) ───────────────────────────────────────────────────────
export const networkApi = {
  getMetrics: () => client.get('/network/metrics/'),
  getNodes: (params) => client.get('/network/nodes/', { params }),
  getEdges: (params) => client.get('/network/edges/', { params }),
  getCriticality: () => client.get('/network/criticality/'),
  getCorridorTimes: () => client.get('/network/corridor-times/'),
  getShortestPath: (from, to) => client.get('/network/shortest-path/', { params: { from, to } }),
  getAlternateRoutes: (from, to) => client.get('/network/alternate-routes/', { params: { from, to } }),
  getAdvancedRoutes: (from, to, mode = 'any', options = {}) =>
    client.get('/network/advanced-routes/', {
      params: { from, to, mode, hazard_weight: options.hazardWeight, risk_weight: options.riskWeight },
    }),
  getDisruptionImpact: (assetId, assetType = 'node') =>
    client.get('/network/disruption-impact/', { params: { asset_id: assetId, asset_type: assetType } }),
  getPakistanBoundary: () => client.get('/network/pakistan-boundary/'),
  getRailConnectivity: () => client.get('/network/rail-connectivity/'),
};

// ── Combined (network + hazard + risk joined) ────────────────────────────────
export const combinedApi = {
  getNodes: (params) => client.get('/nodes/combined/', { params }),
  getEdges: (params) => client.get('/edges/combined/', { params }),
};

// ── Hazard ───────────────────────────────────────────────────────────────────
export const hazardApi = {
  getSummary: () => client.get('/hazard/summary/'),
  getAlerts: (limit = 200) => client.get('/hazard/alerts/', { params: { limit } }),
  getNodesGeoJSON: (params) => client.get('/hazard/nodes/', { params }),
  getEdgesGeoJSON: (params) => client.get('/hazard/edges/', { params }),
  getKpiHistory: (limit = 96) => client.get('/hazard/kpi-history/', { params: { limit } }),
  runPipeline: () => client.post('/hazard/run/'),
  getPipelineStatus: () => client.get('/hazard/run/'),
};

// ── Risk ─────────────────────────────────────────────────────────────────────
export const riskApi = {
  getNodesGeoJSON: (params) => client.get('/risk/nodes/', { params }),
  getEdgesGeoJSON: (params) => client.get('/risk/edges/', { params }),
  getSummary: () => client.get('/risk/summary/'),
  getDistribution: () => client.get('/risk/distribution/'),
  getChokepoints: (limit = 10) => client.get('/risk/chokepoints/', { params: { limit } }),
  getKpiHistory: (limit = 96) => client.get('/risk/kpi-history/', { params: { limit } }),
};

// ── Assets (facilities) ───────────────────────────────────────────────────────
export const assetApi = {
  getList: () => client.get('/assets/'),
  getDetail: (assetId) => client.get(`/assets/${assetId}/`),
  getReachability: (assetId) => client.get(`/assets/${assetId}/reachability/`),
};

// ── KPIs ──────────────────────────────────────────────────────────────────────
export const kpiApi = {
  getLatest: () => client.get('/kpis/latest/'),
  getHistory: (limit = 96) => client.get('/kpis/history/', { params: { limit } }),
};

// ── History / time-slider ────────────────────────────────────────────────────
export const historyApi = {
  getTimestamps: () => client.get('/history/timestamps/'),
  getNodes: (timestamp) => client.get('/history/nodes/', { params: { timestamp } }),
  getEdges: (timestamp) => client.get('/history/edges/', { params: { timestamp } }),
};

// ── Scenario ──────────────────────────────────────────────────────────────────
export const scenarioApi = {
  run: (payload) => client.post('/scenario/run/', payload),
  // Pipeline offline analysis data (from scenario_simulation.py)
  getPipelineResults: () => client.get('/scenario/pipeline-results/'),
  getCorridors: () => client.get('/scenario/corridors/'),
  getMonteCarlo: () => client.get('/scenario/montecarlo/'),
  getRecovery: () => client.get('/scenario/recovery/'),
  getEconomic: () => client.get('/scenario/economic/'),
};

// ── AI Chat ───────────────────────────────────────────────────────────────────
export const chatApi = {
  send: (message, history = []) =>
    client.post('/chat/', { message, history }),
};

export default client;
