import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import IntegrationsCatalog from './IntegrationsCatalog';

const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ token: 'token-1' }),
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

test('renders catalog entries from the API', async () => {
  axios.get.mockResolvedValue({
    data: {
      entries: [
        {
          id: 'slack',
          catalog: {
            label: 'Slack',
            description: 'Slack integration',
            capabilities: ['webhook', 'summary'],
          },
          stats: { activeIntegrations: 2 },
        },
      ],
    },
  });

  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter>
        <IntegrationsCatalog />
      </MemoryRouter>,
    );
  });

  expect(axios.get).toHaveBeenCalledWith('/api/integrations/catalog', {
    headers: { Authorization: 'Bearer token-1' },
  });
  expect(container.textContent).toContain('Integrations Catalog');
  expect(container.textContent).toContain('Slack');
  expect(container.textContent).toContain('2');
});

