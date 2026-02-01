const mongoose = require('mongoose');
const User = require('../models/User');
const AgentIdentityService = require('../services/agentIdentityService');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Get or create the openclaw agent user with instanceId 'cuz'
  const agentUser = await AgentIdentityService.getOrCreateAgentUser('openclaw', {
    instanceId: 'cuz',
    displayName: 'Cuz 🦞',
  });

  // Set scopes and generate token
  agentUser.apiTokenScopes = [
    'agent:events:read',
    'agent:events:ack',
    'agent:context:read',
    'agent:messages:read',
    'agent:messages:write',
  ];

  const token = agentUser.generateApiToken();
  await agentUser.save();

  console.log('OpenClaw User Token:', token);
  console.log('Username:', agentUser.username);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
