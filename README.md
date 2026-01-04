# Vending Machine Backend API

Backend server for the vending machine management platform with customer and vendor portals.

## Tech Stack

- Node.js + Express
- PostgreSQL
- JWT Authentication
- QR Code Generation
- Google Sheets API Integration

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Database Setup

Create a PostgreSQL database:

```bash
createdb vending_db
```

Or using psql:

```sql
CREATE DATABASE vending_db;
```

### 3. Environment Variables

Copy `.env.example` to `.env` and update with your values:

```bash
cp .env.example .env
```

Required environment variables:
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT tokens
- `QR_ENCRYPTION_KEY` - 32-character key for QR code encryption
- `FRONTEND_URL` - URL of the React frontend (for CORS)

### 4. Run Database Migrations

Run all migration files in order:

```bash
psql -U your_username -d vending_db -f src/database/migrations/001_create_users.sql
psql -U your_username -d vending_db -f src/database/migrations/002_create_vending_machines.sql
psql -U your_username -d vending_db -f src/database/migrations/003_create_products.sql
psql -U your_username -d vending_db -f src/database/migrations/004_create_machine_products.sql
psql -U your_username -d vending_db -f src/database/migrations/005_create_customer_sessions.sql
psql -U your_username -d vending_db -f src/database/migrations/006_create_discount_codes.sql
psql -U your_username -d vending_db -f src/database/migrations/007_create_rebates.sql
psql -U your_username -d vending_db -f src/database/migrations/008_create_loyalty_points.sql
psql -U your_username -d vending_db -f src/database/migrations/009_create_polls.sql
psql -U your_username -d vending_db -f src/database/migrations/010_create_poll_options.sql
psql -U your_username -d vending_db -f src/database/migrations/011_create_poll_votes.sql
```

Or use the DATABASE_URL directly:

```bash
psql $DATABASE_URL -f src/database/migrations/001_create_users.sql
# repeat for all migrations
```

### 5. Start the Server

Development mode (with auto-reload):

```bash
npm run dev
```

Production mode:

```bash
npm start
```

The server will start on `http://localhost:5000`

## API Endpoints

### Health Check
- `GET /api/health` - Server health status

### Authentication (Coming in Phase 2)
- `POST /api/auth/vendor/register` - Vendor registration
- `POST /api/auth/vendor/login` - Vendor login
- `POST /api/auth/customer/qr-login` - Customer QR-based login

### Vendor Routes (Coming in Phase 3)
- `/api/vendor/machines` - Machine management
- `/api/vendor/products` - Product management
- `/api/vendor/discounts` - Discount code management
- `/api/vendor/polls` - Poll management
- `/api/vendor/rebates` - Rebate approval
- `/api/vendor/inventory` - Google Sheets integration

### Customer Routes (Coming in Phase 4)
- `/api/customer/polls` - View and vote on polls
- `/api/customer/rebates` - Submit rebate requests
- `/api/customer/loyalty` - View loyalty points
- `/api/customer/profile` - Update profile and payment info

## Project Structure

```
vending-backend/
├── src/
│   ├── config/          # Configuration files (database, auth)
│   ├── middleware/      # Express middleware (auth, validation)
│   ├── models/          # Database models
│   ├── routes/          # API route handlers
│   ├── services/        # Business logic services
│   ├── utils/           # Helper utilities
│   ├── database/
│   │   └── migrations/  # SQL migration files
│   ├── app.js           # Express app setup
│   └── server.js        # Server entry point
├── uploads/             # Local file storage (dev)
├── .env                 # Environment variables (not in git)
├── .env.example         # Environment template
└── package.json
```

## Database Schema

11 core tables:
1. `users` - Both customers and vendors
2. `vending_machines` - Vending machine records with QR codes
3. `products` - Product catalog
4. `machine_products` - Inventory per machine
5. `customer_sessions` - QR-based authentication sessions
6. `discount_codes` - Vendor-created discount codes
7. `rebates` - Customer rebate requests
8. `loyalty_points` - Customer loyalty points
9. `polls` - Product preference polls
10. `poll_options` - Poll choices
11. `poll_votes` - Customer votes

## Development

The backend is being developed in phases:

- ✅ Phase 1: Foundation & Database (Current)
- Phase 2: Authentication System
- Phase 3: Vendor Portal APIs
- Phase 4: Customer Portal APIs
- Phase 5: Discount & Rebate System
- Phase 6: Loyalty Points
- Phase 7: Product Polls
- Phase 8: Google Sheets Integration
- Phase 9: Analytics & Dashboard
- Phase 10: Polish & Deployment

## Testing

```bash
npm test
```

## License

ISC
