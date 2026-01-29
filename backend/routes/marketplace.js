const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const router = express.Router();

const defaultManifestPath = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'commonly-marketplace',
  'marketplace.json',
);

let cache = {
  data: null,
  fetchedAt: 0,
};

const getCacheTtlMs = () => {
  const ttl = parseInt(process.env.MARKETPLACE_MANIFEST_TTL_MS, 10);
  return Number.isNaN(ttl) ? 5 * 60 * 1000 : ttl;
};

const sanitizeManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object') {
    return { version: '0', entries: [] };
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  return {
    version: manifest.version || '0',
    entries,
  };
};

const loadManifestFromFile = (manifestPath) => {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return null;
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
};

const loadManifest = async () => {
  const now = Date.now();
  const ttl = getCacheTtlMs();

  if (cache.data && now - cache.fetchedAt < ttl) {
    return cache.data;
  }

  let manifest = null;
  const manifestUrl = process.env.MARKETPLACE_MANIFEST_URL;
  const manifestPath = process.env.MARKETPLACE_MANIFEST_PATH;
  const manifestPaths = [
    manifestPath,
    defaultManifestPath,
  ].filter(Boolean);

  if (manifestUrl) {
    try {
      const response = await axios.get(manifestUrl, { timeout: 5000 });
      manifest = response.data;
    } catch (error) {
      console.warn('Failed to fetch marketplace manifest URL:', error.message);
    }
  }

  if (!manifest) {
    try {
      manifest = manifestPaths.reduce((found, candidate) => (
        found || loadManifestFromFile(candidate)
      ), null);
    } catch (error) {
      console.warn('Failed to load marketplace manifest file:', error.message);
    }
  }

  const sanitized = sanitizeManifest(manifest);
  cache = { data: sanitized, fetchedAt: now };
  return sanitized;
};

router.get('/official', (req, res) => {
  loadManifest()
    .then((manifest) => res.json(manifest))
    .catch((error) => {
      console.error('Error loading marketplace manifest:', error);
      res.status(500).json({ error: 'Failed to load marketplace manifest' });
    });
});

module.exports = router;
