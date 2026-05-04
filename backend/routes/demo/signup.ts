// Sign-up flow scaffold per signup-flow-spec.md
// Reads from project memory; provider order TBD per wireframes review.

import { Router } from 'express';
const router = Router();

router.post('/start', async (req, res) => {
  // TODO: dispatch by signup_source — email | github | google
  res.status(501).json({ error: 'not implemented' });
});

router.post('/verify', async (req, res) => {
  // TODO: verify magic link / OAuth callback
  res.status(501).json({ error: 'not implemented' });
});

export default router;
