// Per-mile cumulative elapsed seconds from Ultrapacer base plan (24 h = 86 400 s total).
// SPLITS[i] = elapsed seconds at the end of mile i; index 0 = race start = 0 s.
// Source: uP-Homedred Miler-Base-miles.csv (includes ~3 min aid-station delays per crew stop).
const SPLITS = [
      0,   588,  1248,  1981,  2604,  3425,  4249,  5251,  6028,  6571,
   7168,  8028,  8870, 10044, 10798, 11856, 12806, 13562, 14423, 15243,
  16187, 17129, 18083, 19092, 19853, 20503, 21245, 22055, 23150, 24769,
  25611, 26351, 27059, 27953, 28713, 29415, 30052, 30732, 31374, 32038,
  32645, 33303, 33955, 34607, 35372, 36000, 36654, 37347, 38047, 38759,
  39721, 40705, 41777, 42678, 43574, 44267, 45041, 45993, 47138, 48139,
  49023, 49780, 50538, 51248, 52167, 53539, 54375, 55118, 56036, 57350,
  58601, 60174, 61211, 62205, 63201, 64158, 65570, 66802, 67450, 68260,
  69103, 70085, 70963, 71639, 72594, 73711, 74552, 75390, 76124, 77020,
  78161, 78940, 79823, 80623, 81394, 82288, 83152, 84078, 84779, 85646,
  86400,
]

// Total elapsed seconds in the Ultrapacer base plan.
export const PACE_BASE_SECS = 86400

// Elapsed seconds at any fractional mile via linear interpolation.
export function elapsedAt(mi) {
  const lo = Math.floor(Math.min(Math.max(mi, 0), 100))
  const hi = Math.min(lo + 1, 100)
  const t = mi - lo
  return SPLITS[lo] + (SPLITS[hi] - SPLITS[lo]) * t
}
