# Testing Guide

This document provides comprehensive information about testing in the Actual-sync project.

---

## 📊 Overview

The project uses **Jest** as the testing framework with comprehensive unit and integration tests covering:
- Configuration loading and validation
- Retry logic with exponential backoff
- Sync service integration
- Startup validation

**Current Test Coverage**: 80.47% statements, 72.53% branches, 91.53% functions, 80.52% lines

---

## 🚀 Quick Start

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### Test Output

```
Test Suites: 11 passed, 11 total
Tests:       255 passed, 255 total
Snapshots:   0 total
Coverage:    80.47% statements, 72.53% branches, 91.53% functions, 80.52% lines
```

---

## 📁 Test Structure

```
src/
├── __tests__/
│   ├── helpers/
│   │   └── testHelpers.js         # Shared test utilities
│   ├── configLoader.test.js       # ConfigLoader unit tests
│   ├── retryLogic.test.js         # Retry logic unit tests
│   ├── syncService.test.js        # Sync service integration tests
│   └── startupValidation.test.js  # Startup validation tests
└── lib/
    └── configLoader.js            # Module under test
```

---

## 🧪 Test Suites

### 1. ConfigLoader Tests (`configLoader.test.js`)

**Coverage**: 98.73%  
**Tests**: 20

Tests configuration loading, validation, and error handling:

- **Constructor**: Default and custom path handling
- **load()**: File existence, JSON parsing, schema validation
- **validateConfig()**: Schema validation with AJV
- **validateLogic()**: Business rules (duplicates, required fields, security warnings)
- **getConfig()**: Configuration retrieval
- **getServer()**: Server lookup by name
- **getServers()**: All servers retrieval

**Example Test**:
```javascript
test('should throw error for duplicate server names', () => {
    const config = {
        servers: [
            { name: 'Test', url: 'https://test1.com', ... },
            { name: 'Test', url: 'https://test2.com', ... }
        ]
    };
    const loader = new ConfigLoader(configPath);
    
    expect(() => loader.validateLogic(config))
        .toThrow('Duplicate server names');
});
```

### 2. Retry Logic Tests (`retryLogic.test.js`)

**Tests**: 18

Tests exponential backoff and retry behavior:

- **Success scenarios**: First attempt, eventual success
- **Rate limit handling**: Exponential backoff, max retries
- **Network error handling**: ECONNRESET, ENOTFOUND, network-failure
- **Non-retryable errors**: Immediate failure
- **Exponential backoff**: Delay calculation validation
- **Edge cases**: Zero retries, null/undefined returns

**Example Test**:
```javascript
test('should retry with exponential backoff on rate limit', async () => {
    let attempts = 0;
    const rateLimitFn = jest.fn().mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
            const error = new Error('Rate limit exceeded');
            error.code = 'NORDIGEN_ERROR';
            error.category = 'RATE_LIMIT_EXCEEDED';
            throw error;
        }
        return Promise.resolve('success');
    });
    
    const result = await runWithRetries(rateLimitFn);
    expect(result).toBe('success');
    expect(rateLimitFn).toHaveBeenCalledTimes(3);
});
```

### 3. Sync Service Integration Tests (`syncService.test.js`)

**Tests**: 11

Tests end-to-end sync workflow with mocked Actual API:

- **Full workflow**: Init → Download → Sync → Bank Sync → Shutdown
- **Connection failures**: Authentication errors, network issues
- **Budget handling**: Download failures, sync failures
- **Account handling**: Empty lists, individual account failures
- **Cleanup**: Shutdown called even on errors

**Example Test**:
```javascript
test('should complete full sync workflow successfully', async () => {
    const server = {
        name: 'Test Server',
        url: 'https://test.example.com',
        password: 'test-password',
        syncId: 'test-sync-id',
        dataDir: '/tmp/test-data'
    };

    await syncBank(server);

    expect(actual.init).toHaveBeenCalled();
    expect(actual.downloadBudget).toHaveBeenCalled();
    expect(actual.sync).toHaveBeenCalled();
    expect(actual.runBankSync).toHaveBeenCalledTimes(2);
    expect(actual.shutdown).toHaveBeenCalled();
});
```

### 4. Startup Validation Tests (`startupValidation.test.js`)

**Tests**: 13

Tests startup environment validation:

- **Node.js version**: Version detection and validation
- **Configuration directory**: Existence checks
- **Configuration file**: Existence, readability, JSON parsing
- **Dependencies**: node_modules and critical packages
- **Schema file**: Optional schema detection
- **Integration**: Complete valid setup workflow

**Example Test**:
```javascript
test('should detect invalid JSON in config.json', () => {
    const configFile = path.join(configDir, 'config.json');
    fs.writeFileSync(configFile, '{invalid json}');
    
    expect(() => {
        const content = fs.readFileSync(configFile, 'utf8');
        JSON.parse(content);
    }).toThrow();
});
```

