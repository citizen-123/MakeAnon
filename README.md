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

All emails sent to your alias are forwarded to your real address. Your real email is never exposed. Destination addresses are encrypted at rest with AES-256-GCM — plaintext never touches the database.

## Features

- **No account required** - Create and manage aliases with just your email and a management token
- **Encryption at rest** - Destination emails encrypted with AES-256-GCM; per-alias keys derived via HKDF-SHA256
- **Email hashing** - HMAC-SHA256 hashes enable alias-per-email limits without storing plaintext
- **Multiple domains** - Choose from several alias domains
- **Custom aliases** - Pick your own alias name (4-32 chars, alphanumeric with hyphens/underscores) or get a random one
- **DKIM signing** - Outbound emails are DKIM-signed (RSA-2048) via Haraka for deliverability
- **Sender blocking** - Block specific senders or glob patterns (`*@spam.com`, `spammer@*`) per alias
- **Rate limiting** - Redis-backed per-alias and per-IP rate limiting
- **Auto-cleanup** - Unverified aliases deleted after 72 hours, disabled aliases after 30 days, expired tokens hourly
- **User accounts** - Optional registration for managing private aliases with higher limits
- **Admin dashboard** - User management, global stats, alias oversight, manual cleanup
- **Email logging** - Configurable log levels (NONE/PRIVATE/PUBLIC/ALL) with masked sender addresses
- **Swagger docs** - Interactive API documentation at `/api/docs`

## Architecture Overview

### Email Flow

```
                         Inbound                              Outbound
                        ┌──────────────────────────────────────────────────────┐
                        │                                                      │
  Internet ──► MX ──► SMTP Server (port 25)                                    │
                        │                                                      │
                        ├─ Domain validation                                   │
                        ├─ Alias lookup (Redis cache → DB)                     │
                        ├─ Active / verified check                             │
                        ├─ Blocked sender check (exact + glob)                 │
                        ├─ Rate limit check                                    │
                        ├─ Decrypt destination (AES-256-GCM)                   │
                        │                                                      │
                        └──► Forward via Haraka (port 2525) ──► DKIM sign ──► Recipient MTA
```

### Docker Container Layout

```
┌─────────────────────────────────────────────────────┐
│  Docker Compose Stack                               │
│                                                     │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │ Caddy    │  │ App           │  │ Haraka       │ │
│  │ :80/:443 │──│ :3000 (HTTP)  │──│ :2525 (SMTP) │ │
│  │ HTTPS    │  │ :25   (SMTP)  │  │ DKIM signing │ │
│  └──────────┘  └───────┬───────┘  └──────────────┘ │
│                        │                            │
│               ┌────────┴────────┐                   │
│               │                 │                   │
│         ┌─────┴─────┐   ┌──────┴──────┐            │
│         │ PostgreSQL │   │ Redis       │            │
│         │ :5432      │   │ :6379       │            │
│         │ Encrypted  │   │ Cache +     │            │
│         │ storage    │   │ Rate limits │            │
│         └────────────┘   └─────────────┘            │
└─────────────────────────────────────────────────────┘
```

### Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | >=18.0.0 |
| Framework | Express | 5.x |
| Language | TypeScript | 5.x |
| ORM | Prisma | 7.x |
| Database | PostgreSQL | 17-alpine |
| Cache | Redis (ioredis) | 7-alpine |
| Inbound SMTP | smtp-server | 3.x |
| Outbound SMTP | Haraka (DKIM) | latest |
| Email parsing | mailparser | 3.x |
| Email sending | nodemailer | 7.x |
| Auth | jsonwebtoken + bcryptjs | — |
| Validation | express-validator + zod | — |
| Logging | winston | 3.x |
| Reverse proxy | Caddy | 2-alpine |
| API docs | swagger-jsdoc + swagger-ui-express | — |

## Security & Encryption Model

### Encryption at Rest (AES-256-GCM + HKDF)

Destination email addresses are never stored in plaintext. Each alias gets a unique encryption key derived from a master key:

1. A 32-byte **master encryption key** (`MASTER_ENCRYPTION_KEY`) is set at deployment
2. Per-alias keys are derived using **HKDF-SHA256** with context `makeanon-alias-{aliasId}` and a random 32-byte salt
3. The destination email is encrypted with **AES-256-GCM** using a random 16-byte IV
4. The database stores four fields per alias (all base64-encoded):

| Field | Description |
|-------|-------------|
| `destinationEmail` | AES-256-GCM ciphertext |
| `destinationIv` | 16-byte initialization vector |
| `destinationSalt` | 32-byte HKDF salt |
| `destinationAuthTag` | 16-byte GCM authentication tag |

