const mongoose = require('mongoose');
const { AgentInstallation } = require('../models/AgentRegistry');
const { hash, randomSecret } = require('../utils/secret');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const installation = await AgentInstallation.findOne({
    agentName: 'openclaw',
    instanceId: 'cuz',
    status: 'active'
  });

  if (!installation) {
    console.log('No openclaw installation found');
    process.exit(1);
  }

  const rawToken = 'cm_agent_' + randomSecret(32);
  installation.runtimeTokens = installation.runtimeTokens || [];
  installation.runtimeTokens.push({
    tokenHash: hash(rawToken),
    label: 'Cuz runtime',
    createdAt: new Date(),
  });

  await installation.save();

  console.log('OpenClaw Runtime Token:', rawToken);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
