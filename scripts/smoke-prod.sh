#!/bin/bash
set -e

API_URL="${1:-https://vending-backend-nk0m.onrender.com/api}"
TEST_EMAIL="smoke-test-vendor@example.com"
TEST_PASSWORD="SmokeTest123!"

echo "=== Production Smoke Test ==="
echo "API: $API_URL"
echo ""

# 1. Health check
echo "[1/4] Checking health endpoint..."
HEALTH=$(curl -s "$API_URL/health")
STATUS=$(echo "$HEALTH" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
if [ "$STATUS" != "ok" ]; then
  echo "❌ Health check failed:"
  echo "$HEALTH"
  exit 1
fi
echo "✅ Health: $STATUS"
echo ""

# 2. Vendor login
echo "[2/4] Logging in vendor..."
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/auth/vendor/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "❌ Login failed:"
  echo "$LOGIN_RESPONSE"
  exit 1
fi
echo "✅ Login successful"
echo ""

# 3. Create machine
echo "[3/4] Creating test machine..."
MACHINE_NAME="Smoke Test $(date +%s)"
CREATE_RESPONSE=$(curl -s -X POST "$API_URL/vendor/machines" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"machineName\":\"$MACHINE_NAME\",\"location\":\"Test Location\"}")

MACHINE_ID=$(echo "$CREATE_RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)
if [ -z "$MACHINE_ID" ]; then
  echo "❌ Machine creation failed:"
  echo "$CREATE_RESPONSE"
  exit 1
fi
echo "✅ Machine created: ID=$MACHINE_ID"
echo ""

# 4. List machines
echo "[4/4] Listing machines..."
LIST_RESPONSE=$(curl -s "$API_URL/vendor/machines" \
  -H "Authorization: Bearer $TOKEN")

COUNT=$(echo "$LIST_RESPONSE" | grep -o '"count":[0-9]*' | cut -d':' -f2)
if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
  echo "❌ List machines failed:"
  echo "$LIST_RESPONSE"
  exit 1
fi
echo "✅ Machines listed: count=$COUNT"
echo ""

echo "=== ✅ All smoke tests passed ==="
