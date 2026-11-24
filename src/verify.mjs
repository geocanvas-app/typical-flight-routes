import {createHash} from 'node:crypto';

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** True when the bytes hash to the expected SHA-256 (hex, any case). */
export const verifyFile = (bytes, expectedHex) => sha256Hex(bytes) === expectedHex.trim().toLowerCase();
