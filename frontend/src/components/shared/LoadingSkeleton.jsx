export const LoadingSkeleton = ({ width = 'w-full', height = 'h-4', count = 3 }) => {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`${width} ${height} bg-gray-300 rounded animate-pulse`}
        />
      ))}
    </div>
  );
};

export const MapSkeleton = () => (
  <div className="w-full h-full bg-gray-300 animate-pulse rounded" />
);
