/**
 * Reader for the typical-routes file, `format: 2`. No dependencies.
 *
 * A route is one URL-safe text. Its integers are hundredths of a degree: the first point as (lon, lat), then each next
 * point as the (lon, lat) difference from the one before, longitude wrapped to [-180, 180). Each integer is zigzagged
 * (0, -1, 1, -2 ... become 0, 1, 2, 3 ...) and written as base-32 digits, least significant first. A digit is the
 * character at that index of TEXT_DIGITS: indexes 0-31 end a number, indexes 32-63 (bit 5 set) mean another digit follows.
 */

export const TEXT_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** More digits than this cannot be a hundredth of a degree. */
const MAX_TEXT_DIGITS = 7;

export const routeKey = (originIcao, destinationIcao) => `${originIcao}-${destinationIcao}`;

export const wrapHundredths = (v) => ((((v + 18000) % 36000) + 36000) % 36000) - 18000;

/** Integers (first point, then deltas, in hundredths of a degree) to [[lon, lat], ...]; null when malformed. */
export function decodeRoute(encoded) {
  if (encoded.length % 2 !== 0 || encoded.length < 4) return null;
  const out = [];
  let lon = 0, lat = 0;
  for (let i = 0; i < encoded.length; i += 2) {
    lon = i === 0 ? encoded[0] : lon + encoded[i];
    lat = i === 0 ? encoded[1] : lat + encoded[i + 1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 9000) return null;
    out.push([wrapHundredths(lon) / 100, lat / 100]);
  }
  return out;
}

/**
 * The text of one route back to [[lon, lat], ...]; text with a bad character or a half-written number is null.
 * A cut on a whole-point boundary still decodes to a valid shorter line: the format has no checksum, the file's
 * SHA-256 protects it.
 */
export function decodeRouteText(text) {
  const integers = [];
  let value = 0, scale = 1, digits = 0;
  for (const char of text) {
    const digit = TEXT_DIGITS.indexOf(char);
    if (digit < 0 || ++digits > MAX_TEXT_DIGITS) return null;
    value += (digit % 32) * scale;
    scale *= 32;
    if (digit < 32) {
      integers.push(value % 2 === 0 ? value / 2 : -(value + 1) / 2);
      value = 0;
      scale = 1;
      digits = 0;
    }
  }
  return digits === 0 ? decodeRoute(integers) : null;
}

/** A route as flown from this airport to that one: the file stores hundredths of a degree, so the ends are replaced by the airports' own coordinates. */
export function routeLineFrom(text, origin, destination) {
  const line = decodeRouteText(text);
  if (!line) return null;
  line[0] = [origin[0], origin[1]];
  line[line.length - 1] = [destination[0], destination[1]];
  return line;
}

/** Every route of a parsed `format: 2` file as {key: [[lon, lat], ...]}. Throws on another format or an undecodable route. */
export function decodeFile(file) {
  if (file.format !== 2) throw new Error(`Unsupported format ${file.format}, expected 2`);
  const out = {};
  for (const [key, text] of Object.entries(file.routes)) {
    const line = decodeRouteText(text);
    if (!line) throw new Error(`${key}: the route text does not decode`);
    out[key] = line;
  }
  return out;
}
