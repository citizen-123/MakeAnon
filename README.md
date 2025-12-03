# Emask - Email Masking Service

A production-ready, privacy-focused email masking and forwarding service that allows users to create unlimited email aliases to protect their real email addresses from spam, data breaches, and unwanted tracking.

## Features

### Core Features
- **Public Alias Creation**: Create aliases without an account - just provide your email and get an alias
- **Private Aliases**: Create an account for enhanced alias management
- **Multiple Domains**: Support for multiple email domains
- **Email Forwarding**: All emails sent to aliases are forwarded to the real email
- **Reply-Through-Alias**: Reply to emails without revealing your real address

### Privacy & Security
- **Email Verification**: Verify destination emails before aliases become active
- **Blocked Senders**: Block specific senders or patterns per alias
- **Management Tokens**: Secure token-based management for public aliases
- **Rate Limiting**: Redis-backed rate limiting per email and alias

### Administration
- **Admin Panel API**: Full admin dashboard with user and alias management
- **Domain Management**: Add, configure, and manage multiple email domains
- **Webhook Notifications**: Real-time notifications for email events
- **Email Logs**: Comprehensive logging of all email activity

### Performance
- **Redis Caching**: Fast alias lookups and rate limiting
- **Connection Pooling**: Efficient SMTP connection management
- **PostgreSQL**: Production-ready database

## How It Works

### Public Aliases (No Account Required)
1. **Create an alias** by providing your real email address
2. **Verify your email** via the verification link sent to you
3. **Use your alias** when signing up for services, newsletters, etc.
4. **Manage your alias** using the management link sent to your email
5. **Block senders** that send unwanted emails

### Private Aliases (Account Required)
1. **Sign up** for an account with your email address
2. **Create multiple aliases** with labels and descriptions
3. **Manage all aliases** from a single dashboard
4. **View statistics** and email logs
5. **Set up webhooks** for real-time notifications

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+ (optional but recommended)
- A domain with MX records pointing to your server
- SMTP credentials for outbound email (Gmail, SendGrid, Mailgun, etc.)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/emask.git
cd emask

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your configuration
nano .env

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:push

# Start development server
npm run dev

# Or start production server
npm run build && npm start
```

### Configuration

Key environment variables in `.env`:

```env
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# Database (PostgreSQL)
DATABASE_URL="postgresql://user:password@localhost:5432/emask"

# Redis (optional but recommended)
REDIS_URL="redis://localhost:6379"

# JWT Authentication
JWT_SECRET=your-super-secret-key-min-32-chars
JWT_EXPIRES_IN=7d

# Email Domains (comma-separated)
EMAIL_DOMAINS=mask.example.com,alias.example.com

# SMTP for Receiving
SMTP_PORT=25
SMTP_HOST=0.0.0.0

# SMTP for Sending (Gmail example)
SMTP_OUTBOUND_HOST=smtp.gmail.com
SMTP_OUTBOUND_PORT=587
SMTP_OUTBOUND_USER=your-email@gmail.com
SMTP_OUTBOUND_PASS=your-app-password
SMTP_FROM_ADDRESS=noreply@example.com
SMTP_FROM_NAME=Emask

# Rate Limiting
RATE_LIMIT_PER_MINUTE=60
ALIAS_RATE_LIMIT_PER_DAY=10
FORWARD_LIMIT_PER_MINUTE=30

# Verification
VERIFICATION_TOKEN_EXPIRES_HOURS=24
```

See `.env.example` for the complete list of configuration options.

## API Reference

### Public Endpoints (No Authentication)

#### Create Public Alias
```http
POST /api/v1/public/alias
Content-Type: application/json

{
  "destinationEmail": "your-real@email.com",
  "domainId": "optional-domain-uuid",
  "label": "Shopping Sites"
}
```

Response:
```json
{
  "success": true,
  "message": "Alias created. Please verify your email.",
  "data": {
    "id": "uuid",
    "alias": "abc12345",
    "fullAddress": "abc12345@mask.example.com",
    "destinationEmail": "your-real@email.com",
    "emailVerified": false,
    "isActive": true,
    "label": "Shopping Sites"
  }
}
```

#### Verify Email
```http
GET /api/v1/public/verify/:token
```

#### Manage Alias (with Management Token)
```http
GET /api/v1/public/manage/:managementToken
PUT /api/v1/public/manage/:managementToken
DELETE /api/v1/public/manage/:managementToken
```

#### Block Sender
```http
POST /api/v1/public/manage/:managementToken/block
Content-Type: application/json

{
  "email": "spammer@example.com",
  "isPattern": false
}
```

#### Resend Verification Email
```http
POST /api/v1/public/resend-verification
Content-Type: application/json

{
  "aliasId": "uuid"
}
```

#### List Available Domains
```http
GET /api/v1/domains
```

### Authentication Endpoints

#### Sign Up (Optional Password)
```http
POST /api/v1/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "optional-password",
  "name": "John Doe"
}
```

#### Log In
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your-password"
}
```

#### Get Profile
```http
GET /api/v1/auth/profile
Authorization: Bearer <token>
```

### Private Alias Endpoints (Authentication Required)

#### Create Private Alias
```http
POST /api/v1/aliases
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Newsletter Subscriptions",
  "description": "For email newsletters",
  "domainId": "optional-domain-uuid"
}
```

#### List Aliases
```http
GET /api/v1/aliases?page=1&limit=20&sortBy=createdAt&sortOrder=desc
Authorization: Bearer <token>
```

#### Get Alias Details
```http
GET /api/v1/aliases/:id
Authorization: Bearer <token>
```

