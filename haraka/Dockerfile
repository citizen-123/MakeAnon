# Haraka SMTP Relay with DKIM Signing
FROM node:20-alpine

# Install build dependencies for native modules and netcat for health checks
RUN apk add --no-cache python3 make g++ netcat-openbsd

WORKDIR /opt/haraka

# Install Haraka globally
RUN npm install -g Haraka

# Remove build dependencies to reduce image size
RUN apk del python3 make g++

# Initialize Haraka directory structure
RUN haraka -i /opt/haraka

# Remove default config (will be replaced by our config)
RUN rm -rf /opt/haraka/config/*

# Copy our configuration
COPY config/ /opt/haraka/config/

# Copy custom plugins if any
COPY plugins/ /opt/haraka/plugins/

# Create queue directory with proper permissions
RUN mkdir -p /opt/haraka/queue && chmod 755 /opt/haraka/queue

# Expose SMTP submission port
EXPOSE 2525

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD nc -z localhost 2525 || exit 1

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

# Run Haraka
CMD ["haraka", "-c", "/opt/haraka"]
