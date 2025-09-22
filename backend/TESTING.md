# Backend Testing Guide

## Current Status ✅
- **All Tests Passing**: Backend test suite fully functional
- **Test Coverage**: Comprehensive unit and integration tests
- **Database Testing**: MongoDB Memory Server and pg-mem for isolation
- **GitHub Actions**: ✅ Test & Coverage check passing

## Quick Commands
```bash
# Run all backend tests
cd backend && npm test

# Run tests with coverage
cd backend && npm run test:coverage

# Run tests in watch mode
cd backend && npm run test:watch

# Run specific test file
npm test -- commonlyBotService.test.js

# Run tests in Docker (recommended)
./dev.sh test
```

## Test Environment Setup

### Test Database Isolation
- **MongoDB**: Uses MongoDB Memory Server for isolated testing
- **PostgreSQL**: Uses pg-mem for in-memory PostgreSQL testing
- **No Real Database**: Tests don't affect development/production databases

### Environment Variables in Tests
```javascript
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret'
process.env.PG_HOST = 'localhost' // for PostgreSQL availability checks
```

## Test Structure

### Unit Tests
Located in `__tests__/unit/` directory:
- `services/commonlyBotService.test.js` - Bot user management and Discord integration
- `services/summarizerService.test.js` - AI summarization functionality
- `services/dailyDigestService.test.js` - Daily digest generation
- `middleware/auth.test.js` - Authentication middleware

### Integration Tests
- Database integration tests with both MongoDB and PostgreSQL
- API endpoint testing with full request/response cycles
- Discord integration testing with mock Discord API

## Recent Test Fixes Applied (January 2025)

### commonlyBotService.test.js Updates
**Issues Fixed:**
- Test calls to instance methods after converting to static methods
- `TypeError: botService.syncBotUserToPostgreSQL is not a function`

**Solutions Applied:**
```javascript
// Before (instance method call)
await botService.syncBotUserToPostgreSQL(mockBot);

// After (static method call)
await CommonlyBotService.syncBotUserToPostgreSQL(mockBot);
```

### Static Method Testing Pattern
When methods are converted to static, update test calls:
```javascript
// Test setup - no change needed
const botService = new CommonlyBotService();

// Instance method tests - unchanged
const result = await botService.getBotUser();

// Static method tests - updated calls
await CommonlyBotService.syncBotUserToPostgreSQL(mockBot);
```

## Database Testing Patterns

### MongoDB Memory Server Setup
```javascript
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
```

### PostgreSQL pg-mem Setup
```javascript
const { newDb } = require('pg-mem');

let db;
let pool;

beforeAll(async () => {
  db = newDb();
  db.public.registerFunction({
    implementation: () => 'test',
    name: 'version',
  });

  pool = db.adapters.createPg().Pool;
});
```

## Mocking Patterns

### Service Dependencies
```javascript
// Mock external dependencies
jest.mock('../../../models/User');
jest.mock('../../../models/Pod');
jest.mock('../../../models/pg/Message');
jest.mock('../../../config/socket');
jest.mock('../../../config/db-pg');
```

### Socket.io Mocking
```javascript
const mockIo = {
  to: jest.fn().mockReturnThis(),
  emit: jest.fn(),
};
socketConfig.getIO.mockReturnValue(mockIo);
```

### Database Mock Setup
```javascript
beforeEach(() => {
  // MongoDB mocks
  User.findOne.mockResolvedValue(mockBot);
  Pod.findById.mockResolvedValue(mockPod);

  // PostgreSQL mocks
  PGMessage.create.mockResolvedValue({
    id: 'msg123',
    content: 'test message',
    created_at: new Date(),
  });

  jest.clearAllMocks();
});
```

## Common Test Scenarios

