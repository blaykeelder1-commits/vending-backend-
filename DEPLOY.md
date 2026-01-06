# Deployment Checklist

## Required Environment Variables

### Vercel (Frontend)
- `REACT_APP_API_URL` = `https://vending-backend-nk0m.onrender.com/api`

### Render (Backend)
- `NODE_ENV` = `production`
- `FRONTEND_URL` = `https://vending-front-end.vercel.app`
- `JWT_SECRET` = (secure random string)
- `DATABASE_URL` = (Supabase PostgreSQL connection string)
- `QR_ENCRYPTION_KEY` = (32-character key)

## Pre-Deploy Checklist

1. ✅ All tests pass locally
2. ✅ Backend builds: `cd vending-backend && npm install`
3. ✅ Frontend builds: `cd my-react-app && npm run build`
4. ✅ No secrets committed to git
5. ✅ Database migrations added to `src/database/migrations/`

## Deploy Steps

### Backend (Render)

```bash
cd IDDI/vending-backend
git add .
git commit -m "Deploy: <description>"
git push
```

Wait 2-3 minutes for Render auto-deploy.

### Frontend (Vercel)

```bash
cd IDDI/my-react-app
git add .
git commit -m "Deploy: <description>"
git push
```

Vercel auto-deploys on push to main.

## Post-Deploy Verification

### 1. Health Check

```bash
curl https://vending-backend-nk0m.onrender.com/api/health
```

Expected response:
```json
{
  "status": "ok",
  "database": "connected",
  "environment_variables": "ok"
}
```

### 2. Run Smoke Test

```bash
cd IDDI/vending-backend
bash scripts/smoke-prod.sh
```

Expected output:
```
=== Production Smoke Test ===
[1/4] Checking health endpoint...
✅ Health: ok
[2/4] Logging in vendor...
✅ Login successful
[3/4] Creating test machine...
✅ Machine created: ID=123
[4/4] Listing machines...
✅ Machines listed: count=5
=== ✅ All smoke tests passed ===
```

### 3. Manual Verification

1. Open `https://vending-front-end.vercel.app/vendor/login`
2. Login with test credentials
3. Create a machine
4. Verify QR code appears
5. Download PDF
6. Open customer portal: `https://vending-front-end.vercel.app/customer/login`
7. Login/register customer
8. Visit `/customer/discount-hub`

## Rollback Procedure

### Backend
1. Go to https://dashboard.render.com
2. Select `vending-backend`
3. Click "Events" tab
4. Find previous successful deploy
5. Click "Redeploy"

### Frontend
1. Go to https://vercel.com/dashboard
2. Select `vending-front-end`
3. Click "Deployments"
4. Find previous deployment
5. Click "..." → "Redeploy"

## Common Issues

### "Error login" on frontend
- Check CORS: `FRONTEND_URL` set correctly on Render
- Check API URL: `REACT_APP_API_URL` set correctly on Vercel

### "Error creating machine"
- Check database migration ran: `npm run migrate` on Render Shell
- Check `qr_token` column exists in `vending_machines` table

### 500 errors
- Check Render logs: Dashboard → Logs tab
- Check health endpoint for missing env vars
