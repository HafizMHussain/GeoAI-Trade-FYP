import { COLORS } from '../../utils/colors';

export const HazardBar = ({ value, label, max = 1 }) => {
  const percentage = (value / max) * 100;
  const color = value < 0.3 ? COLORS.hazard_0 : value < 0.6 ? COLORS.hazard_mid : COLORS.hazard_max;

  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-sm font-medium w-20">{label}</span>
      <div className="flex-1 h-2 bg-gray-200 rounded overflow-hidden">
        <div
          style={{
            width: `${percentage}%`,
            backgroundColor: color,
            height: '100%',
            transition: 'width 0.3s ease'
          }}
        />
      </div>
      <span className="text-sm font-bold w-12">{(value * 100).toFixed(0)}%</span>
    </div>
  );
};