### Testing Discord Integration
```javascript
describe('postDiscordSummaryToPod', () => {
  it('should post Discord summary to pod successfully', async () => {
    const discordSummary = {
      content: 'Test summary content',
      messageCount: 5,
      serverName: 'Test Server',
      channelName: 'general',
    };

    const result = await botService.postDiscordSummaryToPod(
      'pod123',
      discordSummary,
      'integration123',
    );

    expect(result.success).toBe(true);
    expect(PGMessage.create).toHaveBeenCalledWith(
      'pod123',
      'bot123',
      expect.stringContaining('Discord Update from #general'),
      'text',
    );
  });
});
```

### Testing Database Fallback Logic
```javascript
it('should fallback to MongoDB when PostgreSQL fails', async () => {
  // Mock PostgreSQL failure
  PGMessage.create.mockRejectedValue(new Error('PostgreSQL Error'));

  const result = await botService.postDiscordSummaryToPod(
    'pod123',
    discordSummary,
    'integration123',
  );

  expect(result.success).toBe(true);
  // Verify MongoDB fallback was used
  expect(Message).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.any(String),
      userId: 'bot123',
      podId: 'pod123',
    }),
  );
});
```

### Testing Error Conditions
```javascript
it('should return error if pod not found', async () => {
  Pod.findById.mockResolvedValue(null);

  const result = await botService.postDiscordSummaryToPod(
    'invalid-pod',
    {},
    'integration123',
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('Pod invalid-pod not found');
});
```

## Test Organization Best Practices

### Describe Block Structure
```javascript
describe('ServiceName', () => {
  describe('methodName', () => {
    it('should handle success case', async () => {
      // Test implementation
    });

    it('should handle error case', async () => {
      // Test implementation
    });

    it('should handle edge case', async () => {
      // Test implementation
    });
  });
});
```

### Mock Data Management
```javascript
// Define reusable mock data
const mockBot = {
  _id: 'bot123',
  username: 'commonly-bot',
  email: 'bot@commonly.app',
  profilePicture: 'purple',
  createdAt: new Date(),
  save: jest.fn().mockResolvedValue(true),
};

const mockPod = {
  _id: 'pod123',
  name: 'Test Pod',
  members: ['user1'],
  save: jest.fn().mockResolvedValue(true),
};
```

## Troubleshooting Common Issues

### Static Method Conversion
**Symptom**: `TypeError: [instance].[method] is not a function`
**Solution**: Update test calls to use static method syntax
```javascript
// Change from instance call
await botService.methodName(args);

// To static call
await ServiceClass.methodName(args);
```

### MongoDB Connection Issues
**Symptom**: Connection timeout or database not found
**Solution**: Ensure MongoDB Memory Server is properly set up in beforeAll/afterAll

### PostgreSQL Mock Issues
**Symptom**: pg-mem errors or connection failures
**Solution**: Verify pg-mem setup and function registration

### Jest Mock Clearing
**Symptom**: Mock state bleeding between tests
**Solution**: Always call `jest.clearAllMocks()` in beforeEach

## Test File Structure
```
backend/
├── __tests__/
│   ├── unit/
│   │   ├── services/
│   │   │   ├── commonlyBotService.test.js
│   │   │   ├── summarizerService.test.js
│   │   │   └── dailyDigestService.test.js
│   │   ├── middleware/
│   │   │   └── auth.test.js
│   │   └── utils/
│   └── integration/
│       ├── discord.test.js
│       └── database.test.js
├── services/
├── models/
└── [other directories]
```

## Performance Testing
- Database operation performance with large datasets
- Memory usage testing with MongoDB Memory Server
- Concurrent request handling
- Background job processing

## Docker Testing
```bash
# Run tests in Docker container
./dev.sh test

# Interactive testing in container
./dev.sh shell backend
npm test

# Specific test in Docker
docker exec -e NODE_ENV=test backend-dev npm test -- commonlyBotService.test.js
```

## Continuous Integration
Tests run automatically on:
- GitHub Actions on PR creation/updates
- Local development with watch mode
- Docker environment testing
- Coverage reporting integration