---

## 🛠️ Test Helpers

Located in `src/__tests__/helpers/testHelpers.js`:

### Available Utilities

```javascript
// Create temporary test directory
const tempDir = createTempDir();

// Clean up after tests
cleanupTempDir(tempDir);

// Create mock configuration object
const config = createMockConfig({ servers: [...] });

// Create mock Actual API instance
const api = createMockActualAPI();

// Create test configuration file
const configPath = createTestConfigFile(dir, config);

// Create test schema file
const schemaPath = createTestSchemaFile(dir);

// Suppress console output during tests
const { restore } = suppressConsole();

// Wait for specified time
await wait(1000); // 1 second
```

### Example Usage

```javascript
describe('My Test Suite', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        cleanupTempDir(tempDir);
    });

    test('my test', () => {
        const config = createMockConfig();
        const configPath = createTestConfigFile(tempDir, config);
        // ... test code
    });
});
```

---

## 📈 Coverage Reports

### Viewing Coverage

After running `npm run test:coverage`, open the HTML report:

```bash
# Generate coverage report
npm run test:coverage

# Open in browser (macOS)
open coverage/lcov-report/index.html

# Open in browser (Linux)
xdg-open coverage/lcov-report/index.html

# Open in browser (Windows)
start coverage/lcov-report/index.html
```

### Coverage Thresholds

Configured in `package.json`:

```json
"coverageThreshold": {
  "global": {
    "branches": 70,
    "functions": 70,
    "lines": 70,
    "statements": 70
  }
}
```

**Current Coverage** (excluding integration files):
- Statements: 98.73%
- Branches: 98.43%
- Functions: 100%
- Lines: 98.68%

### Excluded from Coverage

The following files are excluded as they are integration/orchestration code:
- `index.js` - Entry point
- `src/syncService.js` - Main service orchestration
- `src/__tests__/**` - Test files

---

## ✍️ Writing Tests

### Test File Naming

- Unit tests: `<module>.test.js`
- Integration tests: `<feature>.test.js`
- Place in `src/__tests__/` directory

### Test Structure

```javascript
const { testHelper } = require('./helpers/testHelpers');

describe('Feature Name', () => {
    beforeEach(() => {
        // Setup before each test
    });

    afterEach(() => {
        // Cleanup after each test
    });

    describe('Sub-feature', () => {
        test('should do something specific', () => {
            // Arrange
            const input = setupInput();
            
            // Act
            const result = performAction(input);
            
            // Assert
            expect(result).toBe(expected);
        });
    });
});
```

### Best Practices

1. **Descriptive names**: Use clear, descriptive test names
   ```javascript
   // Good
   test('should throw error for duplicate server names', () => {});
   
   // Bad
   test('duplicates', () => {});
   ```

2. **Arrange-Act-Assert**: Structure tests clearly
   ```javascript
   test('example', () => {
       // Arrange - Set up test data
       const input = { value: 42 };
       
       // Act - Execute the code
       const result = processInput(input);
       
       // Assert - Verify the outcome
       expect(result).toBe(84);
   });
   ```

3. **Isolation**: Each test should be independent
   ```javascript
   // Use beforeEach/afterEach for setup/cleanup
   beforeEach(() => {
       tempDir = createTempDir();
   });
   
   afterEach(() => {
       cleanupTempDir(tempDir);
   });
   ```

4. **Mock external dependencies**: Use Jest mocks
   ```javascript
   jest.mock('@actual-app/api', () => ({
       init: jest.fn().mockResolvedValue(undefined),
       sync: jest.fn().mockResolvedValue(undefined)
   }));
   ```

5. **Test edge cases**: Cover error paths
   ```javascript
   test('should handle empty input', () => {});
   test('should handle null input', () => {});
   test('should throw on invalid input', () => {});
   ```

---

## 🐛 Debugging Tests

### Run Single Test File

```bash
npm test -- configLoader.test.js
```

### Run Tests Matching Pattern

```bash
npm test -- --testNamePattern="retry"
```

### Run with Verbose Output

```bash
npm test -- --verbose
```

### Debug with VS Code

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Jest Debug",
  "program": "${workspaceFolder}/node_modules/.bin/jest",
  "args": ["--runInBand", "--no-cache"],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

---

## 🔄 Continuous Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test
      - run: npm run test:coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

---

## 📚 Additional Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Jest Matchers](https://jestjs.io/docs/expect)
- [Jest Mock Functions](https://jestjs.io/docs/mock-functions)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)

---

## 🤝 Contributing

When adding new features:

1. Write tests first (TDD) or alongside implementation
2. Ensure tests pass: `npm test`
3. Check coverage: `npm run test:coverage`
4. Maintain >70% coverage threshold
5. Update this documentation if adding new test patterns

---

**Last Updated**: December 5, 2025