#### Update Alias
```http
PUT /api/v1/aliases/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Updated Label",
  "isActive": true,
  "replyEnabled": true
}
```

#### Toggle Alias
```http
POST /api/v1/aliases/:id/toggle
Authorization: Bearer <token>
```

#### Delete Alias
```http
DELETE /api/v1/aliases/:id
Authorization: Bearer <token>
```

#### Get Statistics
```http
GET /api/v1/aliases/stats
Authorization: Bearer <token>
```

#### Get Email Logs
```http
GET /api/v1/aliases/logs?page=1&limit=50
Authorization: Bearer <token>
```

### Admin Endpoints (Admin Authentication Required)

#### Dashboard Statistics
```http
GET /api/v1/admin/dashboard
Authorization: Bearer <admin-token>
```

#### List All Users
```http
GET /api/v1/admin/users?page=1&limit=20
Authorization: Bearer <admin-token>
```

#### List All Aliases
```http
GET /api/v1/admin/aliases?page=1&limit=20
Authorization: Bearer <admin-token>
```

#### Get System Email Logs
```http
GET /api/v1/admin/logs?page=1&limit=100
Authorization: Bearer <admin-token>
```

#### Cleanup Expired Data
```http
POST /api/v1/admin/cleanup
Authorization: Bearer <admin-token>
```

### Domain Management (Admin Only)

#### List Domains
```http
GET /api/v1/domains
```

#### Create Domain
```http
POST /api/v1/domains
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "domain": "newalias.example.com",
  "isDefault": false
}
```

#### Update Domain
```http
PUT /api/v1/domains/:id
Authorization: Bearer <admin-token>
```

#### Delete Domain
```http
DELETE /api/v1/domains/:id
Authorization: Bearer <admin-token>
```

### Health Check
```http
GET /api/v1/health
```

## Webhooks

Set up webhooks to receive real-time notifications about email events.

### Webhook Events
- `email.forwarded` - Email successfully forwarded
- `email.blocked` - Email blocked (sender blocked, inactive alias, etc.)
- `email.failed` - Email forwarding failed
- `alias.created` - New alias created
- `alias.deleted` - Alias deleted
- `alias.verified` - Alias email verified

### Webhook Payload Example
```json
{
  "event": "email.forwarded",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "data": {
    "aliasId": "uuid",
    "alias": "abc12345@mask.example.com",
    "from": "sender@example.com",
    "subject": "Hello World"
  }
}
```

## Deployment

### Docker Compose (Recommended)

```yaml
version: '3.8'

services:
  emask:
    build: .
    ports:
      - "3000:3000"
      - "25:25"
    environment:
      - DATABASE_URL=postgresql://emask:password@postgres:5432/emask
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=emask
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=emask
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### DNS Configuration

Configure your domain's DNS records:

1. **MX Record** (for receiving emails):
   ```
   MX 10 mail.yourdomain.com
   ```

2. **A Record** (for your mail server):
   ```
   A mail.yourdomain.com -> YOUR_SERVER_IP
   ```

3. **SPF Record** (for email deliverability):
   ```
   TXT @ "v=spf1 ip4:YOUR_SERVER_IP ~all"
   ```

4. **DKIM Record** (optional, for better deliverability):
   Configure DKIM signing in your SMTP settings

5. **DMARC Record** (optional):
   ```
   TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"
   ```

### Production Checklist

- [ ] Use HTTPS (nginx/Caddy as reverse proxy)
- [ ] Configure firewall (open ports 25, 443)
- [ ] Set up PostgreSQL with proper credentials
- [ ] Configure Redis for caching
- [ ] Set strong JWT_SECRET (32+ characters)
- [ ] Configure SMTP credentials
- [ ] Set up DNS records (MX, SPF, DKIM, DMARC)
- [ ] Enable log rotation
- [ ] Set up monitoring and alerting
- [ ] Configure regular database backups
- [ ] Set rate limits appropriate for your scale

## Project Structure

```
emask/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── controllers/           # Request handlers
│   │   ├── aliasController.ts
│   │   ├── authController.ts
│   │   ├── domainController.ts
│   │   └── verifyController.ts
│   ├── middleware/
│   │   ├── auth.ts            # JWT authentication
│   │   └── rateLimiter.ts     # Rate limiting
│   ├── routes/
│   │   ├── adminRoutes.ts     # Admin endpoints
│   │   ├── aliasRoutes.ts     # Private alias endpoints
│   │   ├── authRoutes.ts      # Authentication
│   │   ├── domainRoutes.ts    # Domain management
│   │   └── publicRoutes.ts    # Public endpoints
│   ├── services/
│   │   ├── database.ts        # Prisma client
│   │   ├── domainService.ts   # Domain logic
│   │   ├── emailService.ts    # Email sending
│   │   ├── redis.ts           # Redis caching
│   │   ├── smtpServer.ts      # SMTP server
│   │   ├── verificationService.ts
│   │   └── webhookService.ts  # Webhooks
│   ├── types/
│   │   └── index.ts           # TypeScript types
│   ├── utils/
│   │   ├── helpers.ts         # Utility functions
│   │   └── logger.ts          # Winston logger
│   ├── app.ts                 # Express app
│   └── server.ts              # Entry point
├── .env.example               # Environment template
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

## Security

- Passwords hashed with bcrypt (12 rounds)
- JWT tokens with configurable expiry
- Redis-backed rate limiting
- Email verification required for aliases
- Input validation on all endpoints
- SQL injection protection via Prisma ORM
- Secure management tokens for public aliases
- Blocked sender lists with pattern matching

## License

MIT License - feel free to use this for personal or commercial projects.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
