// Test setup file
require('dotenv').config();

// Use fake timers to prevent setInterval from blocking tests
jest.useFakeTimers();

// Mock uuid module before other imports
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-' + Math.random().toString(36).substring(7),
}));

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only-12345';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-token-secret-for-testing';
process.env.QR_ENCRYPTION_KEY = 'test1234567890123456789012';

// Suppress console logs during tests unless debugging
if (process.env.DEBUG !== 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    // Keep error for debugging failed tests
    error: console.error,
  };
}

// Global test timeout
jest.setTimeout(10000);

// Clean up after all tests
afterAll(async () => {
  // Add any global cleanup here
});
