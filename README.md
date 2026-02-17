# MakeAnon - Email Masking Service

A privacy-focused email masking service that lets you create email aliases to protect your real address from spam and data breaches. No account required.

## Live Service

| Service | URL |
|---------|-----|
| **Web App** | https://makeanon.info |
| **API** | https://api.makeanon.info |
| **API Docs** | https://makeanon.info/api/docs |

### Available Domains

- `@makeanon.info`
- `@makeanon.xyz`
- `@iamanon.lol`

## How It Works

1. **Create an alias** - Enter your real email and get a random or custom alias
2. **Verify your email** - Click the verification link (aliases auto-delete after 72 hours if unverified)
3. **Use your alias** - Give it out to websites, newsletters, etc.
4. **Manage via token** - Use the management link to disable, delete, or block senders

All emails sent to your alias are forwarded to your real address. Your real email is never exposed.

## Features

- **No account required** - Create and manage aliases with just your email
- **Encryption at rest** - Destination emails are encrypted with AES-256-GCM; plaintext is never stored in the database
- **Multiple domains** - Choose from several alias domains
- **Custom aliases** - Pick your own alias name or get a random one
- **DKIM signing** - Outbound emails are DKIM-signed via Haraka for deliverability
- **Sender blocking** - Block specific senders per alias
- **Rate limiting** - Protection against abuse
- **Auto-cleanup** - Unverified aliases deleted after 72 hours, disabled aliases after 30 days

## API

### Create Alias

```http
POST /api/v1/alias
Content-Type: application/json

{
  "destinationEmail": "your@email.com",
  "customAlias": "myalias",       // optional
  "domainId": "uuid",             // optional
  "label": "Shopping"             // optional
}
```

### Verify Email

```http
GET /api/v1/verify/:token
```

### Manage Alias

```http
GET    /api/v1/manage/:token     # Get alias details
PUT    /api/v1/manage/:token     # Update alias
DELETE /api/v1/manage/:token     # Delete alias
```

### Block/Unblock Senders

```http
POST   /api/v1/manage/:token/block              # Block sender
DELETE /api/v1/manage/:token/block/:senderId    # Unblock sender
```

### Other Endpoints

```http
GET /api/v1/domains              # List available domains
GET /api/v1/health               # Health check
GET /api/v1/stats                # Global statistics
POST /api/v1/management-link     # Request management link resend
```

## Self-Hosting

### Docker (Recommended)

The easiest way to deploy MakeAnon is with Docker Compose. The stack includes:

- **App** - Node.js API + inbound SMTP server
- **Haraka** - Outbound SMTP relay with DKIM signing
- **PostgreSQL** - Database with encrypted email storage
- **Redis** - Caching and rate limiting
- **Caddy** - Reverse proxy with automatic HTTPS (optional)

```bash
git clone https://github.com/citizen-123/MakeAnon.git
cd MakeAnon

# Configure environment
cp .env.docker.example .env
# Edit .env with your settings (see Required Environment Variables below)

# Generate DKIM keys for your domains (see DKIM Key Generation below)

# Deploy
./scripts/deploy.sh

# Or with Caddy for automatic HTTPS:
./scripts/deploy.sh --with-caddy
```

#### Docker Commands

```bash
# View logs
docker compose logs -f

# Stop services
docker compose down

# Restart
docker compose restart

# Backup database
./scripts/backup.sh

# Restore database
./scripts/restore.sh backups/makeanon_YYYYMMDD_HHMMSS.sql.gz
```

#### Required Environment Variables

```env
# Database password (generate a strong password)
DB_PASSWORD=your-secure-password

# JWT secret (min 32 characters)
JWT_SECRET=your-random-string-at-least-32-chars

# Master encryption key for destination emails (64 hex chars = 32 bytes)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# CRITICAL: Back this up! If lost, all encrypted emails are unrecoverable.
MASTER_ENCRYPTION_KEY=

# Server's public IPv4 address (used by Haraka for DKIM/SPF)
PUBLIC_IP=your.server.ip

# Email domains (comma-separated, first is default)
EMAIL_DOMAINS=yourdomain.com
```

Email forwarding uses the built-in Haraka SMTP relay with DKIM signing. No external SMTP provider is needed for outbound mail.

### Manual Installation

If you prefer not to use Docker:

```bash
git clone https://github.com/citizen-123/MakeAnon.git
cd MakeAnon

npm install
cp .env.example .env
# Edit .env with your configuration

npm run db:generate
npm run db:push
npm run build
npm start
```

Requires: Node.js 18+, PostgreSQL 14+, Redis (optional)

### DKIM Key Generation

Each email domain needs a DKIM keypair for signed outbound mail:

```bash
# Generate DKIM keys for your domain
mkdir -p haraka/config/dkim/yourdomain.com
openssl genrsa -out haraka/config/dkim/yourdomain.com/private 2048
openssl rsa -in haraka/config/dkim/yourdomain.com/private \
  -pubout -out haraka/config/dkim/yourdomain.com/public
echo "selector" > haraka/config/dkim/yourdomain.com/selector
```

The private keys are excluded from git via `.gitignore`.

### DNS Setup

Configure these DNS records for each email domain:

| Type | Name | Value |
|------|------|-------|
| **MX** | `@` | `10 mail.yourdomain.com` |
| **A** | `mail` | `YOUR_SERVER_IP` |
| **SPF** | `@` | `v=spf1 ip4:YOUR_SERVER_IP ~all` |
| **DKIM** | `selector._domainkey` | `v=DKIM1; k=rsa; p=YOUR_PUBLIC_KEY` |
| **DMARC** | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:admin@yourdomain.com` |

To get the DKIM public key value for DNS:

```bash
# Extract the key (remove header/footer/newlines)
sed '/^-/d' haraka/config/dkim/yourdomain.com/public | tr -d '\n'
```

## License

MIT
