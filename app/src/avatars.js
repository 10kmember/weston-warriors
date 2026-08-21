/**
 * The default avatar set.
 *
 * Members pick one of these and cannot upload anything. That is a product
 * decision with a pleasant side effect: there is no file upload path in the
 * application at all, so no image parsing, no storage bucket, no EXIF to
 * strip, no content moderation and no way to smuggle a payload in through an
 * avatar. The column holds a key, and the key is checked against this list.
 *
 * Illustrations credited to Alesyia Volkova.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, '..', '..', 'assets', 'avatars', 'manifest.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

export const AVATAR_CREDIT = manifest.credit;
export const AVATARS = manifest.avatars;
export const DEFAULT_AVATAR = AVATARS[0].key;

const byKey = new Map(AVATARS.map((a) => [a.key, a]));

export function isAvatarKey(key) {
  return byKey.has(String(key || ''));
}

export function avatar(key) {
  return byKey.get(String(key || '')) || byKey.get(DEFAULT_AVATAR);
}

/** Path the browser fetches. The site is served from the same origin. */
export function avatarSrc(key) {
  return `/assets/avatars/${avatar(key).key}.svg`;
}
