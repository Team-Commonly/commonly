# Frontend Testing Guide

## Current Status ✅
- **All Tests Passing**: 100/100 tests pass across 26 test suites
- **Test Coverage**: Comprehensive coverage of all React components
- **GitHub Actions**: ✅ Test & Coverage check passing

## Quick Commands
```bash
# Run all tests
cd frontend && npm test

# Run tests with coverage
cd frontend && npm run test:coverage

# Run specific test file
npm test -- --testPathPattern=WhatsHappening.test.js

# Run tests without watch mode (CI)
npm test -- --watchAll=false
```

## Test Setup and Configuration

### Jest Configuration (`package.json`)
```json
{
  "jest": {
    "moduleNameMapper": {
      "^react-markdown$": "<rootDir>/src/__mocks__/react-markdown.js",
      "^d3$": "<rootDir>/src/__mocks__/d3.js"
    }
  }
}
```

### Mock Files
- `src/__mocks__/react-markdown.js` - ES module mock for react-markdown
- `src/__mocks__/d3.js` - ES module mock for d3 with force simulation, scales

## Common Testing Patterns

### 1. Axios Mocking for API Calls
```javascript
beforeEach(() => {
  // Setup default axios mocks for all tests
  axios.get.mockImplementation((url) => {
    if (url === '/api/summaries/latest') {
      return Promise.resolve({ data: mockSummariesData });
    }
    if (url === '/api/summaries/chat-rooms?limit=3') {
      return Promise.resolve({ data: mockChatRooms });
    }
    return Promise.resolve({ data: [] });
  });
});
```

### 2. AuthContext Mocking
```javascript
jest.mock('../context/AuthContext', () => ({
  useAuth: jest.fn(),
  AuthContext: {
    _currentValue: { user: { _id: 'u', username: 'me', profilePicture: null } },
    Provider: ({ children }) => children,
    Consumer: ({ children }) => children({ user: { _id: 'u', username: 'me' } })
  }
}));
```

### 3. Router Mocking
```javascript
import { MemoryRouter } from 'react-router-dom';

const renderWithRouter = (component) => {
  return render(
    <MemoryRouter>
      {component}
    </MemoryRouter>
  );
};
```

### 4. Async Component Testing
```javascript
test('displays content when API calls succeed', async () => {
  renderWithRouter(<WhatsHappening />);

  await waitFor(() => {
    expect(screen.getByText('Community Posts Overview')).toBeInTheDocument();
    expect(screen.getByText('Chat Activity Summary')).toBeInTheDocument();
  });
});
```

### 5. Timer and Timeout Handling
```javascript
test('handles timer delays in refresh function', async () => {
  jest.useFakeTimers();

  renderWithRouter(<Component />);

  fireEvent.click(screen.getByLabelText('Refresh'));

  act(() => {
    jest.advanceTimersByTime(2000);
  });

  jest.useRealTimers();
});
```

## Recent Fixes Applied (January 2025)

### WhatsHappening.test.js Fixes
**Issues Fixed:**
- Missing `aria-label` on refresh button
- Async loading state timing issues
- API Integration test data format mismatches
- Axios mock incomplete coverage

**Solutions Applied:**
1. Added `aria-label="Refresh summaries"` to IconButton in component
2. Implemented comprehensive axios mock setup in beforeEach
3. Fixed test data types to match component expectations
4. Added proper `waitFor()` usage for async operations

### ChatRoom.test.js Fixes
**Issues Fixed:**
- DiscordIntegration component using `useContext(AuthContext)` directly
- Test only mocked `useAuth` hook, not the context itself

**Solutions Applied:**
1. Added comprehensive AuthContext mock with Provider and Consumer
2. Maintained backward compatibility with existing useAuth mock

### ES Module Compatibility
**Issues Fixed:**
- `react-markdown` and `d3` ES module parsing errors in Jest
- `SyntaxError: Unexpected token 'export'` errors

**Solutions Applied:**
1. Created Jest mocks in `src/__mocks__/` directory
2. Updated Jest moduleNameMapper configuration
3. Provided comprehensive mock implementations

## Mock File Contents

### react-markdown Mock
```javascript
import React from 'react';

const ReactMarkdown = ({ children }) => {
  return React.createElement('div', { 'data-testid': 'react-markdown' }, children);
};

export default ReactMarkdown;
```

### d3 Mock
```javascript
export const select = jest.fn(() => ({
  append: jest.fn().mockReturnThis(),
  attr: jest.fn().mockReturnThis(),
  style: jest.fn().mockReturnThis(),
  // ... more d3 methods
}));

export const forceSimulation = jest.fn(() => ({
  force: jest.fn().mockReturnThis(),
  nodes: jest.fn().mockReturnThis(),
  on: jest.fn().mockReturnThis(),
  stop: jest.fn().mockReturnThis(),
}));
```

## Troubleshooting Common Issues

### ES Module Errors
**Symptom**: `SyntaxError: Unexpected token 'export'`
**Solution**: Create mock in `src/__mocks__/` directory and add to Jest moduleNameMapper

### Async Timing Issues
**Symptom**: Tests timeout or elements not found
**Solution**: Use `waitFor()` around assertions for async operations

### Context Undefined Errors
**Symptom**: `Cannot read properties of undefined (reading '_context')`
**Solution**: Mock both the hook and the context provider/consumer

### Axios Mock Issues
**Symptom**: `Cannot read properties of undefined (reading 'catch')`
**Solution**: Ensure axios mock returns proper Promise for all expected endpoints

## Expected Console Output
When running tests, expect to see:
- React Router future flag warnings (informational)
- JSDOM navigation warnings (expected limitation)
- Intentional error logs from error state testing
- Material-UI prop warnings (non-blocking)

These are all expected and do not indicate test failures.

## Test Structure Overview
```
src/
├── __mocks__/
│   ├── react-markdown.js
│   └── d3.js
├── components/
│   ├── WhatsHappening.test.js (22 tests)
│   ├── ChatRoom.test.js (2 tests)
│   ├── PostFeed.test.js
│   └── [other component tests]
├── context/
│   ├── AuthContext.test.js
│   ├── SocketContext.integration.test.js
│   └── [other context tests]
└── utils/
    └── [utility tests]
```

## Best Practices
1. Always use `waitFor()` for async operations
2. Mock external dependencies at the module level
3. Test both success and error states
4. Use descriptive test names
5. Keep mocks simple but complete
6. Test accessibility features (aria-labels, roles)

## Browser proof for layout and focus changes

Jest has no layout engine. For a layout change, capture the actual production
build at desktop and touch/mobile widths, including intermediate breakpoints
changed by the patch. In PR #1588, 1440px and 390px passed while 900px exposed a main
pane auto-placed into a sidebar grid track whose sidebar was not rendered.

For overlapping controls, check the point a person is likely to tap. A locator
click may find an exposed edge while the centre is covered by another control.
Inspect the centre with `document.elementFromPoint`, then perform an actual
touch tap there and assert the intended state changed and the underlying
control stayed closed. PR #1588's overflow menu passed locator selection but
its centre tap opened the composer picker behind it.

Focus tests must include the app-level keyboard handlers that run in the real
page. The isolated Activity test restored Escape focus correctly, but
`setupFocusManagement` subsequently blurred that trigger. Including the real
handler reproduced the failure; consuming the menu's Escape locally fixed it.
Confirm final focus after the interaction settles in the browser as well.

Record the exact build revision and whether auth/API/writes were mocked.
Fixture success is pre-deployment proof; follow it with a live smoke of the
shipped interaction. Preserve focused CSS invariants for load-bearing rules,
without treating string presence as proof of computed layout or hit testing.
