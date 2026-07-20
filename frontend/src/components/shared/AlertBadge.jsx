import { alertLevelColor } from '../../utils/colors';

export const AlertBadge = ({ level }) => {
  const color = alertLevelColor(level);
  return (
    <span
      style={{ backgroundColor: color }}
      className="px-2 py-1 text-xs font-bold text-white rounded"
    >
      {level}
    </span>
  );
};
