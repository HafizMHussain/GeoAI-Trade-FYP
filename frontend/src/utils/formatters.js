/**
 * Parse pipeline timestamps like "20260421_1959" or standard ISO strings.
 * Returns a Date or null.
 */
export function parsePipelineTimestamp(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  if (/^\d{8}_\d{4,6}$/.test(s)) {
    const y = s.slice(0,4), mo = s.slice(4,6), d = s.slice(6,8);
    const h = s.slice(9,11), m = s.slice(11,13), sec = s.slice(13,15) || '00';
    // Pipeline timestamps are UTC — append Z to prevent local-time interpretation
    return new Date(`${y}-${mo}-${d}T${h}:${m}:${sec}Z`);
  }
  const date = new Date(s);
  return isNaN(date.getTime()) ? null : date;
}

export function minutesAgoFromTs(ts) {
  const d = parsePipelineTimestamp(ts);
  if (!d) return null;
  return Math.round((Date.now() - d.getTime()) / 60000);
}

export function formatRelativeTime(mins) {
  if (mins === null || mins === undefined) return null;
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function pipelineTsToLabel(ts) {
  const s = String(ts || '').trim();
  if (/^\d{8}_\d{4,6}$/.test(s)) {
    return `${s.slice(6,8)}/${s.slice(4,6)} ${s.slice(9,11)}:${s.slice(11,13)}`;
  }
  return s.slice(0, 16);
}

export const formatHours = (hours) => {
  if (hours === null || hours === undefined) return 'N/A';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
};

export const formatKm = (km) => {
  if (km === null || km === undefined) return 'N/A';
  return `${Math.round(km * 10) / 10} km`;
};

export const formatRisk = (risk) => {
  if (risk === null || risk === undefined) return 'N/A';
  return `${Math.round(risk * 100)}%`;
};

export const formatNumber = (num) => {
  if (num === null || num === undefined) return 'N/A';
  return num.toLocaleString();
};

export const formatCentrality = (val) => {
  if (val === null || val === undefined) return '0.000';
  return val.toFixed(6);
};

export const getRiskLevel = (hazard) => {
  if (hazard >= 0.7) return 'CRITICAL';
  if (hazard >= 0.5) return 'HIGH';
  if (hazard >= 0.3) return 'MEDIUM';
  return 'LOW';
};

export const getTravelTimeCategory = (hours) => {
  if (!hours) return 'unknown';
  if (hours < 5) return 'fast';
  if (hours < 12) return 'medium';
  if (hours < 20) return 'slow';
  return 'very_slow';
};
