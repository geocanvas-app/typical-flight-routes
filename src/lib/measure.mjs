import {deflateRawSync} from 'node:zlib';

/** The bytes a package stores for this file: deflated (level 9, raw), or as is when deflate does not help. */
export const zippedBytes = (bytes) => Math.min(deflateRawSync(bytes, {level: 9}).length, bytes.length);
