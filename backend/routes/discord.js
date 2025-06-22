const express = require('express');

const router = express.Router();
const nacl = require('tweetnacl');
// const DiscordController = require('../controllers/discordController');

// Discord public key for signature verification
const { DISCORD_PUBLIC_KEY } = process.env;

// Verify Discord request signature
function verifySignature(req) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  // Use raw body for signature verification
  const body = req.body.toString('utf8');

  console.log('Discord signature verification:');
  console.log('- Signature header:', signature);
  console.log('- Timestamp header:', timestamp);
  console.log('- Public key:', DISCORD_PUBLIC_KEY ? 'Present' : 'Missing');
  console.log('- Body length:', body.length);

  if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
    console.error('Missing required headers or public key');
    return false;
  }

  try {
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
    const message = Buffer.from(timestamp + body, 'utf8');

    const isValid = nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
    console.log('- Signature verification result:', isValid);
    return isValid;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

// Create Discord integration
// router.post('/integration', auth, DiscordController.createIntegration);

// Get Discord integration details
// router.get('/integration/:id', auth, DiscordController.getIntegration);

// Update Discord integration
// router.put('/integration/:id', auth, DiscordController.updateIntegration);

// Get Discord channels for a server
// router.get('/channels/:integrationId', auth, DiscordController.getChannels);

// Generate bot invite link
// router.post('/invite', auth, DiscordController.generateInviteLink);

// Test webhook connection
// router.post('/test-webhook', auth, DiscordController.testWebhook);

// Get Discord integration statistics
// router.get('/stats/:id', auth, DiscordController.getStats);

// Discord Interactions endpoint
router.post('/interactions', async (req, res) => {
  console.log('Received Discord interaction (raw body):', req.body.toString('utf8'));

  // Verify Discord signature (required for security)
  if (!verifySignature(req)) {
    console.error('Invalid Discord signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse the JSON body after verification
  let interaction;
  try {
    interaction = JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    console.error('Error parsing Discord interaction body:', error);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { type, data } = interaction;

  // Handle ping (required for Discord to verify the endpoint)
  if (type === 1) {
    console.log('Responding to Discord ping with manually constructed response.');
    const pongBody = JSON.stringify({ type: 1 });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(pongBody),
    });
    res.end(pongBody);
    return;
  }

  // Handle other interaction types
  try {
    switch (type) {
      case 2: // APPLICATION_COMMAND
        console.log('Handling application command:', data);
        return res.json({
          type: 4,
          data: { content: 'Command received!' },
        });
      default:
        console.log('Unknown interaction type:', type);
        return res.json({
          type: 4,
          data: { content: 'Unknown interaction type' },
        });
    }
  } catch (error) {
    console.error('Error handling Discord interaction:', error);
    return res.status(500).json({
      type: 4,
      data: { content: 'An error occurred while processing the command' },
    });
  }
});

module.exports = router;
