/**
 * Agent Bootstrap Service
 *
 * Auto-registers agents from external/commonly-agent-services/<agent>/manifest.json on startup.
 * Uses upsert pattern - updates existing agents, creates new ones.
 */

const fs = require('fs');
const path = require('path');
const { AgentRegistry } = require('../models/AgentRegistry');

const AGENT_SERVICES_DIR = path.join(
  __dirname,
  '..',
  '..',
  'external',
  'commonly-agent-services',
);

class AgentBootstrapService {
  /**
   * Read all manifest.json files from agent services directory
   */
  static loadManifests() {
    const manifests = [];

    if (!fs.existsSync(AGENT_SERVICES_DIR)) {
      console.log('[agent-bootstrap] No agent services directory found');
      return manifests;
    }

    const entries = fs.readdirSync(AGENT_SERVICES_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(AGENT_SERVICES_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const content = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(content);
        manifests.push(manifest);
      } catch (error) {
        console.error(`[agent-bootstrap] Failed to load ${entry.name}/manifest.json:`, error.message);
      }
    }

    return manifests;
  }

  /**
   * Register agents in the AgentRegistry (upsert - no duplicates)
   */
  static async bootstrap() {
    const manifests = this.loadManifests();

    if (manifests.length === 0) {
      console.log('[agent-bootstrap] No agent manifests found');
      return;
    }

    console.log(`[agent-bootstrap] Registering ${manifests.length} agents...`);

    for (const agent of manifests) {
      try {
        await AgentRegistry.findOneAndUpdate(
          { agentName: agent.agentName },
          {
            $set: {
              displayName: agent.displayName,
              description: agent.description,
              manifest: agent.manifest,
              latestVersion: agent.version,
              categories: agent.categories || [],
              tags: agent.tags || [],
              registry: agent.registry || 'commonly-official',
              verified: agent.verified || false,
            },
            $setOnInsert: {
              stats: { installs: 0, weeklyInstalls: 0, rating: 0, ratingCount: 0 },
              versions: [{
                version: agent.version,
                manifest: agent.manifest,
                publishedAt: new Date(),
              }],
            },
          },
          { upsert: true },
        );
        console.log(`[agent-bootstrap] ${agent.agentName} registered`);
      } catch (error) {
        console.error(`[agent-bootstrap] Failed to register ${agent.agentName}:`, error.message);
      }
    }

    console.log('[agent-bootstrap] Done');
  }
}

module.exports = AgentBootstrapService;
