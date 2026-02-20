#!/bin/sh
set -e

# Replace PUBLIC_IP placeholder in config files
if [ -n "$PUBLIC_IP" ]; then
  sed -i "s|\${PUBLIC_IP}|${PUBLIC_IP}|g" /opt/haraka/config/smtp.ini
  sed -i "s|\${PUBLIC_IP}|${PUBLIC_IP}|g" /opt/haraka/plugins/force_ipv4.js
  sed -i "s|\${PUBLIC_IP}|${PUBLIC_IP}|g" /opt/haraka/config/outbound.ini
  echo "Configured public IP: $PUBLIC_IP"
else
  echo "ERROR: PUBLIC_IP is required for DKIM/SPF to work correctly."
  echo "Set PUBLIC_IP to your server's public IPv4 address in .env.docker"
  exit 1
fi

exec "$@"
