// Node name resolution using nearest-city proximity for intersection nodes

const PAKISTAN_CITIES = [
  { name: 'Karachi',         lat: 24.861, lon: 67.011 },
  { name: 'Lahore',          lat: 31.558, lon: 74.352 },
  { name: 'Islamabad',       lat: 33.738, lon: 73.084 },
  { name: 'Peshawar',        lat: 34.015, lon: 71.579 },
  { name: 'Quetta',          lat: 30.183, lon: 67.001 },
  { name: 'Multan',          lat: 30.197, lon: 71.478 },
  { name: 'Faisalabad',      lat: 31.417, lon: 73.079 },
  { name: 'Hyderabad',       lat: 25.396, lon: 68.374 },
  { name: 'Sukkur',          lat: 27.706, lon: 68.867 },
  { name: 'Gwadar',          lat: 25.122, lon: 62.325 },
  { name: 'Rawalpindi',      lat: 33.597, lon: 73.059 },
  { name: 'Sialkot',         lat: 32.492, lon: 74.535 },
  { name: 'Gujranwala',      lat: 32.162, lon: 74.187 },
  { name: 'Bahawalpur',      lat: 29.395, lon: 71.678 },
  { name: 'Sargodha',        lat: 32.083, lon: 72.671 },
  { name: 'Larkana',         lat: 27.559, lon: 68.215 },
  { name: 'Nawabshah',       lat: 26.244, lon: 68.411 },
  { name: 'Mirpur Khas',     lat: 25.527, lon: 69.011 },
  { name: 'Jacobabad',       lat: 28.282, lon: 68.438 },
  { name: 'Dera Ghazi Khan', lat: 30.064, lon: 70.634 },
  { name: 'Rahim Yar Khan',  lat: 28.420, lon: 70.295 },
  { name: 'Mardan',          lat: 34.199, lon: 72.035 },
  { name: 'Mingora',         lat: 34.773, lon: 72.361 },
  { name: 'Khuzdar',         lat: 27.813, lon: 66.611 },
  { name: 'Turbat',          lat: 25.988, lon: 63.043 },
  { name: 'Hub',             lat: 25.063, lon: 66.988 },
  { name: 'Kotri',           lat: 25.365, lon: 68.311 },
  { name: 'Rohri',           lat: 27.691, lon: 68.896 },
  { name: 'Khairpur',        lat: 27.533, lon: 68.759 },
  { name: 'Dadu',            lat: 26.731, lon: 67.775 },
  { name: 'Shikarpur',       lat: 27.956, lon: 68.639 },
  { name: 'Khanewal',        lat: 30.302, lon: 71.933 },
  { name: 'Muzaffargarh',    lat: 30.073, lon: 71.193 },
  { name: 'Gojra',           lat: 31.148, lon: 72.686 },
  { name: 'Sahiwal',         lat: 30.668, lon: 73.110 },
  { name: 'Okara',           lat: 30.808, lon: 73.461 },
  { name: 'Dera Ismail Khan',lat: 31.833, lon: 70.910 },
  { name: 'Bannu',           lat: 32.985, lon: 70.604 },
  { name: 'Abbottabad',      lat: 34.150, lon: 73.211 },
  { name: 'Mansehra',        lat: 34.333, lon: 73.200 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Return a human-readable name for any node.
 * - Facilities: uses display_name or name from DB
 * - Intersections: finds nearest city within 50 km
 */
export function resolveNodeName(props) {
  if (!props) return 'Unknown';

  if (props.display_name) return props.display_name;
  if (props.name) return props.name;

  const lat = props.lat ?? props.latitude;
  const lon = props.lon ?? props.longitude;

  if (lat != null && lon != null) {
    const nearest = PAKISTAN_CITIES.reduce(
      (best, city) => {
        const d = haversineKm(lat, lon, city.lat, city.lon);
        return d < best.dist ? { city, dist: d } : best;
      },
      { city: null, dist: Infinity }
    );

    if (nearest.dist < 50) return `Near ${nearest.city.name}`;
    return `Junction · ${Number(lat).toFixed(2)}°N ${Number(lon).toFixed(2)}°E`;
  }

  return props.asset_id || 'Network Node';
}
