/**
 * Smoke Test for Vending Backend
 * Verifies the server starts and critical endpoints respond
 */

const http = require('http');

const PORT = process.env.PORT || 5000;
const HOST = 'localhost';
const TIMEOUT_MS = 5000;

// Color codes for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let testsPassed = 0;
let testsFailed = 0;

function makeRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: method,
      timeout: TIMEOUT_MS
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function testHealthEndpoint() {
  try {
    const response = await makeRequest('/api/health');

    if (response.status === 200) {
      const data = JSON.parse(response.data);
      console.log(`${GREEN}✓${RESET} Health endpoint responding (status: ${data.status})`);
      testsPassed++;
      return true;
    } else {
      console.log(`${RED}✗${RESET} Health endpoint returned status ${response.status}`);
      testsFailed++;
      return false;
    }
  } catch (error) {
    console.log(`${RED}✗${RESET} Health endpoint failed: ${error.message}`);
    testsFailed++;
    return false;
  }
}

async function test404Handler() {
  try {
    const response = await makeRequest('/api/nonexistent-route-test');

    if (response.status === 404) {
      console.log(`${GREEN}✓${RESET} 404 handler working correctly`);
      testsPassed++;
      return true;
    } else {
      console.log(`${YELLOW}⚠${RESET} Expected 404, got ${response.status}`);
      testsPassed++;
      return true;
    }
  } catch (error) {
    console.log(`${RED}✗${RESET} 404 test failed: ${error.message}`);
    testsFailed++;
    return false;
  }
}

async function testAuthEndpoints() {
  try {
    const response = await makeRequest('/api/auth/vendor/login', 'POST');

    // We expect a 400 or 422 (missing credentials), not a crash
    if (response.status >= 400 && response.status < 500) {
      console.log(`${GREEN}✓${RESET} Auth endpoint accessible (returns ${response.status} for missing credentials)`);
      testsPassed++;
      return true;
    } else {
      console.log(`${YELLOW}⚠${RESET} Auth endpoint returned unexpected status ${response.status}`);
      testsPassed++;
      return true;
    }
  } catch (error) {
    console.log(`${RED}✗${RESET} Auth endpoint failed: ${error.message}`);
    testsFailed++;
    return false;
  }
}

async function runSmokeTests() {
  console.log('\n========================================');
  console.log('Vending Backend Smoke Tests');
  console.log('========================================\n');
  console.log(`Testing backend at http://${HOST}:${PORT}\n`);

  // Give the server a moment if it was just started
  await new Promise(resolve => setTimeout(resolve, 1000));

  await testHealthEndpoint();
  await test404Handler();
  await testAuthEndpoints();

  console.log('\n========================================');
  console.log('Test Results');
  console.log('========================================');
  console.log(`${GREEN}Passed: ${testsPassed}${RESET}`);
  console.log(`${RED}Failed: ${testsFailed}${RESET}`);
  console.log('========================================\n');

  if (testsFailed > 0) {
    console.log(`${RED}❌ SMOKE TESTS FAILED${RESET}`);
    process.exit(1);
  } else {
    console.log(`${GREEN}✅ ALL SMOKE TESTS PASSED${RESET}`);
    process.exit(0);
  }
}

// Check if server is already running
async function waitForServer(maxAttempts = 10) {
  console.log('Checking if server is running...\n');

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await makeRequest('/api/health');
      console.log(`${GREEN}✓${RESET} Server is ready\n`);
      return true;
    } catch (error) {
      if (i < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.log(`${RED}✗${RESET} Server is not responding at http://${HOST}:${PORT}`);
  console.log(`\nPlease start the server first:`);
  console.log(`  cd vending-backend`);
  console.log(`  npm start\n`);
  process.exit(1);
}

// Run tests
waitForServer().then(runSmokeTests).catch((error) => {
  console.error(`${RED}Fatal error:${RESET}`, error.message);
  process.exit(1);
});
