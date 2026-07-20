export const COLORS = {
  port: '#D85A30',
  dryport: '#534AB7',
  station: '#1D9E75',
  road_motorway: '#D85A30',
  road_trunk: '#EF9F27',
  road_primary: '#378ADD',
  road_other: '#B4B2A9',
  rail: '#1D9E75',
  intermodal: '#7F77DD',
  route_active: '#534AB7',
  disrupted: '#E24B4A',
  alert_critical: '#E24B4A',
  alert_high: '#EF9F27',
  alert_medium: '#BA7517',
  alert_low: '#3B6D11',
  hazard_0: '#B4B2A9',
  hazard_mid: '#EF9F27',
  hazard_max: '#E24B4A',
};

export const nodeTypeColor = (type) => {
  const colorMap = {
    port: [216, 90, 48],
    dryport: [83, 74, 183],
    rail_station: [29, 158, 117],
    road_intersection: [180, 178, 169],
    rail_intersection: [136, 135, 128],
  };
  return colorMap[type] || [180, 178, 169];
};

export const alertLevelColor = (level) => {
  const map = {
    'CRITICAL': COLORS.alert_critical,
    'HIGH': COLORS.alert_high,
    'MEDIUM': COLORS.alert_medium,
    'LOW': COLORS.alert_low,
  };
  return map[level] || COLORS.alert_low;
};

export const roadTypeColor = (type) => {
  const map = {
    'motorway': COLORS.road_motorway,
    'trunk': COLORS.road_trunk,
    'primary': COLORS.road_primary,
    'ml1': COLORS.road_trunk,
    'ml2': COLORS.road_primary,
    'ml3': COLORS.road_primary,
    'connecting': COLORS.road_other,
  };
  return map[type] || COLORS.road_other;
};
