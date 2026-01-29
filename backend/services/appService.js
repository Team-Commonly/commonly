/**
 * App Platform Service
 *
 * Handles:
 * - Webhook delivery with signatures
 * - Event dispatch to installed apps
 * - Agent MCP integration
 * - Marketplace operations
 */

const crypto = require('crypto');
const axios = require('axios');
const App = require('../models/App');
const AppInstallation = require('../models/AppInstallation');
const { hash, verify, randomSecret } = require('../utils/secret');

class AppService {
  /**
   * Deliver a webhook to an app
   */
  static async deliverWebhook(app, event, payload, webhookSecret) {
    if (app.status !== 'active' || !app.webhookUrl) {
      return { success: false, reason: 'App inactive or no webhook URL' };
    }

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      payload,
    });

    const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

    try {
      const response = await axios.post(app.webhookUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Commonly-Signature': `sha256=${signature}`,
          'X-Commonly-Event': event,
          'X-Commonly-Delivery': crypto.randomUUID(),
        },
        timeout: 10000,
      });

      // Record delivery
      app.stats.webhooksDelivered += 1;
      app.stats.lastActivity = new Date();
      await app.save();

      return {
        success: true,
        statusCode: response.status,
      };
    } catch (error) {
      console.error(`Webhook delivery failed for app ${app.name}:`, error.message);
      return {
        success: false,
        reason: error.message,
        statusCode: error.response?.status,
      };
    }
  }

  /**
   * Dispatch event to all installed apps that listen for it
   */
  static async dispatchEvent(event, targetType, targetId, payload) {
    try {
      // Find all active installations for this target that listen for this event
      const installations = await AppInstallation.find({
        targetType,
        targetId,
        status: 'active',
        events: event,
        $or: [{ tokenExpiresAt: null }, { tokenExpiresAt: { $gt: new Date() } }],
      }).populate('appId');

      const results = await Promise.all(
        installations.map(async (installation) => {
          const app = installation.appId;
          if (!app || app.status !== 'active') return [];

          const entries = [];

          // For webhook apps, deliver the webhook
          if (app.type === 'webhook' || app.type === 'integration') {
            // Note: We need the actual webhook secret, not the hash
            // In production, this would be decrypted or stored securely
            const result = await AppService.deliverWebhookByInstallation(installation, event, payload);
            entries.push({ appId: app._id, appName: app.name, ...result });
          }

          // For agent apps, we might push to a different queue or gateway
          if (app.type === 'agent') {
            entries.push({
              appId: app._id,
              appName: app.name,
              success: true,
              note: 'Agent event queued',
            });
          }

          return entries;
        }),
      );

      return results.flat();
    } catch (error) {
      console.error('Event dispatch error:', error);
      return [];
    }
  }

  /**
   * Deliver webhook by installation (using installation token)
   */
  static async deliverWebhookByInstallation(installation, event, payload) {
    const app = installation.appId;
    if (!app.webhookUrl) {
      return { success: false, reason: 'No webhook URL' };
    }

    const body = JSON.stringify({
      event,
      installationId: installation._id.toString(),
      targetType: installation.targetType,
      targetId: installation.targetId.toString(),
      timestamp: new Date().toISOString(),
      payload,
    });

    // Use installation token hash as signing key (simplified)
    const signature = crypto
      .createHmac('sha256', installation.tokenHash.substring(0, 32))
      .update(body)
      .digest('hex');

    try {
      const response = await axios.post(app.webhookUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Commonly-Signature': `sha256=${signature}`,
          'X-Commonly-Event': event,
          'X-Commonly-Installation': installation._id.toString(),
        },
        timeout: 10000,
      });

      return { success: true, statusCode: response.status };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get marketplace apps with filtering
   */
  static async getMarketplaceApps(options = {}) {
    const {
      category, type, search, limit = 50, skip = 0, sort = 'popular',
    } = options;

    const query = { 'marketplace.published': true, status: 'active' };

    if (category && category !== 'all') {
      query['marketplace.category'] = category;
    }

    if (type) {
      query.type = type;
    }

    let sortOptions = {};
    switch (sort) {
      case 'popular':
        sortOptions = { 'marketplace.installCount': -1 };
        break;
      case 'rating':
        sortOptions = { 'marketplace.rating': -1 };
        break;
      case 'recent':
        sortOptions = { createdAt: -1 };
        break;
      default:
        sortOptions = { 'marketplace.installCount': -1 };
    }

    let apps;
    if (search) {
      apps = await App.find({
        ...query,
        $text: { $search: search },
      })
        .select('-clientSecretHash -webhookSecretHash')
        .sort({ score: { $meta: 'textScore' }, ...sortOptions })
        .skip(skip)
        .limit(limit);
    } else {
      apps = await App.find(query)
        .select('-clientSecretHash -webhookSecretHash')
        .sort(sortOptions)
        .skip(skip)
        .limit(limit);
    }

    return apps.map((app) => AppService.formatForMarketplace(app));
  }

  /**
   * Format app for marketplace display
   */
  static formatForMarketplace(app) {
    return {
      id: app._id.toString(),
      name: app.name,
      displayName: app.agent?.displayName || app.name,
      description: app.description,
      type: app.type,
      homepage: app.homepage,
      category: app.marketplace?.category || 'other',
      tags: app.marketplace?.tags || [],
      logo: app.marketplace?.logo || app.agent?.avatar,
      verified: app.marketplace?.verified || false,
      rating: app.marketplace?.rating || 0,
      ratingCount: app.marketplace?.ratingCount || 0,
      installs: app.marketplace?.installCount || 0,
      capabilities: app.agent?.capabilities || [],
      scopes: app.defaultScopes || [],
      createdAt: app.createdAt,
    };
  }

  /**
   * Get featured/trending apps
   */
  static async getFeaturedApps(limit = 6) {
    const apps = await App.find({
      'marketplace.published': true,
      'marketplace.verified': true,
      status: 'active',
    })
      .select('-clientSecretHash -webhookSecretHash')
      .sort({ 'marketplace.rating': -1, 'marketplace.installCount': -1 })
      .limit(limit);

    return apps.map((app) => AppService.formatForMarketplace(app));
  }

  /**
   * Install an app to a pod
   */
  static async installApp(appId, podId, userId, options = {}) {
    const app = await App.findById(appId);
    if (!app) {
      throw new Error('App not found');
    }
    if (app.status !== 'active') {
      throw new Error('App is not active');
    }

    // Check for existing installation
    const existing = await AppInstallation.findOne({
      appId,
      targetType: 'pod',
      targetId: podId,
      status: 'active',
    });

    if (existing) {
      throw new Error('App already installed');
    }

    const token = randomSecret();
    const tokenHash = hash(token);

    const installation = await AppInstallation.create({
      appId,
      targetType: 'pod',
      targetId: podId,
      scopes: options.scopes || app.defaultScopes,
      events: options.events || app.allowedEvents,
      tokenHash,
      tokenExpiresAt: options.expiresIn ? new Date(Date.now() + options.expiresIn * 1000) : null,
      createdBy: userId,
    });

    // Record installation in app stats
    await app.recordInstall();

    // Dispatch installation event
    await AppService.dispatchEvent('app.installed', 'pod', podId, {
      appId: app._id.toString(),
      appName: app.name,
      installationId: installation._id.toString(),
    });

    return {
      installationId: installation._id.toString(),
      token,
      scopes: installation.scopes,
      events: installation.events,
    };
  }

  /**
   * Uninstall an app from a pod
   */
  static async uninstallApp(installationId, userId) {
    const installation = await AppInstallation.findById(installationId).populate('appId');
    if (!installation) {
      throw new Error('Installation not found');
    }

    const app = installation.appId;

    // Mark as revoked
    installation.status = 'revoked';
    await installation.save();

    // Update app stats
    if (app) {
      await app.recordUninstall();
    }

    // Dispatch uninstall event
    if (app) {
      await AppService.dispatchEvent('app.uninstalled', installation.targetType, installation.targetId, {
        appId: app._id.toString(),
        appName: app.name,
      });
    }

    return { success: true };
  }

  /**
   * Get installed apps for a pod
   */
  static async getInstalledApps(podId) {
    const installations = await AppInstallation.find({
      targetType: 'pod',
      targetId: podId,
      status: 'active',
    }).populate('appId', '-clientSecretHash -webhookSecretHash');

    return installations
      .filter((i) => i.appId)
      .map((installation) => ({
        installationId: installation._id.toString(),
        ...AppService.formatForMarketplace(installation.appId),
        scopes: installation.scopes,
        events: installation.events,
        installedAt: installation.createdAt,
      }));
  }

  /**
   * Validate app token (for API requests from apps)
   */
  static async validateToken(token) {
    const tokenHash = hash(token);

    const installation = await AppInstallation.findOne({
      tokenHash,
      status: 'active',
      $or: [{ tokenExpiresAt: null }, { tokenExpiresAt: { $gt: new Date() } }],
    }).populate('appId');

    if (!installation || !installation.appId) {
      return null;
    }

    return {
      installation,
      app: installation.appId,
      scopes: installation.scopes,
      targetType: installation.targetType,
      targetId: installation.targetId,
    };
  }

  /**
   * Check if an app has a specific scope for a target
   */
  static async hasScope(token, scope, targetType, targetId) {
    const validated = await AppService.validateToken(token);
    if (!validated) return false;

    if (validated.targetType !== targetType) return false;
    if (validated.targetId.toString() !== targetId.toString()) return false;

    return validated.scopes.includes(scope) || validated.scopes.includes('*');
  }
}

module.exports = AppService;
