import { createHash } from 'node:crypto';

// Kept apart from source.ts so PDF-only entry points do not load Playwright.
export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
