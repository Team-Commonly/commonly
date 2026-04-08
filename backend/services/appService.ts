import crypto from 'crypto';
import axios from 'axios';
import App from '../models/App';
import AppInstallation from '../models/AppInstallation';

// eslint-disable-next-line global-require
const { hash, randomSecret } = require('../utils/secret') as {
  hash: (value: string) => string;
  verify: (value: string, hash: string) => boolean;
  randomSecret: () => string;
};

interface WebhookResult {
  success: boolean;
  reason?: string;
  statusCode?: number;
}

interface InstallResult {
  installationId: string;
  token: string;
  scopes: string[];
  events: string[];
}

interface MarketplaceApp {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  homepage: string;
  category: string;
  tags: string[];
  logo: string | null;
  verified: boolean;
  rating: number;
  ratingCount: number;
  installs: number;
  capabilities: string[];
  scopes: string[];
  createdAt: Date;
}

interface GetMarketplaceOptions {
  category?: string;
  type?: string;
  search?: string;
  limit?: number;
  skip?: number;
  sort?: string;
}

interface ValidatedToken {
  installation: InstanceType<typeof AppInstallation>;
  app: InstanceType<typeof App>;
  scopes: string[];
  targetType: string;
  targetId: unknown;
}

class AppService {
  static async deliverWebhook(app: InstanceType<typeof App>, event: string, payload: unknown, webhookSecret: string): Promise<WebhookResult> {
    const appDoc = app as unknown as Record<string, unknown>;
    if (appDoc.status !== 'active' || !appDoc.webhookUrl) {
      return { success: false, reason: 'App inactive or no webhook URL' };
    }

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      payload,
    });

    const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

    try {
      const response = await axios.post(String(appDoc.webhookUrl), body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Commonly-Signature': `sha256=${signature}`,
          'X-Commonly-Event': event,
          'X-Commonly-Delivery': crypto.randomUUID(),
        },
        timeout: 10000,
      });

      const stats = appDoc.stats as unknown as Record<string, unknown>;
      (stats.webhooksDelivered as number) += 1;
      stats.lastActivity = new Date();
      await app.save();

      return {
        success: true,
        statusCode: response.status,
      };
    } catch (error) {
      const err = error as Error & { response?: { status?: number } };
      console.error(`Webhook delivery failed for app ${String(appDoc.name)}:`, err.message);
      return {
        success: false,
        reason: err.message,
        statusCode: err.response?.status,
      };
    }
  }

  static async dispatchEvent(event: string, targetType: string, targetId: unknown, payload: unknown): Promise<Array<Record<string, unknown>>> {
    try {
      const installations = await AppInstallation.find({
        targetType,
        targetId,
        status: 'active',
        events: event,
        $or: [{ tokenExpiresAt: null }, { tokenExpiresAt: { $gt: new Date() } }],
      }).populate('appId');

      const results = await Promise.all(
        installations.map(async (installation) => {
          const app = (installation as unknown as Record<string, unknown>).appId as InstanceType<typeof App>;
          const appDoc = app as unknown as Record<string, unknown>;
          if (!app || appDoc.status !== 'active') return [];

          const entries: Array<Record<string, unknown>> = [];

          if (appDoc.type === 'webhook' || appDoc.type === 'integration') {
            const result = await AppService.deliverWebhookByInstallation(installation, event, payload);
            entries.push({ appId: appDoc._id, appName: appDoc.name, ...result });
          }

          if (appDoc.type === 'agent') {
            entries.push({
              appId: appDoc._id,
              appName: appDoc.name,
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

  static async deliverWebhookByInstallation(installation: InstanceType<typeof AppInstallation>, event: string, payload: unknown): Promise<WebhookResult> {
    const app = (installation as unknown as Record<string, unknown>).appId as unknown as Record<string, unknown>;
    if (!app.webhookUrl) {
      return { success: false, reason: 'No webhook URL' };
    }

    const body = JSON.stringify({
      event,
      installationId: (installation as unknown as Record<string, unknown>)._id?.toString(),
      targetType: (installation as unknown as Record<string, unknown>).targetType,
      targetId: (installation as unknown as Record<string, unknown>).targetId?.toString(),
      timestamp: new Date().toISOString(),
      payload,
    });

    const tokenHash = String((installation as unknown as Record<string, unknown>).tokenHash || '');
    const signature = crypto
      .createHmac('sha256', tokenHash.substring(0, 32))
      .update(body)
      .digest('hex');

    try {
      const response = await axios.post(String(app.webhookUrl), body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Commonly-Signature': `sha256=${signature}`,
          'X-Commonly-Event': event,
          'X-Commonly-Installation': (installation as unknown as Record<string, unknown>)._id?.toString(),
        },
        timeout: 10000,
      });

      return { success: true, statusCode: response.status };
    } catch (error) {
      return { success: false, reason: (error as Error).message };
    }
  }

  static async getMarketplaceApps(options: GetMarketplaceOptions = {}): Promise<MarketplaceApp[]> {
    const {
      category, type, search, limit = 50, skip = 0, sort = 'popular',
    } = options;

    const query: Record<string, unknown> = { 'marketplace.published': true, status: 'active' };

    if (category && category !== 'all') {
      query['marketplace.category'] = category;
    }

    if (type) {
      query.type = type;
    }

    let sortOptions: Record<string, -1 | 1> = {};
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

    let apps: InstanceType<typeof App>[];
    if (search) {
      apps = await App.find({
        ...query,
        $text: { $search: search },
      })
        .select('-clientSecretHash -webhookSecretHash')
        .sort({ score: { $meta: 'textScore' }, ...sortOptions })
        .skip(skip)
        .limit(limit) as InstanceType<typeof App>[];
    } else {
      apps = await App.find(query)
        .select('-clientSecretHash -webhookSecretHash')
        .sort(sortOptions)
        .skip(skip)
        .limit(limit) as InstanceType<typeof App>[];
    }

    return apps.map((app) => AppService.formatForMarketplace(app));
  }

  static formatForMarketplace(app: InstanceType<typeof App>): MarketplaceApp {
    const a = app as unknown as Record<string, unknown>;
    return {
      id: (a._id as { toString(): string }).toString(),
      name: String(a.name),
      displayName: String((a.agent as unknown as Record<string, unknown>)?.displayName || a.name),
      description: String(a.description || ''),
      type: String(a.type),
      homepage: String(a.homepage || ''),
      category: String((a.marketplace as unknown as Record<string, unknown>)?.category || 'other'),
      tags: ((a.marketplace as unknown as Record<string, unknown>)?.tags as string[]) || [],
      logo: ((a.marketplace as unknown as Record<string, unknown>)?.logo || (a.agent as unknown as Record<string, unknown>)?.avatar) as string | null,
      verified: Boolean((a.marketplace as unknown as Record<string, unknown>)?.verified),
      rating: Number((a.marketplace as unknown as Record<string, unknown>)?.rating || 0),
      ratingCount: Number((a.marketplace as unknown as Record<string, unknown>)?.ratingCount || 0),
      installs: Number((a.marketplace as unknown as Record<string, unknown>)?.installCount || 0),
      capabilities: ((a.agent as unknown as Record<string, unknown>)?.capabilities as string[]) || [],
      scopes: (a.defaultScopes as string[]) || [],
      createdAt: a.createdAt as Date,
    };
  }

  static async getFeaturedApps(limit = 6): Promise<MarketplaceApp[]> {
    const apps = await App.find({
      'marketplace.published': true,
      'marketplace.verified': true,
      status: 'active',
    })
      .select('-clientSecretHash -webhookSecretHash')
      .sort({ 'marketplace.rating': -1, 'marketplace.installCount': -1 })
      .limit(limit) as InstanceType<typeof App>[];

    return apps.map((app) => AppService.formatForMarketplace(app));
  }

  static async installApp(appId: unknown, podId: unknown, userId: unknown, options: { scopes?: string[]; events?: string[]; expiresIn?: number } = {}): Promise<InstallResult> {
    const app = await App.findById(appId);
    if (!app) {
      throw new Error('App not found');
    }
    const appDoc = app as unknown as Record<string, unknown>;
    if (appDoc.status !== 'active') {
      throw new Error('App is not active');
    }

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
      scopes: options.scopes || appDoc.defaultScopes,
      events: options.events || appDoc.allowedEvents,
      tokenHash,
      tokenExpiresAt: options.expiresIn ? new Date(Date.now() + options.expiresIn * 1000) : null,
      createdBy: userId,
    });

    await (app as unknown as Record<string, unknown> & { recordInstall(): Promise<void> }).recordInstall();

    await AppService.dispatchEvent('app.installed', 'pod', podId, {
      appId: appDoc._id?.toString(),
      appName: appDoc.name,
      installationId: (installation as unknown as Record<string, unknown>)._id?.toString(),
    });

    const instDoc = installation as unknown as Record<string, unknown>;
    return {
      installationId: String(instDoc._id),
      token,
      scopes: (instDoc.scopes as string[]) || [],
      events: (instDoc.events as string[]) || [],
    };
  }

  static async uninstallApp(installationId: unknown, _userId: unknown): Promise<{ success: boolean }> {
    const installation = await AppInstallation.findById(installationId).populate('appId');
    if (!installation) {
      throw new Error('Installation not found');
    }

    const app = (installation as unknown as Record<string, unknown>).appId as InstanceType<typeof App> | null;
    const instDoc = installation as unknown as Record<string, unknown>;
    instDoc.status = 'revoked';
    await installation.save();

    if (app) {
      await (app as unknown as Record<string, unknown> & { recordUninstall(): Promise<void> }).recordUninstall();
    }

    if (app) {
      const appDoc = app as unknown as Record<string, unknown>;
      await AppService.dispatchEvent('app.uninstalled', String(instDoc.targetType), instDoc.targetId, {
        appId: appDoc._id?.toString(),
        appName: appDoc.name,
      });
    }

    return { success: true };
  }

  static async getInstalledApps(podId: unknown): Promise<Array<MarketplaceApp & { installationId: string; scopes: string[]; events: string[]; installedAt: Date }>> {
    const installations = await AppInstallation.find({
      targetType: 'pod',
      targetId: podId,
      status: 'active',
    }).populate('appId', '-clientSecretHash -webhookSecretHash');

    return installations
      .filter((i) => (i as unknown as Record<string, unknown>).appId)
      .map((installation) => {
        const instDoc = installation as unknown as Record<string, unknown>;
        return {
          installationId: String(instDoc._id),
          ...AppService.formatForMarketplace(instDoc.appId as InstanceType<typeof App>),
          scopes: (instDoc.scopes as string[]) || [],
          events: (instDoc.events as string[]) || [],
          installedAt: instDoc.createdAt as Date,
        };
      });
  }

  static async validateToken(token: string): Promise<ValidatedToken | null> {
    const tokenHash = hash(token);

    const installation = await AppInstallation.findOne({
      tokenHash,
      status: 'active',
      $or: [{ tokenExpiresAt: null }, { tokenExpiresAt: { $gt: new Date() } }],
    }).populate('appId');

    const instDoc = installation as unknown as Record<string, unknown> | null;
    if (!instDoc || !instDoc.appId) {
      return null;
    }

    return {
      installation: installation as InstanceType<typeof AppInstallation>,
      app: instDoc.appId as InstanceType<typeof App>,
      scopes: (instDoc.scopes as string[]) || [],
      targetType: String(instDoc.targetType),
      targetId: instDoc.targetId,
    };
  }

  static async hasScope(token: string, scope: string, targetType: string, targetId: unknown): Promise<boolean> {
    const validated = await AppService.validateToken(token);
    if (!validated) return false;

    if (validated.targetType !== targetType) return false;
    if (String(validated.targetId) !== String(targetId)) return false;

    return validated.scopes.includes(scope) || validated.scopes.includes('*');
  }
}

export default AppService;