Plaintext is only held in memory during encrypt/decrypt operations. On startup, the server runs a test encrypt/decrypt cycle to verify the key is valid.

### Email Hashing (HMAC-SHA256)

To enforce per-email alias limits without storing plaintext addresses, a **HMAC-SHA256** hash is computed using the master key as a pepper:

- Stored as `destinationHash` on each alias
- Indexed for efficient lookups
- Enables counting how many aliases a given email has without exposing it

### Email Logging Privacy

Sender addresses are masked in logs using the pattern `j*****e@gmail.com` (first char, asterisks, last char visible). The `subject` field is stored as `null`. Log verbosity is controlled by the `LOG` environment variable:

| Level | Behavior |
|-------|----------|
| `NONE` | No email activity logged |
| `PRIVATE` | Only log private (registered user) aliases |
| `PUBLIC` | Only log public (anonymous) aliases |
| `ALL` | Log all email activity (default) |

### Management Tokens

Public aliases (no account) are managed via a 48-hex-character token (24 random bytes). This enables stateless alias management without requiring registration. Tokens are unique per alias with a configurable expiry (default: 365 days).

### JWT Authentication

Registered users authenticate via JWT tokens (default 7-day expiry). Password requirements: 8+ characters with uppercase, lowercase, and a number. Tokens are verified on each request by checking user existence and `isActive` status.

### Sender Blocking

Each alias can maintain a blocklist with two match modes:

- **Exact match** - Block a specific email address
- **Glob patterns** - Use `*` (any characters) and `?` (single character) wildcards, e.g. `*@spam.com` or `newsletter-*@example.com`

Glob patterns are converted to regex with ReDoS-safe escaping.

### DKIM Signing

Outbound emails are signed with RSA-2048 DKIM keys via Haraka. Each domain has its own keypair under `haraka/config/dkim/{domain}/`. Headers signed: `from`, `to`, `subject`, `date`, `message-id`.

### Security Headers

- **Helmet.js** - Sets secure HTTP headers (X-Content-Type-Options, X-Frame-Options, etc.)
- **CORS** - Configurable origins (default: `*`)
- **HSTS / CSP** - Enforced via Caddy reverse proxy
- **Trust proxy** - Enabled for accurate IP detection behind reverse proxy

## Email Flow

### Inbound (Receiving)

1. Email arrives at **port 25** via MX record
2. `smtp-server` accepts the connection
3. Recipient address is validated against configured domains
4. Alias is looked up (Redis cache first, then database)
5. Checks: alias is active, email is verified, sender is not blocked
6. Per-alias rate limit check (default: 30 emails/minute)
7. Destination email is decrypted from the database
8. Email is forwarded via Haraka with `[via alias@domain]` subject prefix
9. Forwarding headers added: `X-MakeAnon-*`
10. `Reply-To` is set to the original sender

### Outbound (Forwarding via Haraka)

1. App sends to Haraka on **port 2525** via nodemailer (connection pool: 5 max connections, 100 max messages)
2. Haraka signs the email with **DKIM** for the alias domain
3. Haraka delivers directly to the recipient's MX server (no external SMTP provider needed)
4. SPF/DMARC alignment is handled by DNS configuration

### Attachment Support

Emails with attachments are forwarded intact via `mailparser`. Maximum email size: **25 MB** (configurable via `MAX_EMAIL_SIZE_BYTES`).

## API Reference

All endpoints are prefixed with `/api/v1`.

### Public Alias Management (No Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/alias` | Create a new alias |
| `GET` | `/verify/:token` | Verify alias email |
| `POST` | `/verify/resend` | Resend verification email |
| `POST` | `/management-link` | Request management link resend |
| `GET` | `/manage/:token` | Get alias details by management token |
| `PUT` | `/manage/:token` | Update alias via management token |
| `DELETE` | `/manage/:token` | Delete alias via management token |
| `POST` | `/manage/:token/block` | Block a sender (supports glob patterns) |
| `DELETE` | `/manage/:token/block/:senderId` | Unblock a sender |
| `GET` | `/domains` | List available domains |
| `GET` | `/health` | Health check (database, Redis, version) |
| `GET` | `/stats` | Global statistics (cached 1 min) |

#### Create Alias

```http
POST /api/v1/alias
Content-Type: application/json

{
  "destinationEmail": "your@email.com",
  "customAlias": "myalias",       // optional (4-32 chars)
  "domainId": "uuid",             // optional
  "label": "Shopping",            // optional
  "description": "For online stores",  // optional
  "expiresIn": 30                 // optional, days until expiry
}
```

#### Block Sender

