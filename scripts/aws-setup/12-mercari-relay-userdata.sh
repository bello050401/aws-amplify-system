#!/bin/bash
# BELLO Mercari Shops API relay - first boot provisioning (cloud-init user-data).
# Design and rationale (in Japanese): docs/mercari-relay-design-20260901.md
#
# 12-create-mercari-relay.ps1 substitutes the placeholder on the "echo" line
# below with base64( tar.gz( server.mjs, server.crt, server.key, relay.key ) ).
#
# Two constraints shape this file:
#   1. Lightsail user-data is capped at 16 KB, so the payload is one gzipped
#      tar rather than four separate base64 blobs (that would be ~30 KB).
#   2. The AWS CLI reads file:// paramfiles using the machine's locale
#      encoding (cp932 here), not UTF-8, so this file must stay pure ASCII.
#      Verified: PYTHONUTF8=1 does not change that behaviour.
#
# The CA private key is never delivered here - only the server cert/key.
set -euo pipefail
exec > >(tee -a /var/log/bello-relay-setup.log) 2>&1
echo "=== setup start: $(date -Is) ==="

RELAY_DIR=/etc/bello-relay
APP_DIR=/opt/bello-relay
RELAY_USER=bello-relay
export DEBIAN_FRONTEND=noninteractive

# 1. Node.js LTS (Ubuntu's own nodejs package is too old).
apt-get update -y
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /usr/share/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
chmod 0644 /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -y && apt-get install -y nodejs
node --version

# 2. Dedicated non-login service account. The relay never runs as root.
id -u "$RELAY_USER" >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RELAY_USER"

# 3. Unpack the payload.
umask 077
PAYLOAD_DIR=$(mktemp -d)
echo "__PAYLOAD_TGZ_B64__" | tr -d '\n' | base64 -d | tar xzf - -C "$PAYLOAD_DIR"
for f in server.mjs server.crt server.key relay.key; do
  [ -s "$PAYLOAD_DIR/$f" ] || { echo "FATAL: payload missing $f"; exit 1; }
done

# 3b. Install secrets and certs. The private key and the shared HMAC key are
#     readable by the service account only (0640 root:bello-relay); writes are
#     root-only. The certificate is public information, so 0644.
install -d -m 0750 -o root -g "$RELAY_USER" "$RELAY_DIR"
install -m 0640 -o root -g "$RELAY_USER" "$PAYLOAD_DIR/relay.key"  "$RELAY_DIR/relay.key"
install -m 0640 -o root -g "$RELAY_USER" "$PAYLOAD_DIR/server.key" "$RELAY_DIR/server.key"
install -m 0644 -o root -g "$RELAY_USER" "$PAYLOAD_DIR/server.crt" "$RELAY_DIR/server.crt"

# 4. Application.
install -d -m 0755 -o root -g root "$APP_DIR"
install -m 0644 -o root -g root "$PAYLOAD_DIR/server.mjs" "$APP_DIR/server.mjs"

# Wipe the unpacked plaintext so the private key does not linger in /tmp.
find "$PAYLOAD_DIR" -type f -exec shred -u -z {} \; 2>/dev/null || true
rm -rf "$PAYLOAD_DIR"

# 5. systemd. CAP_NET_BIND_SERVICE is the only capability granted, so the
#    service can bind 443 without running as root.
#    Type=exec (not notify): Node cannot create AF_UNIX datagram sockets, so it
#    has no way to send sd_notify READY=1 with the standard library alone.
#    With Type=notify the unit would time out and restart forever - observed.
cat > /etc/systemd/system/bello-relay.service <<'UNIT'
[Unit]
Description=BELLO Mercari Shops API relay
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
Restart=always
RestartSec=5
User=bello-relay
Group=bello-relay
ExecStart=/usr/bin/node /opt/bello-relay/server.mjs
Environment=NODE_ENV=production
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
ReadOnlyPaths=/etc/bello-relay
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bello-relay

[Install]
WantedBy=multi-user.target
UNIT

install -d -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=30day\n' \
  > /etc/systemd/journald.conf.d/bello-relay.conf
systemctl restart systemd-journald || true
systemctl daemon-reload
# Do not let a failed start abort the rest of this script (set -e): steps 6-8
# below still matter, and step 8 shreds the copy of user-data that carries the
# server private key. Report the failure instead of dying here.
systemctl enable bello-relay.service || true
systemctl start bello-relay.service || {
  echo "WARN: bello-relay failed to start; dumping status for diagnosis"
  systemctl status bello-relay.service --no-pager || true
  journalctl -u bello-relay -n 60 --no-pager || true
}

# 6. Daily certificate expiry check. The relay checks this itself too, but a
#    separate timer still reports while the service is down.
cat > /usr/local/bin/bello-relay-certcheck <<'CHK'
#!/bin/bash
set -euo pipefail
END=$(openssl x509 -enddate -noout -in /etc/bello-relay/server.crt | cut -d= -f2)
LEFT=$(( ( $(date -d "$END" +%s) - $(date +%s) ) / 86400 ))
if [ "$LEFT" -le 60 ]; then
  logger -t bello-relay-certcheck "WARN: certificate expires in ${LEFT} days (${END})"
else
  logger -t bello-relay-certcheck "OK: certificate valid for ${LEFT} more days"
fi
CHK
chmod 0755 /usr/local/bin/bello-relay-certcheck
printf '[Unit]\nDescription=Check relay TLS cert expiry\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/bello-relay-certcheck\n' \
  > /etc/systemd/system/bello-relay-certcheck.service
printf '[Unit]\nDescription=Daily relay cert expiry check\n[Timer]\nOnCalendar=daily\nPersistent=true\n[Install]\nWantedBy=timers.target\n' \
  > /etc/systemd/system/bello-relay-certcheck.timer
systemctl daemon-reload
systemctl enable --now bello-relay-certcheck.timer

# 7. Security updates only, with an automatic reboot at 04:00 local time.
apt-get install -y unattended-upgrades
cat > /etc/apt/apt.conf.d/52bello-unattended <<'UU'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
UU
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades || true

# 8. Destroy the copies of user-data that cloud-init leaves on disk: this file
#    carried the server private key and the shared HMAC key.
for f in /var/lib/cloud/instance/user-data.txt \
         /var/lib/cloud/instance/user-data.txt.i \
         /var/lib/cloud/instance/scripts/part-001 \
         /var/lib/cloud/instances/*/user-data.txt \
         /var/lib/cloud/instances/*/user-data.txt.i; do
  [ -e "$f" ] && shred -u -z "$f" 2>/dev/null || true
done

echo "=== setup done: $(date -Is) ==="
systemctl is-active bello-relay.service
