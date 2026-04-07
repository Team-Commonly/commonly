import fs from 'fs';
import path from 'path';

// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const axios = require('axios');

interface MarifestCache {
  data: { version: string; entries: unknown[] } | null;
  fetchedAt: number;
}

const defaultManifestPath = path.join(__dirname, '..', '..', 'packages', 'commonly-marketplace', 'marketplace.json');

let cache: MarifestCache = { data: null, fetchedAt: 0 };

const getCacheTtlMs = (): number => {
  const ttl = parseInt(process.env.MARKETPLACE_MANIFEST_TTL_MS || '', 10);
  return Number.isNaN(ttl) ? 5 * 60 * 1000 : ttl;
};

const sanitizeManifest = (manifest: unknown): { version: string; entries: unknown[] } => {
  if (!manifest || typeof manifest !== 'object') return { version: '0', entries: [] };
  const m = manifest as { version?: string; entries?: unknown[] };
  return { version: m.version || '0', entries: Array.isArray(m.entries) ? m.entries : [] };
};

const loadManifestFromFile = (manifestPath: string): unknown | null => {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
};

const loadManifest = async (): Promise<{ version: string; entries: unknown[] }> => {
  const now = Date.now();
  const ttl = getCacheTtlMs();
  if (cache.data && now - cache.fetchedAt < ttl) return cache.data;

  let manifest: unknown = null;
  const manifestUrl = process.env.MARKETPLACE_MANIFEST_URL;
  const manifestPath = process.env.MARKETPLACE_MANIFEST_PATH;
  const manifestPaths = [manifestPath, defaultManifestPath].filter(Boolean) as string[];

  if (manifestUrl) {
    try {
      const response = await axios.get(manifestUrl, { timeout: 5000 });
      manifest = response.data;
    } catch (error) {
      const e = error as { message?: string };
      console.warn('Failed to fetch marketplace manifest URL:', e.message);
    }
  }

  if (!manifest) {
    try {
      manifest = manifestPaths.reduce<unknown>((found, candidate) => found || loadManifestFromFile(candidate), null);
    } catch (error) {
      const e = error as { message?: string };
      console.warn('Failed to load marketplace manifest file:', e.message);
    }
  }

  const sanitized = sanitizeManifest(manifest);
  cache = { data: sanitized, fetchedAt: now };
  return sanitized;
};

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/official', (_req: unknown, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }) => {
  loadManifest()
    .then((manifest) => res.json(manifest))
    .catch((error) => {
      console.error('Error loading marketplace manifest:', error);
      res.status(500).json({ error: 'Failed to load marketplace manifest' });
    });
});

module.exports = router;