```http
POST /api/v1/manage/:token/block
Content-Type: application/json

{
  "email": "*@spam.com",
  "reason": "Spam",               // optional
  "isPattern": true               // optional, enables glob matching
}
```

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/signup` | Create user account |
| `POST` | `/auth/login` | Login (returns JWT) |
| `GET` | `/auth/profile` | Get user profile |
| `PUT` | `/auth/profile` | Update profile |
| `POST` | `/auth/change-password` | Change password |
| `DELETE` | `/auth/account` | Delete account |

### Private Aliases (JWT Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/aliases` | Create private alias |
| `GET` | `/aliases` | List user's aliases (paginated, filterable) |
| `GET` | `/aliases/:id` | Get alias with email logs |
| `PUT` | `/aliases/:id` | Update alias |
| `DELETE` | `/aliases/:id` | Delete alias |
| `POST` | `/aliases/:id/toggle` | Toggle active status |
| `GET` | `/aliases/stats` | User alias statistics |
| `GET` | `/aliases/logs` | User email logs (paginated) |

### Domain Management (Admin Only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/domains` | List active domains (public) |
| `GET` | `/domains/:id` | Get domain details (public) |
| `POST` | `/domains` | Create domain |
| `PUT` | `/domains/:id` | Update domain |
| `DELETE` | `/domains/:id` | Delete domain |
| `POST` | `/domains/:id/toggle` | Toggle domain status |

### Admin (JWT + Admin Role)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/stats` | Dashboard statistics |
| `GET` | `/admin/users` | List all users (paginated, searchable) |
| `PUT` | `/admin/users/:id` | Update user (isActive, isAdmin, maxAliases) |
| `GET` | `/admin/aliases` | List all aliases (paginated, searchable) |
| `DELETE` | `/admin/aliases/:id` | Delete alias |
| `GET` | `/admin/logs` | View all email logs |
| `POST` | `/admin/cleanup` | Run manual cleanup |

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
# Edit .env with your settings (see Configuration Reference below)

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

### Manual Installation

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

Requires: Node.js 18+, PostgreSQL 14+, Redis (optional but recommended)

### DKIM Key Generation

Each email domain needs an RSA-2048 DKIM keypair for signed outbound mail:

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

## Configuration Reference

### Required

| Variable | Description |
|----------|-------------|
| `MASTER_ENCRYPTION_KEY` | 32-byte hex (64 chars). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Back this up — if lost, all encrypted emails are unrecoverable.** |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing secret (min 32 chars) |
| `EMAIL_DOMAINS` | Comma-separated list of alias domains (first is default) |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP API port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `development` or `production` |
| `BASE_URL` | `http://localhost:3000` | Public URL for links in emails |
| `CORS_ORIGIN` | `https://makeanon.yourdomain.com` | Allowed CORS origin (should match BASE_URL; never use `*` in production) |

### SMTP Inbound (Receiving)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_PORT` | `25` | Inbound SMTP port |
| `SMTP_HOST` | `0.0.0.0` | SMTP bind address |
| `SMTP_ENABLED` | `true` | Enable/disable inbound SMTP |
| `SMTP_TLS_ENABLED` | `false` | Enable STARTTLS |
| `SMTP_TLS_KEY_PATH` | — | Path to TLS private key |
| `SMTP_TLS_CERT_PATH` | — | Path to TLS certificate |
| `MAX_EMAIL_SIZE_BYTES` | `26214400` | Max email size (25 MB) |

### SMTP Outbound (Forwarding)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_OUTBOUND_HOST` | `smtp.gmail.com` | Outbound SMTP host (use `haraka` in Docker) |
| `SMTP_OUTBOUND_PORT` | `587` | Outbound SMTP port (use `2525` for Haraka) |
| `SMTP_OUTBOUND_SECURE` | `false` | Use TLS (true for port 465) |
| `SMTP_OUTBOUND_USER` | — | SMTP auth username (not needed with Haraka) |
| `SMTP_OUTBOUND_PASS` | — | SMTP auth password (not needed with Haraka) |
| `SMTP_FROM_ADDRESS` | `noreply@yourdomain.com` | System email from address |
| `SMTP_FROM_NAME` | `Emask` | System email from name |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_EXPIRES_IN` | `7d` | JWT token expiry |
| `SESSION_TIMEOUT_HOURS` | `24` | Session timeout |
| `ADMIN_EMAIL` | `admin@yourdomain.com` | Default admin account email |
| `ADMIN_PASSWORD` | — | Default admin account password |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `900000` | API rate limit window (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max API requests per window |
| `ALIAS_CREATION_LIMIT_PER_HOUR` | `10` | Max alias creations per hour per email |
| `FORWARD_LIMIT_PER_MINUTE` | `30` | Max forwards per minute per alias |

### Alias Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_ALIASES_PER_EMAIL` | `10` | Max aliases per email (anonymous) |
| `MAX_ALIASES_PER_USER` | `100` | Max aliases per registered user |
| `MAX_ALIASES_PREMIUM` | `1000` | Max aliases for premium users |
| `ALIAS_LENGTH` | `8` | Random alias character length |
| `ALLOW_CUSTOM_ALIASES` | `true` | Allow user-chosen alias names |
| `MIN_CUSTOM_ALIAS_LENGTH` | `4` | Minimum custom alias length |
| `MANAGEMENT_TOKEN_EXPIRY_DAYS` | `365` | Management token validity |

