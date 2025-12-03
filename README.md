# Emask - Email Masking Service

A privacy-focused email masking and forwarding service that allows you to create unlimited email aliases to protect your real email address from spam, data breaches, and unwanted tracking.

## Features

- **Email Aliases**: Create unique email aliases that forward to your real email
- **Privacy Protection**: Keep your real email address hidden from services and websites
- **Easy Management**: Toggle aliases on/off, view statistics, and manage all your aliases from one place
- **Email Logging**: Track all forwarded emails with detailed logs
- **User Authentication**: Secure JWT-based authentication
- **Rate Limiting**: Built-in protection against abuse
- **SMTP Server**: Built-in SMTP server to receive incoming emails

## How It Works

1. **Sign up** for an account with your real email address
2. **Create aliases** like `abc123@yourdomain.com`
3. **Use aliases** when signing up for services, newsletters, etc.
4. **Receive emails** - all emails sent to your aliases are forwarded to your real email
5. **Manage aliases** - disable or delete aliases that receive spam

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- A domain with MX records pointing to your server (for receiving emails)
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

# Create database and run migrations
npm run db:push

# Start the server
npm run dev
```

### Configuration

Edit `.env` with your settings:

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL="file:./dev.db"

# JWT
JWT_SECRET=your-super-secret-key
JWT_EXPIRES_IN=7d

# Your email domain for aliases
EMAIL_DOMAIN=mask.yourdomain.com

# SMTP for receiving (your server)
SMTP_PORT=25
SMTP_HOST=0.0.0.0

# SMTP for sending (Gmail example)
SMTP_OUTBOUND_HOST=smtp.gmail.com
SMTP_OUTBOUND_PORT=587
SMTP_OUTBOUND_SECURE=false
SMTP_OUTBOUND_USER=your-email@gmail.com
SMTP_OUTBOUND_PASS=your-app-password
```

## API Reference

### Authentication

#### Sign Up
```http
POST /api/v1/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123",
  "name": "John Doe"
}
```

#### Log In
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123"
}
```

#### Get Profile
```http
GET /api/v1/auth/profile
Authorization: Bearer <token>
```

#### Change Password
```http
POST /api/v1/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentPassword": "OldPass123",
  "newPassword": "NewSecurePass456"
}
```

### Aliases

#### Create Alias
```http
POST /api/v1/aliases
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Shopping Sites",
  "description": "For online shopping accounts"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "alias": "abc12345",
    "fullAddress": "abc12345@mask.yourdomain.com",
    "label": "Shopping Sites",
    "description": "For online shopping accounts",
    "isActive": true,
    "forwardCount": 0,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
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
  "description": "Updated description",
  "isActive": true
}
```

#### Toggle Alias Active Status
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

Response:
```json
{
  "success": true,
  "data": {
    "totalAliases": 10,
    "activeAliases": 8,
    "inactiveAliases": 2,
    "totalForwarded": 150,
    "maxAliases": 50,
    "recentActivity": [...]
  }
}
```

#### Get Email Logs
```http
GET /api/v1/aliases/logs?page=1&limit=20
Authorization: Bearer <token>
```

### Health Check
```http
GET /api/v1/health
```

## Deployment

### Docker (Recommended)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build
RUN npm run db:generate

EXPOSE 3000 25

CMD ["npm", "start"]
```

### DNS Configuration

To receive emails, configure your domain's DNS:

1. Add an MX record pointing to your server:
   ```
   MX 10 mail.yourdomain.com
   ```

2. Add an A record for your mail subdomain:
   ```
   A mail.yourdomain.com -> YOUR_SERVER_IP
   ```

3. Optional: Add SPF, DKIM, and DMARC records for better deliverability

### Production Considerations

1. **Use HTTPS**: Put the API behind a reverse proxy (nginx, Caddy) with SSL
2. **Firewall**: Open ports 25 (SMTP) and 443 (HTTPS)
3. **Database**: Consider PostgreSQL or MySQL for production
4. **Backups**: Regular database backups
5. **Monitoring**: Set up logging and alerting

## Project Structure

```
emask/
├── prisma/
│   └── schema.prisma      # Database schema
├── src/
│   ├── controllers/       # Request handlers
│   ├── middleware/        # Express middleware
│   ├── routes/           # API routes
│   ├── services/         # Business logic
│   ├── types/            # TypeScript types
│   ├── utils/            # Utility functions
│   ├── app.ts            # Express app setup
│   └── server.ts         # Server entry point
├── .env.example          # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

## Security

- Passwords are hashed using bcrypt with 12 rounds
- JWT tokens expire after 7 days (configurable)
- Rate limiting prevents brute force attacks
- Input validation on all endpoints
- SQL injection protection via Prisma ORM

## License

MIT License - feel free to use this for personal or commercial projects.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
