export default function ScoreBar({ value, color, height = '1.5' }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className={`h-${height} bg-gray-100 rounded-full overflow-hidden`}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}
