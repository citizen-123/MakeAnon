#!/bin/sh
set -e

# Replace PUBLIC_IP placeholder in config files
if [ -n "$PUBLIC_IP" ]; then
  sed -i "s|\${PUBLIC_IP}|${PUBLIC_IP}|g" /opt/haraka/config/smtp.ini
  sed -i "s|\${PUBLIC_IP}|${PUBLIC_IP}|g" /opt/haraka/plugins/force_ipv4.js
  sed -i "s|\${PUBLIC_IP}|${PUBLIC_IP}|g" /opt/haraka/config/outbound.ini
  echo "Configured public IP: $PUBLIC_IP"
else
  echo "WARNING: PUBLIC_IP not set. SPF and outbound IP may not work correctly."
fi

exec "$@"
