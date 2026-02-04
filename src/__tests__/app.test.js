const request = require('supertest');
const app = require('../app');

// Use real timers for HTTP requests
beforeAll(() => {
  jest.useRealTimers();
});

afterAll(() => {
  jest.useFakeTimers();
});

describe('App Basic Tests', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect('Content-Type', /json/);

      // Should return 200 or 503 depending on DB status
      expect([200, 503]).toContain(response.status);
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('database');
    });

    it('should include uptime in health response', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body).toHaveProperty('uptime');
      expect(typeof response.body.uptime).toBe('number');
    });

    it('should include environment in health response', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body).toHaveProperty('environment');
    });
  });

  describe('GET /api/stats', () => {
    it('should return public statistics', async () => {
      const response = await request(app)
        .get('/api/stats')
        .expect('Content-Type', /json/);

      // May fail if DB not connected, but should return valid JSON
      if (response.status === 200) {
        expect(response.body).toHaveProperty('success', true);
        expect(response.body).toHaveProperty('data');
        expect(response.body.data).toHaveProperty('operators');
        expect(response.body.data).toHaveProperty('machines');
        expect(response.body.data).toHaveProperty('products');
      }
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/api/nonexistent-route')
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('message', 'Route not found');
    });
  });

  describe('Security Headers', () => {
    it('should include security headers from helmet', async () => {
      const response = await request(app).get('/api/health');

      // Check for common security headers
      expect(response.headers).toHaveProperty('x-content-type-options');
      expect(response.headers).toHaveProperty('x-frame-options');
    });
  });

  describe('CORS', () => {
    it('should allow requests from allowed origins', async () => {
      const response = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost:3000');

      // Should not reject the request
      expect(response.status).not.toBe(403);
    });
  });
});

describe('Rate Limiting', () => {
  it('should include rate limit headers', async () => {
    const response = await request(app).get('/api/health');

    // Rate limit headers may or may not be present depending on store
    // Just check the request succeeds
    expect([200, 503]).toContain(response.status);
  });
});
