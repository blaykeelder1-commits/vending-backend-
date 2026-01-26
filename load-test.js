/**
 * Simple Load Test Script for IDDI Platform
 * Tests concurrent user capacity before production launch
 *
 * Usage: node load-test.js [baseUrl] [concurrentUsers] [duration]
 *
 * Examples:
 *   node load-test.js                                    # Test localhost with 50 users for 30s
 *   node load-test.js https://your-api.com 100 60       # Test production with 100 users for 60s
 */

const https = require('https');
const http = require('http');

const BASE_URL = process.argv[2] || 'http://localhost:5000';
const CONCURRENT_USERS = parseInt(process.argv[3]) || 50;
const DURATION_SECONDS = parseInt(process.argv[4]) || 30;

// Test endpoints (public ones that don't require auth)
const ENDPOINTS = [
  { method: 'GET', path: '/api/health' },
];

// Metrics
const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  responseTimes: [],
  errors: {},
  startTime: null,
  endTime: null,
};

function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const url = new URL(endpoint.path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: endpoint.method,
      timeout: 10000,
      headers: {
        'User-Agent': 'IDDI-LoadTest/1.0',
      },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const duration = Date.now() - startTime;
        metrics.totalRequests++;
        metrics.responseTimes.push(duration);

        if (res.statusCode >= 200 && res.statusCode < 400) {
          metrics.successfulRequests++;
        } else {
          metrics.failedRequests++;
          const errorKey = `HTTP ${res.statusCode}`;
          metrics.errors[errorKey] = (metrics.errors[errorKey] || 0) + 1;
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      metrics.totalRequests++;
      metrics.failedRequests++;
      const errorKey = err.code || err.message;
      metrics.errors[errorKey] = (metrics.errors[errorKey] || 0) + 1;
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      metrics.totalRequests++;
      metrics.failedRequests++;
      metrics.errors['TIMEOUT'] = (metrics.errors['TIMEOUT'] || 0) + 1;
      resolve();
    });

    req.end();
  });
}

async function simulateUser(userId, endTime) {
  while (Date.now() < endTime) {
    const endpoint = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
    await makeRequest(endpoint);
    // Small random delay between requests (100-500ms)
    await new Promise(r => setTimeout(r, 100 + Math.random() * 400));
  }
}

function calculatePercentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * (p / 100)) - 1;
  return sorted[Math.max(0, index)];
}

function printResults() {
  const duration = (metrics.endTime - metrics.startTime) / 1000;
  const avgResponseTime = metrics.responseTimes.length > 0
    ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
    : 0;

  console.log('\n' + '='.repeat(60));
  console.log('LOAD TEST RESULTS');
  console.log('='.repeat(60));
  console.log(`Target:              ${BASE_URL}`);
  console.log(`Concurrent Users:    ${CONCURRENT_USERS}`);
  console.log(`Duration:            ${duration.toFixed(1)}s`);
  console.log('-'.repeat(60));
  console.log(`Total Requests:      ${metrics.totalRequests}`);
  console.log(`Successful:          ${metrics.successfulRequests} (${(metrics.successfulRequests / metrics.totalRequests * 100).toFixed(1)}%)`);
  console.log(`Failed:              ${metrics.failedRequests} (${(metrics.failedRequests / metrics.totalRequests * 100).toFixed(1)}%)`);
  console.log(`Requests/sec:        ${(metrics.totalRequests / duration).toFixed(1)}`);
  console.log('-'.repeat(60));
  console.log('Response Times:');
  console.log(`  Average:           ${avgResponseTime.toFixed(0)}ms`);
  console.log(`  Min:               ${Math.min(...metrics.responseTimes)}ms`);
  console.log(`  Max:               ${Math.max(...metrics.responseTimes)}ms`);
  console.log(`  P50 (median):      ${calculatePercentile(metrics.responseTimes, 50)}ms`);
  console.log(`  P95:               ${calculatePercentile(metrics.responseTimes, 95)}ms`);
  console.log(`  P99:               ${calculatePercentile(metrics.responseTimes, 99)}ms`);

  if (Object.keys(metrics.errors).length > 0) {
    console.log('-'.repeat(60));
    console.log('Errors:');
    for (const [error, count] of Object.entries(metrics.errors)) {
      console.log(`  ${error}: ${count}`);
    }
  }

  console.log('='.repeat(60));

  // Assessment
  const successRate = metrics.successfulRequests / metrics.totalRequests * 100;
  const p99 = calculatePercentile(metrics.responseTimes, 99);

  console.log('\nASSESSMENT:');
  if (successRate >= 99 && p99 < 1000) {
    console.log('  PASS - Ready for production');
  } else if (successRate >= 95 && p99 < 2000) {
    console.log('  WARNING - May experience issues under peak load');
  } else {
    console.log('  FAIL - Not ready for 500 concurrent users');
  }

  if (successRate < 99) {
    console.log(`  - Success rate ${successRate.toFixed(1)}% is below 99% target`);
  }
  if (p99 > 1000) {
    console.log(`  - P99 response time ${p99}ms exceeds 1000ms threshold`);
  }
}

async function runLoadTest() {
  console.log('IDDI Load Test');
  console.log('='.repeat(60));
  console.log(`Testing: ${BASE_URL}`);
  console.log(`Concurrent users: ${CONCURRENT_USERS}`);
  console.log(`Duration: ${DURATION_SECONDS} seconds`);
  console.log('='.repeat(60));

  // Warm-up request
  console.log('\nWarming up...');
  await makeRequest(ENDPOINTS[0]);
  metrics.totalRequests = 0;
  metrics.successfulRequests = 0;
  metrics.failedRequests = 0;
  metrics.responseTimes = [];
  metrics.errors = {};

  console.log('Starting load test...\n');

  metrics.startTime = Date.now();
  const endTime = metrics.startTime + (DURATION_SECONDS * 1000);

  // Start all virtual users
  const users = [];
  for (let i = 0; i < CONCURRENT_USERS; i++) {
    users.push(simulateUser(i, endTime));
  }

  // Progress indicator
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    const rps = metrics.totalRequests / elapsed;
    process.stdout.write(`\r  Elapsed: ${elapsed.toFixed(0)}s | Requests: ${metrics.totalRequests} | RPS: ${rps.toFixed(1)} | Errors: ${metrics.failedRequests}`);
  }, 1000);

  // Wait for all users to complete
  await Promise.all(users);

  clearInterval(progressInterval);
  metrics.endTime = Date.now();

  printResults();
}

runLoadTest().catch(console.error);
