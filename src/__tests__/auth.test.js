const request = require('supertest');
const app = require('../app');
const jwt = require('jsonwebtoken');

// Use real timers for HTTP requests
beforeAll(() => {
  jest.useRealTimers();
});

afterAll(() => {
  jest.useFakeTimers();
});

describe('Auth Routes', () => {
  describe('POST /api/auth/vendor/login', () => {
    it('should reject login with missing credentials', async () => {
      const response = await request(app)
        .post('/api/auth/vendor/login')
        .send({})
        .expect('Content-Type', /json/);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject login with invalid email format', async () => {
      const response = await request(app)
        .post('/api/auth/vendor/login')
        .send({
          email: 'invalid-email',
          password: 'password123'
        })
        .expect('Content-Type', /json/);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject login with short password', async () => {
      const response = await request(app)
        .post('/api/auth/vendor/login')
        .send({
          email: 'test@example.com',
          password: '123'
        })
        .expect('Content-Type', /json/);

      // May return 400 (validation) or 401 (invalid credentials) depending on implementation
      expect([400, 401]).toContain(response.status);
      expect(response.body).toHaveProperty('success', false);
    });
  });

  describe('POST /api/auth/vendor/register', () => {
    it('should reject registration with missing fields', async () => {
      const response = await request(app)
        .post('/api/auth/vendor/register')
        .send({})
        .expect('Content-Type', /json/);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject registration with invalid email', async () => {
      const response = await request(app)
        .post('/api/auth/vendor/register')
        .send({
          email: 'not-an-email',
          password: 'ValidPassword123!',
          fullName: 'Test User'
        })
        .expect('Content-Type', /json/);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject registration with weak password', async () => {
      const response = await request(app)
        .post('/api/auth/vendor/register')
        .send({
          email: 'test@example.com',
          password: '123',
          fullName: 'Test User'
        })
        .expect('Content-Type', /json/);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should reject refresh with missing token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({})
        .expect('Content-Type', /json/);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject refresh with invalid token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid-token' })
        .expect('Content-Type', /json/);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('success', false);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should handle logout without token gracefully', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .send({})
        .expect('Content-Type', /json/);

      // Should either succeed or fail gracefully
      expect([200, 400, 401]).toContain(response.status);
    });
  });
});

describe('Protected Routes', () => {
  describe('GET /api/vendor/machines', () => {
    it('should reject requests without auth token', async () => {
      const response = await request(app)
        .get('/api/vendor/machines')
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject requests with invalid token', async () => {
      const response = await request(app)
        .get('/api/vendor/machines')
        .set('Authorization', 'Bearer invalid-token')
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toHaveProperty('success', false);
    });

    it('should reject requests with expired token', async () => {
      // Create an expired token
      const expiredToken = jwt.sign(
        { userId: 1, role: 'vendor' },
        process.env.JWT_SECRET,
        { expiresIn: '-1h' }
      );

      const response = await request(app)
        .get('/api/vendor/machines')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toHaveProperty('success', false);
    });
  });
});
