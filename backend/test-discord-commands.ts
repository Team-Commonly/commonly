// @ts-nocheck
const DiscordCommandService = require("./services/discordCommandService");
const Integration = require("./models/Integration");

/**
 * Test Discord Command Service
 * This script tests the Discord command functionality
 */
async function testDiscordCommands() {
  console.log("🧪 Testing Discord Command Service...\n");

  try {
    // Find a Discord integration to test with
    const integration = await Integration.findOne({
      type: "discord",
      isActive: true,
    });

    if (!integration) {
      console.log(
        "❌ No active Discord integration found. Please create one first.",
      );
      return;
    }

    console.log(`📋 Testing with integration: ${integration._id}`);
    console.log(`🏠 Server: ${integration.config.serverName || "Unknown"}`);
    console.log(`📺 Channel: ${integration.config.channelName || "Unknown"}\n`);

    // Initialize command service
    const commandService = new DiscordCommandService(
      integration.installationId,
    );
    const initialized = await commandService.initialize();

    if (!initialized) {
      console.log("❌ Failed to initialize command service");
      return;
    }

    console.log("✅ Command service initialized successfully\n");

    // Test status command
    console.log("🔍 Testing /discord-status command...");
    const statusResult = await commandService.handleStatusCommand();
    console.log("Status Result:", statusResult.success ? "✅" : "❌");
    console.log("Content:", statusResult.content);
    console.log("");

    // Test summary command
    console.log("📊 Testing /commonly-summary command...");
    const summaryResult = await commandService.handleSummaryCommand();
    console.log("Summary Result:", summaryResult.success ? "✅" : "❌");
    console.log("Content:", summaryResult.content);
    console.log("");

    // Test enable command
    console.log("✅ Testing /discord-enable command...");
    const enableResult = await commandService.handleEnableCommand();
    console.log("Enable Result:", enableResult.success ? "✅" : "❌");
    console.log("Content:", enableResult.content);
    console.log("");

    // Test disable command
    console.log("❌ Testing /discord-disable command...");
    const disableResult = await commandService.handleDisableCommand();
    console.log("Disable Result:", disableResult.success ? "✅" : "❌");
    console.log("Content:", disableResult.content);
    console.log("");

    console.log("🎉 Discord command tests completed!");
  } catch (error) {
    console.error("❌ Error testing Discord commands:", error);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  // Connect to database first
  // eslint-disable-next-line global-require
  const mongoose = require("mongoose");
  const { MONGODB_URI } = process.env;

  if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI environment variable is required");
    process.exit(1);
  }

  mongoose
    .connect(MONGODB_URI)
    .then(() => {
      console.log("📦 Connected to MongoDB");
      return testDiscordCommands();
    })
    .then(() => {
      console.log("✅ Test completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Test failed:", error);
      process.exit(1);
    });
}

module.exports = { testDiscordCommands };
