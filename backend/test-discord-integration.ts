// @ts-nocheck
/**
 * Discord Integration Test Script
 * Run this script to test the Discord integration functionality
 */

const axios = require("axios");
const _DiscordService = require("./services/discordService");
const _DiscordIntegration = require("./models/DiscordIntegration");
const _Integration = require("./models/Integration");
// const mongoose = require('mongoose');
require("dotenv").config();

// Test configuration
const TEST_CONFIG = {
  serverId: "123456789",
  serverName: "Test Server",
  channelId: "987654321",
  channelName: "#test-channel",
  webhookUrl: "https://discord.com/api/webhooks/test",
  botToken: "test-token",
  permissions: ["read_messages", "send_messages"],
};

// Test functions
async function testWebhookConnection() {
  console.log("🔗 Testing webhook connection...");

  try {
    const response = await axios.post(
      `${TEST_CONFIG.baseURL}/api/discord/test-webhook`,
      {
        webhookUrl: TEST_CONFIG.webhookUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (response.data.success) {
      console.log("✅ Webhook test successful!");
      return true;
    }
    console.log("❌ Webhook test failed:", response.data.message);
    return false;
  } catch (error) {
    console.error(
      "❌ Webhook test error:",
      error.response?.data || error.message,
    );
    return false;
  }
}

async function testCreateIntegration() {
  console.log("🤖 Testing Discord integration creation...");

  try {
    const response = await axios.post(
      `${TEST_CONFIG.baseURL}/api/discord/integration`,
      {
        podId: TEST_CONFIG.podId,
        serverId: TEST_CONFIG.serverId,
        serverName: "Commonly Test Server",
        channelId: TEST_CONFIG.channelId,
        channelName: "test-channel",
        webhookUrl: TEST_CONFIG.webhookUrl,
        botToken: TEST_CONFIG.botToken,
      },
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("✅ Integration created successfully!");
    console.log("Integration ID:", response.data.integration._id);
    return response.data.integration._id;
  } catch (error) {
    console.error(
      "❌ Integration creation error:",
      error.response?.data || error.message,
    );
    return null;
  }
}

async function testGetIntegrations() {
  console.log("📋 Testing get integrations...");

  try {
    const response = await axios.get(
      `${TEST_CONFIG.baseURL}/api/integrations/${TEST_CONFIG.podId}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
        },
      },
    );

    console.log("✅ Integrations retrieved successfully!");
    console.log("Found integrations:", response.data.length);
    response.data.forEach((integration, index) => {
      console.log(
        `  ${index + 1}. ${integration.type} - ${integration.status}`,
      );
    });
    return response.data;
  } catch (error) {
    console.error(
      "❌ Get integrations error:",
      error.response?.data || error.message,
    );
    return [];
  }
}

async function testSendDiscordMessage(integrationId) {
  console.log("💬 Testing send Discord message...");

  try {
    const _response = await axios.post(
      `${TEST_CONFIG.baseURL}/api/integrations/${integrationId}/send`,
      {
        message: "🤖 Test message from Commonly integration!",
        type: "discord",
      },
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("✅ Message sent successfully!");
    return true;
  } catch (error) {
    console.error(
      "❌ Send message error:",
      error.response?.data || error.message,
    );
    return false;
  }
}

async function testFetchMessages(integrationId) {
  console.log("📥 Testing fetch messages...");

  try {
    const _response = await axios.get(
      `${TEST_CONFIG.baseURL}/api/integrations/${integrationId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
        },
      },
    );

    console.log("✅ Messages fetched successfully!");
    console.log("Message count:", _response.data.length);
    return _response.data;
  } catch (error) {
    console.error(
      "❌ Fetch messages error:",
      error.response?.data || error.message,
    );
    return [];
  }
}

async function testGetStats(integrationId) {
  console.log("📊 Testing get stats...");

  try {
    const _response = await axios.get(
      `${TEST_CONFIG.baseURL}/api/discord/stats/${integrationId}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
        },
      },
    );

    console.log("✅ Stats retrieved successfully!");
    console.log("Stats:", _response.data);
    return _response.data;
  } catch (error) {
    console.error("❌ Get stats error:", error.response?.data || error.message);
    return null;
  }
}

async function testDeleteIntegration(integrationId) {
  console.log("🗑️ Testing delete integration...");

  try {
    const _response = await axios.delete(
      `${TEST_CONFIG.baseURL}/api/integrations/${integrationId}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_CONFIG.authToken}`,
        },
      },
    );

    console.log("✅ Integration deleted successfully!");
    return true;
  } catch (error) {
    console.error(
      "❌ Delete integration error:",
      error.response?.data || error.message,
    );
    return false;
  }
}

// Main test function
async function runTests() {
  console.log("🚀 Starting Discord Integration Tests...\n");

  // Check if required environment variables are set
  if (
    TEST_CONFIG.webhookUrl === "YOUR_WEBHOOK_URL" ||
    TEST_CONFIG.botToken === "YOUR_BOT_TOKEN" ||
    TEST_CONFIG.podId === "YOUR_POD_ID" ||
    TEST_CONFIG.authToken === "YOUR_JWT_TOKEN"
  ) {
    console.log(
      "⚠️  Please update TEST_CONFIG with your actual values before running tests.",
    );
    console.log("   See docs/TEST_DISCORD_BOT.md for setup instructions.\n");
    return;
  }

  let integrationId = null;

  try {
    // Test 1: Webhook connection
    const webhookTest = await testWebhookConnection();
    if (!webhookTest) {
      console.log("❌ Webhook test failed. Stopping tests.\n");
      return;
    }

    // Test 2: Get existing integrations
    await testGetIntegrations();

    // Test 3: Create new integration
    integrationId = await testCreateIntegration();
    if (!integrationId) {
      console.log("❌ Integration creation failed. Stopping tests.\n");
      return;
    }

    // Test 4: Get stats
    await testGetStats(integrationId);

    // Test 5: Fetch messages
    await testFetchMessages(integrationId);

    // Test 6: Send message (optional - requires proper setup)
    // await testSendDiscordMessage(integrationId);

    console.log("\n✅ All tests completed successfully!");
  } catch (error) {
    console.error("❌ Test execution error:", error.message);
  } finally {
    // Cleanup: Delete test integration
    if (integrationId) {
      console.log("\n🧹 Cleaning up test integration...");
      await testDeleteIntegration(integrationId);
    }
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests()
    .then(() => {
      console.log("\n🏁 Test script finished.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Test script failed:", error);
      process.exit(1);
    });
}

module.exports = {
  testWebhookConnection,
  testCreateIntegration,
  testGetIntegrations,
  testSendDiscordMessage,
  testFetchMessages,
  testGetStats,
  testDeleteIntegration,
  runTests,
};
