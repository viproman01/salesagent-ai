# SalesAgent AI - Deployment Guide

## GitHub Deployment

### Prerequisites
- GitHub account (https://github.com)
- Git installed on your system

### Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Enter repository name: `salesagent-ai`
3. Add description: "AI-powered sales agent platform with multi-channel support"
4. Choose visibility: Public or Private
5. Click "Create repository"

### Step 2: Push Code to GitHub

```bash
cd /Users/admin/Documents/Проекты\ /Вайбкодинг/salesagent-ai

# Add remote (replace YOUR_USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR_USERNAME/salesagent-ai.git
git branch -M main
git push -u origin main
```

## Vercel Deployment

### Frontend (React Admin App)

The React admin dashboard (located in the `admin/` folder) can be deployed to Vercel:

1. Go to https://vercel.com/new
2. Connect your GitHub account
3. Import the `salesagent-ai` repository
4. Configure project:
   - **Project Name**: salesagent-admin
   - **Framework**: Vite
   - **Root Directory**: `./admin`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`

5. Add Environment Variables:
   ```
   VITE_API_BASE_URL=https://your-backend-url.com
   ```

6. Click "Deploy"

### Backend (Node.js/Express)

The backend can be deployed to various platforms:

#### Option A: Railway.app (Recommended for Node.js)

1. Go to https://railway.app
2. Click "New Project"
3. Connect GitHub repository
4. Configure environment variables (copy from .env.example)
5. Deploy

#### Option B: Render.com

1. Go to https://render.com
2. Create new Web Service
3. Connect GitHub repository
4. Configure:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Environment: Node
5. Add environment variables from .env.example
6. Deploy

#### Option C: AWS EC2 with Docker

```bash
# Build Docker image
docker build -t salesagent-ai .

# Run container
docker run -d \
  --name salesagent-ai \
  -p 3002:3002 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/salesagent \
  -e REDIS_URL=redis://host:6379 \
  salesagent-ai
```

## Docker Deployment

### Local Development with Docker Compose

```bash
# Start all services (PostgreSQL, Redis, MinIO, App)
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop services
docker-compose down
```

### Production Deployment

Create a `.env` file with production values:

```bash
# Database
DATABASE_URL=postgresql://user:password@postgres.example.com:5432/salesagent
POSTGRES_PASSWORD=your_secure_password

# Redis
REDIS_URL=redis://redis.example.com:6379

# S3/MinIO Storage
S3_BUCKET=salesagent-recordings
S3_ENDPOINT=https://minio.example.com
S3_ACCESS_KEY=your_access_key
S3_SECRET_KEY=your_secret_key

# AI APIs
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=your_google_api_key

# Messaging Platforms
WHATSAPP_API_URL=https://api.wazzup24.com
WHATSAPP_API_KEY=your_wazzup24_key
TELEGRAM_BOT_TOKEN=your_telegram_token

# Voice
VOXIMPLANT_API_ACCOUNT_ID=your_account_id
VOXIMPLANT_API_KEY=your_api_key

# CRM
AMOCRM_BASE_URL=https://your-account.amocrm.ru
AMOCRM_CLIENT_ID=your_client_id
AMOCRM_CLIENT_SECRET=your_client_secret

# Admin
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
JWT_SECRET=your_jwt_secret

# Application
NODE_ENV=production
PORT=3002
DEMO_MODE=false
```

## Post-Deployment Steps

1. **Database Migration**
   ```bash
   npm run migrate
   ```

2. **Seed Demo Data** (optional)
   ```bash
   npm run seed
   ```

3. **Configure Webhooks**
   - WhatsApp: Update webhook URL in Wazzup24 dashboard
   - Telegram: Update webhook URL: `/telegram/webhook`
   - Voice: Configure Voximplant scenario with your endpoint

4. **Test Integration**
   - Visit admin dashboard at your deployed URL
   - Send test message through any channel
   - Verify message appears in Conversations page
   - Check agent response

## Troubleshooting

### Database Connection Issues
- Ensure PostgreSQL is accessible from deployment environment
- Check DATABASE_URL format: `postgresql://user:password@host:5432/dbname`
- Verify pgvector extension is enabled: `CREATE EXTENSION IF NOT EXISTS vector;`

### Missing Environment Variables
- All variables in `.env.example` must be set in production
- Use deployment platform's environment variable UI (Vercel, Railway, Render)

### API Key Errors
- Verify all third-party API keys are valid
- Check that APIs have appropriate permissions/scopes
- Ensure APIs are not rate-limited

### WebSocket Connection Issues
- Check firewall rules allow WebSocket connections
- Verify WebSocket URLs are properly configured in frontend

## Monitoring

### Health Check
```bash
curl https://your-app-url/health
```

### View Logs
- Vercel: Dashboard → Deployments → Logs
- Railway: Railway dashboard → Logs
- Render: Service dashboard → Logs

## Updates and Rollback

### Push Updates
```bash
git add .
git commit -m "Feature: Add new functionality"
git push origin main
```

### Automatic Redeployment
- Vercel: Automatically redeploys on push to main
- Railway/Render: Configure auto-deployment in dashboard

### Rollback
- Revert commit: `git revert <commit-hash>`
- Redeploy from previous deployment in platform dashboard
