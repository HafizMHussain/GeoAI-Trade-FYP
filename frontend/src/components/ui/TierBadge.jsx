import { TIER_COLOR } from '../../styles/tokens';

export default function TierBadge({ tier, size = 'sm' }) {
  const c = TIER_COLOR[tier] || '#6B7280';
  const cls = size === 'lg'
    ? 'px-3 py-1 rounded-full text-sm font-bold border'
    : 'px-2 py-0.5 rounded-full text-xs font-bold border';
  return (
    <span
      className={cls}
      style={{ color: c, borderColor: c + '60', backgroundColor: c + '18' }}
    >
      {tier || 'N/A'}
    </span>
  );
}
