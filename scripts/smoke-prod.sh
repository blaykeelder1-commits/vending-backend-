#!/bin/bash
set -e

API_URL="${1:-https://vending-backend-nk0m.onrender.com/api}"
TEST_EMAIL="smoke-test-vendor@example.com"
TEST_PASSWORD="SmokeTest123"
EXPECTED_DB_HOST="aws***-pooler.supabase.com"

echo "=== Production Smoke Test ==="
echo "API: $API_URL"
echo ""

# 1. Health check
echo "[1/5] Checking health endpoint..."
HEALTH=$(curl -s "$API_URL/health")
STATUS=$(echo "$HEALTH" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
if [ "$STATUS" != "ok" ]; then
  echo "❌ Health check failed:"
  echo "$HEALTH"
  exit 1
fi

# Check DB fingerprint
DB_HOST=$(echo "$HEALTH" | grep -o '"host":"[^"]*"' | cut -d'"' -f4)
MACHINES_COUNT=$(echo "$HEALTH" | grep -o '"machines_count":[0-9]*' | cut -d':' -f2)

echo "✅ Health: $STATUS"
echo "   DB Host: $DB_HOST"
echo "   Machines: $MACHINES_COUNT"

if [[ "$DB_HOST" != *"supabase.com"* ]]; then
  echo "⚠️  WARNING: DB host doesn't match expected Supabase pattern"
fi
echo ""

# 2. Vendor login
echo "[2/5] Logging in vendor..."
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
echo "[3/5] Creating test machine..."
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
echo "[4/5] Listing machines..."
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

# 5. Check admin DB info
echo "[5/5] Checking admin DB info..."
ADMIN_RESPONSE=$(curl -s "$API_URL/admin/db-info" \
  -H "Authorization: Bearer $TOKEN")

ADMIN_MACHINES=$(echo "$ADMIN_RESPONSE" | grep -o '"machines_count":[0-9]*' | cut -d':' -f2)
ADMIN_VENDORS=$(echo "$ADMIN_RESPONSE" | grep -o '"vendors_count":[0-9]*' | cut -d':' -f2)

if [ -z "$ADMIN_MACHINES" ]; then
  echo "❌ Admin endpoint failed:"
  echo "$ADMIN_RESPONSE"
  exit 1
fi
echo "✅ Admin check: machines=$ADMIN_MACHINES, vendors=$ADMIN_VENDORS"
echo ""

echo "=== ✅ All smoke tests passed ==="
