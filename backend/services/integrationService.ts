import Integration from '../models/Integration';

/**
 * Common Integration Service
 * Abstract base class for all platform integrations
 */
class IntegrationService {
  protected integrationId: unknown;
  protected integration: InstanceType<typeof Integration> | null;

  constructor(integrationId: unknown) {
    this.integrationId = integrationId;
    this.integration = null;
  }

  static async initialize(): Promise<boolean> {
    throw new Error('initialize() must be implemented by subclass');
  }

  static async connect(): Promise<boolean> {
    throw new Error('connect() must be implemented by subclass');
  }

  static async disconnect(): Promise<boolean> {
    throw new Error('disconnect() must be implemented by subclass');
  }

  static async fetchMessages(_options: Record<string, unknown> = {}): Promise<unknown[]> {
    throw new Error('fetchMessages() must be implemented by subclass');
  }

  static async sendMessage(_message: string, _options: Record<string, unknown> = {}): Promise<unknown> {
    throw new Error('sendMessage() must be implemented by subclass');
  }

  static async getChannels(): Promise<unknown[]> {
    throw new Error('getChannels() must be implemented by subclass');
  }

  static async getStatus(): Promise<string> {
    throw new Error('getStatus() must be implemented by subclass');
  }

  static async testConnection(): Promise<boolean> {
    throw new Error('testConnection() must be implemented by subclass');
  }

  async updateStatus(status: string, errorMessage: string | null = null): Promise<void> {
    try {
      await Integration.findByIdAndUpdate(this.integrationId, {
        status,
        errorMessage,
        lastSync:
          status === 'connected' ? new Date() : (this.integration as Record<string, unknown>)?.lastSync,
      });

      if (this.integration) {
        (this.integration as Record<string, unknown>).status = status;
        (this.integration as Record<string, unknown>).errorMessage = errorMessage;
        if (status === 'connected') {
          (this.integration as Record<string, unknown>).lastSync = new Date();
        }
      }
    } catch (error) {
      console.error('Error updating integration status:', error);
      throw error;
    }
  }

  static async validateConfig(_config: Record<string, unknown>): Promise<boolean> {
    throw new Error('validateConfig() must be implemented by subclass');
  }

  static async getStats(): Promise<Record<string, unknown>> {
    throw new Error('getStats() must be implemented by subclass');
  }

  static async handleWebhook(_event: Record<string, unknown>): Promise<void> {
    throw new Error('handleWebhook() must be implemented by subclass');
  }
}

export default IntegrationService;
