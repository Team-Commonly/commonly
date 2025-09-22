const axios = require("axios");

/**
 * Discord Command Deployment Script
 * Registers global slash commands with Discord API
 */
class DiscordCommandDeployment {
  constructor() {
    this.maxRetries = 3;
    this.retryDelay = 5000; // 5 seconds
    this.results = {
      success: false,
      registered: 0,
      failed: 0,
      total: 0,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Main deployment method
   */
  async deploy() {
    console.log("🚀 Discord Command Deployment Started");
    console.log("=====================================\n");

    try {
      // Check environment variables
      this.validateEnvironment();

      // Register global commands
      await this.registerGlobalCommands();

      // Generate deployment report
      this.generateReport();

      return this.results;
    } catch (error) {
      console.error("❌ Deployment failed:", error.message);
      this.results.success = false;
      this.results.errors.push(error.message);
      return this.results;
    }
  }

  /**
   * Validate required environment variables
   */
  validateEnvironment() {
    const required = ["DISCORD_CLIENT_ID", "DISCORD_BOT_TOKEN"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`,
      );
    }

    console.log("✅ Environment variables validated");
  }

  /**
   * Register global commands with Discord API
   */
  async registerGlobalCommands() {
    const { DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN } = process.env;

    // Define the slash commands
    const commands = [
      {
        name: "commonly-summary",
        description: "Get the most recent summary from the linked chat pod",
        type: 1, // CHAT_INPUT
      },
      {
        name: "discord-status",
        description: "Show the status of Discord integration",
        type: 1,
      },
      {
        name: "discord-enable",
        description: "Enable webhook listener for Discord channel",
        type: 1,
      },
      {
        name: "discord-disable",
        description: "Disable webhook listener for Discord channel",
        type: 1,
      },
      {
        name: "discord-push",
        description: "Push Discord activity from last hour to Commonly pod now",
        type: 1,
      },
    ];

    console.log(`🔧 Registering ${commands.length} global commands...`);

    // Try registration with retries
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const success = await this.attemptGlobalRegistration(
          commands,
          DISCORD_CLIENT_ID,
          DISCORD_BOT_TOKEN,
        );

        if (success) {
          console.log(
            `✅ Successfully registered ${commands.length} global commands`,
          );
          this.results.registered = commands.length;
          this.results.total = commands.length;
          this.results.success = true;
          return;
        }
        throw new Error("Registration returned false");
      } catch (error) {
        console.log(
          `❌ Attempt ${attempt}/${this.maxRetries} failed: ${error.message}`,
        );

        if (attempt === this.maxRetries) {
          console.log("💥 All attempts failed for global commands");
          this.results.failed = commands.length;
          this.results.errors.push(`Global commands: ${error.message}`);
        } else {
          console.log(`⏳ Retrying in ${this.retryDelay / 1000} seconds...`);
          await this.sleep(this.retryDelay);
        }
      }
    }
  }

  /**
   * Attempt to register global commands
   */
  async attemptGlobalRegistration(commands, clientId, botToken) {
    try {
      const url = `https://discord.com/api/v10/applications/${clientId}/commands`;

      const response = await axios.put(url, commands, {
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.status === 200 || response.status === 201) {
        console.log(`✅ Discord API returned status ${response.status}`);
        return true;
      }
      throw new Error(`Discord API returned status ${response.status}`);
    } catch (error) {
      if (error.response) {
        throw new Error(
          `Discord API error: ${error.response.status} - ${error.response.data?.message || "Unknown error"}`,
        );
      } else {
        throw new Error(`Network error: ${error.message}`);
      }
    }
  }

  /**
   * Generate deployment report
   */
  generateReport() {
    console.log("\n📊 Deployment Report");
    console.log("===================");
    console.log(`✅ Successfully registered: ${this.results.registered}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(`📋 Total commands: ${this.results.total}`);
    console.log(
      `🎯 Success rate: ${this.results.total > 0 ? Math.round((this.results.registered / this.results.total) * 100) : 0}%`,
    );

    if (this.results.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      this.results.warnings.forEach((warning) =>
        console.log(`   - ${warning}`),
      );
    }

    if (this.results.errors.length > 0) {
      console.log("\n❌ Errors:");
      this.results.errors.forEach((error) => console.log(`   - ${error}`));
    }

    if (this.results.failed === 0) {
      console.log("\n🎉 All commands registered successfully!");
    } else {
      console.log(
        "\n⚠️  Some commands failed to register. Check the errors above.",
      );
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Verify deployment status
   */
  async verifyDeployment() {
    console.log("\n🔍 Verifying deployment status...");

    try {
      const { DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN } = process.env;

      const url = `https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}/commands`;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        },
      });

      if (response.status === 200) {
        const registeredCommands = response.data;
        const expectedCommands = [
          "commonly-summary",
          "discord-status",
          "discord-enable",
          "discord-disable",
          "discord-push",
        ];
        const foundCommands = registeredCommands.map((cmd) => cmd.name);

        const missingCommands = expectedCommands.filter(
          (cmd) => !foundCommands.includes(cmd),
        );

        if (missingCommands.length === 0) {
          console.log(
            `✅ All ${expectedCommands.length} commands verified globally`,
          );
          return { success: true, registeredCommands: foundCommands };
        }
        console.log(`❌ Missing commands: ${missingCommands.join(", ")}`);
        return {
          success: false,
          missingCommands,
          registeredCommands: foundCommands,
        };
      }
      throw new Error(`Discord API returned status ${response.status}`);
    } catch (error) {
      console.error("❌ Verification failed:", error.message);
      return { success: false, error: error.message };
    }
  }
}

/**
 * CLI interface
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const deployment = new DiscordCommandDeployment();

  switch (command) {
    case "deploy":
      await deployment.deploy();
      break;
    case "verify":
      await deployment.verifyDeployment();
      break;
    case "help":
      console.log("Discord Command Deployment Script");
      console.log("==================================");
      console.log("");
      console.log("Usage:");
      console.log(
        "  node scripts/deploy-discord-commands.js deploy    - Deploy global commands",
      );
      console.log(
        "  node scripts/deploy-discord-commands.js verify    - Verify deployment status",
      );
      console.log(
        "  node scripts/deploy-discord-commands.js help      - Show this help",
      );
      console.log("");
      console.log("Environment Variables:");
      console.log("  DISCORD_CLIENT_ID    - Discord application client ID");
      console.log("  DISCORD_BOT_TOKEN    - Discord bot token");
      break;
    default:
      // Default: deploy
      await deployment.deploy();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = DiscordCommandDeployment;
