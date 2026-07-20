import { COLORS } from '../../utils/colors';

export const NodeTypeBadge = ({ type }) => {
  const colorMap = {
    port: COLORS.port,
    dryport: COLORS.dryport,
    station: COLORS.station,
    rail_station: COLORS.station,
  };

  const labelMap = {
    port: 'Port',
    dryport: 'Dryport',
    station: 'Rail Station',
    rail_station: 'Rail Station',
  };

  const color = colorMap[type] || '#999';
  const label = labelMap[type] || type;

  return (
    <span
      style={{ backgroundColor: color }}
      className="px-2 py-1 text-xs font-bold text-white rounded"
    >
      {label}
    </span>
  );
};