### Verification

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUIRE_EMAIL_VERIFICATION` | `true` | Require email verification for aliases |
| `VERIFICATION_TOKEN_EXPIRY_HOURS` | `24` | Verification token validity |
| `VERIFICATION_RESEND_COOLDOWN` | `60` | Seconds between verification resends |

### Logging & Cleanup

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG` | `ALL` | Email log level: `NONE`, `PRIVATE`, `PUBLIC`, `ALL` |
| `LOG_LEVEL` | `info` | Application log level |
| `LOG_FORMAT` | `json` | Log format |
| `CLEANUP_INTERVAL_HOURS` | `1` | Hours between cleanup runs |
| `LOG_RETENTION_DAYS` | `30` | Days to retain email logs |
| `DELETE_INACTIVE_AFTER_DAYS` | `0` | Delete inactive aliases after N days (0 = disabled) |
| `DELETE_EXPIRED_ALIASES` | `true` | Auto-delete expired aliases |

### Spam & Webhooks

| Variable | Default | Description |
|----------|---------|-------------|
| `BLOCK_DISPOSABLE_EMAILS` | `false` | Block disposable email providers |
| `SPAM_CHECK_ENABLED` | `false` | Enable spam scoring |
| `SPAM_THRESHOLD` | `5.0` | Spam score threshold |
| `WEBHOOKS_ENABLED` | `true` | Enable webhook notifications |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Webhook request timeout |
| `WEBHOOK_MAX_RETRIES` | `3` | Webhook retry attempts |

### Docker-Specific

| Variable | Description |
|----------|-------------|
| `DB_PASSWORD` | PostgreSQL password (used in Docker Compose) |
| `PUBLIC_IP` | Server's public IPv4 (used by Haraka for SPF) |
| `DOMAIN` | Domain for Caddy HTTPS |
| `ACME_EMAIL` | Email for Let's Encrypt certificates |

## Database Schema

The database uses PostgreSQL with Prisma ORM. All destination emails are encrypted — the `destinationEmail` column contains AES-256-GCM ciphertext, not plaintext.

### Models

| Model | Key Fields | Notes |
|-------|-----------|-------|
| **Domain** | `domain` (unique), `isActive`, `isDefault`, `isPublic`, `aliasCount` | Available alias domains |
| **User** | `email` (unique), `password`, `isAdmin`, `isActive`, `maxAliases` | Registered user accounts |
| **Alias** | `fullAddress` (unique), `destinationEmail` (encrypted), `destinationHash` (HMAC), `managementToken`, `forwardCount`, `disabledAt` | Core alias with encryption fields (`destinationIv`, `destinationSalt`, `destinationAuthTag`) |
| **BlockedSender** | `aliasId` + `email` (unique pair), `isPattern` | Per-alias sender blocklist, supports glob patterns |
| **EmailLog** | `fromEmail` (masked), `toAlias`, `status`, `processingTime`, `sizeBytes` | Email activity log, subject stored as null |
| **VerificationToken** | `token` (unique), `email`, `type`, `expiresAt`, `usedAt` | Types: `email_verify`, `alias_verify`, `password_reset`, `management` |

### Encrypted Fields on Alias

```
destinationEmail   → AES-256-GCM ciphertext (base64)
destinationIv      → 16-byte IV (base64)
destinationSalt    → 32-byte HKDF salt (base64)
destinationAuthTag → 16-byte GCM auth tag (base64)
isEncrypted        → Boolean flag
destinationHash    → HMAC-SHA256 hash (hex)
```

## Auto-Cleanup

A cleanup job runs automatically at a configurable interval (default: every hour):

| Target | Condition | Default |
|--------|-----------|---------|
| Unverified aliases | Created > 72 hours ago | Always |
| Disabled aliases | Disabled > 30 days ago | Always |
| Expired aliases | Past `expiresAt` date | When `DELETE_EXPIRED_ALIASES=true` |
| Expired tokens | Past `expiresAt` date | Always |
| Old email logs | Older than retention period | `LOG_RETENTION_DAYS=30` |

Manual cleanup can be triggered via `POST /api/v1/admin/cleanup` (admin only).

## License

MIT
