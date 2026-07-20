// Single source of truth for all colors and MapLibre GL expressions

export const TIER_COLOR = {
  CRITICAL: '#E24B4A',
  HIGH:     '#EF9F27',
  MEDIUM:   '#EAB308',
  LOW:      '#22C55E',
  NONE:     '#22C55E', // no data = treat as safe/green
};

export const TIER_BG = {
  CRITICAL: '#E24B4A22',
  HIGH:     '#EF9F2722',
  MEDIUM:   '#EAB30822',
  LOW:      '#22C55E22',
};

export const NODE_COLOR = {
  port:              '#D85A30',
  dryport:           '#534AB7',
  station:           '#1D9E75',
  rail_station:      '#1D9E75',
  road_intersection: '#64748B',
  rail_intersection: '#64748B',
};

export const EDGE_COLOR = {
  motorway:    '#D85A30',
  trunk:       '#EF9F27',
  primary:     '#378ADD',
  rail:        '#1D9E75',
  access_link: '#94A3B8',
};

// MapLibre GL expressions ────────────────────────────────────────────────────

export const RISK_TIER_EXPR = [
  'match', ['get', 'risk_tier'],
  'CRITICAL', TIER_COLOR.CRITICAL,
  'HIGH',     TIER_COLOR.HIGH,
  'MEDIUM',   TIER_COLOR.MEDIUM,
  'LOW',      TIER_COLOR.LOW,
  TIER_COLOR.LOW, // fallback: no tier = green (safe)
];

export const ALERT_LEVEL_EXPR = [
  'match', ['get', 'alert_level'],
  'CRITICAL', TIER_COLOR.CRITICAL,
  'HIGH',     TIER_COLOR.HIGH,
  'MEDIUM',   TIER_COLOR.MEDIUM,
  'LOW',      TIER_COLOR.LOW,
  TIER_COLOR.LOW, // fallback: no alert = green (safe)
];

// Use downcase so 'Trunk', 'trunk', 'TRUNK' all match
export const ROAD_TYPE_EXPR = [
  'match', ['downcase', ['get', 'road_type']],
  'motorway',    EDGE_COLOR.motorway,
  'trunk',       EDGE_COLOR.trunk,
  'primary',     EDGE_COLOR.primary,
  'rail_line',   EDGE_COLOR.rail,
  'access_link', EDGE_COLOR.access_link,
  '#94A3B8',
];

export const NODE_TYPE_EXPR = [
  'match', ['get', 'node_type'],
  'port',             NODE_COLOR.port,
  'dryport',          NODE_COLOR.dryport,
  'station',          NODE_COLOR.station,
  'rail_station',     NODE_COLOR.rail_station,
  NODE_COLOR.road_intersection,
];
