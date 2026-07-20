import { NODE_COLOR } from '../../styles/tokens';

const LABELS = {
  port:              'Sea Port',
  dryport:           'Dry Port',
  station:           'Rail Station',
  rail_station:      'Rail Station',
  road_intersection: 'Road Junction',
  rail_intersection: 'Rail Junction',
};

export default function NodeTypeBadge({ type }) {
  const c = NODE_COLOR[type] || '#6B7280';
  const label = LABELS[type] || (type || '').replace(/_/g, ' ');
  return (
    <span
      className="px-2.5 py-1 rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: c }}
    >
      {label}
    </span>
  );
}
