const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const {
  PORT = 4101,
  COMMONLY_API_BASE = 'http://localhost:5000',
  COMMONLY_API_TOKEN = '',
  COMMONLY_INGEST_ENDPOINT = '/api/integrations/ingest',
  INTEGRATION_ID = '',
} = process.env;

const buildHeaders = () => {
  if (!COMMONLY_API_TOKEN) return {};
  return { Authorization: `Bearer ${COMMONLY_API_TOKEN}` };
};

const forwardEvent = async (payload) => {
  if (!INTEGRATION_ID) {
    throw new Error('INTEGRATION_ID is required');
  }

  const url = `${COMMONLY_API_BASE}${COMMONLY_INGEST_ENDPOINT}`;
  return axios.post(
    url,
    {
      provider: 'discord',
      integrationId: INTEGRATION_ID,
      event: payload,
    },
    { headers: buildHeaders() },
  );
};

app.post('/webhook', async (req, res) => {
  try {
    await forwardEvent(req.body);
  } catch (error) {
    console.error('discord forward failed:', error.message);
  }
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, provider: 'discord' });
});

app.listen(PORT, () => {
  console.log(`discord-provider listening on ${PORT}`);
});
