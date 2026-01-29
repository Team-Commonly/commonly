---
name: testing
description: Testing and code quality context for Jest, React Testing Library, ESLint, and test patterns. Use when writing tests or fixing linting issues.
---

# Testing & Quality

**Technologies**: Jest, React Testing Library, Supertest, ESLint

## Required Knowledge
- Jest test framework
- React Testing Library patterns
- API testing with Supertest
- In-memory database testing (MongoDB Memory Server, pg-mem)
- ESLint configuration
- Test-driven development

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [LINTING.md](../../../docs/development/LINTING.md) | ESLint setup, auto-fix, IDE integration |
| [BACKEND.md](../../../docs/development/BACKEND.md) | Backend testing patterns |
| [FRONTEND.md](../../../docs/development/FRONTEND.md) | Frontend testing patterns |

## Testing Commands

```bash
# Backend tests
cd backend && npm test
cd backend && npm run test:coverage

# Frontend tests
cd frontend && npm test
cd frontend && npm run test:coverage

# Linting
npm run lint
npm run lint:fix

# Containerized workflow (recommended in this repo)
docker compose exec backend npm run lint
docker compose exec backend npm test
docker compose exec frontend npm run lint
docker compose exec frontend npm test -- --watch=false
```

## High-value Current Test Areas

- Integration provider contract tests: `backend/__tests__/contracts/integrationProvider.contract.test.js`.
- Integration catalog + manifest validation routes.
- `backend/__tests__/unit/routes/integrations.catalog.test.js`.
- `backend/__tests__/unit/routes/integrations.validation.test.js`.
- Pod context and skill synthesis.
- `backend/__tests__/unit/routes/pods.context.test.js`.
- `backend/__tests__/unit/services/podContextService.test.js`.
- `backend/__tests__/unit/services/podSkillService.test.js`.

## Backend Testing Patterns

### Unit Test
```javascript
describe('MessageService', () => {
  it('should create a message', async () => {
    const message = await MessageService.create({
      podId: 'pod123',
      userId: 'user123',
      content: 'Hello'
    });
    expect(message.content).toBe('Hello');
  });
});
```

### API Test
```javascript
describe('POST /api/messages', () => {
  it('should create message', async () => {
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ podId: 'pod123', content: 'Hello' });
    expect(res.status).toBe(201);
  });
});
```

## Frontend Testing Patterns

### Component Test
```javascript
describe('ChatRoom', () => {
  it('renders messages', async () => {
    render(<ChatRoom podId="123" />);
    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });
  });
});
```

### Mock Axios
```javascript
jest.mock('axios');
axios.get.mockResolvedValue({ data: mockMessages });
```

## ESLint Configuration

```javascript
// .eslintrc.js
module.exports = {
  extends: ['eslint:recommended', 'plugin:react/recommended'],
  rules: {
    'no-unused-vars': 'error',
    'no-console': 'warn'
  }
};
```
