const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const CommonlyBotService = require('../services/commonlyBotService');

/**
 * Test route for Commonly Bot functionality
 * Only available in development
 */

// Test Discord summary posting
router.post('/discord-summary', auth, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' });
  }

  try {
    const { podId, discordSummary, integrationId } = req.body;
    
    if (!podId || !discordSummary) {
      return res.status(400).json({ message: 'podId and discordSummary are required' });
    }

    const botService = new CommonlyBotService();
    const result = await botService.postDiscordSummaryToPod(
      podId, 
      discordSummary, 
      integrationId || 'test-integration'
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Discord summary posted successfully',
        data: {
          messageId: result.message._id,
          podName: result.pod.name,
          botUser: await botService.getBotInfo()
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.error
      });
    }

  } catch (error) {
    console.error('Error in test Discord summary:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get bot info
router.get('/bot-info', auth, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' });
  }

  try {
    const botService = new CommonlyBotService();
    const botInfo = await botService.getBotInfo();
    
    res.json({
      success: true,
      botExists: await botService.botExists(),
      botInfo: botInfo
    });

  } catch (error) {
    console.error('Error getting bot info:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;