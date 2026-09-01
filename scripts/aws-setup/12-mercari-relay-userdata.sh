#!/bin/bash
# BELLO Mercari Shops API relay - first boot provisioning (cloud-init user-data).
# Design and rationale (Japanese): docs/mercari-relay-design-20260901.md
#
# 12-create-mercari-relay.ps1 replaces the placeholder on the "echo" line below
# with base64( tar.gz( server.mjs, server.crt, server.key, relay.key ) ).
#
# Constraints that shape this file:
#   1. Lightsail user-data is capped at ~16 KB, so the payload is one gzipped
#      tar and 12-create-mercari-relay.ps1 strips comments before sending.
#   2. The AWS CLI reads file:// paramfiles with the machine locale (cp932),
#      not UTF-8, so this file must stay pure ASCII. PYTHONUTF8=1 does not help.
#
# Deliberately NO external apt repository. An earlier revision added the
# NodeSource repo; a failure anywhere in that step aborted the whole script
# under `set -e`, leaving no systemd unit, no listener and - worst - the
# user-data copy (which carries the server private key) unshredded.
# Ubuntu 24.04 ships nodejs 18.x, which has everything the relay uses
# (global fetch, X509Certificate, node:https, timingSafeEqual).
#
# NO "set" OPTIONS AT ALL - this line is load-bearing, do not "tidy" it back in.
#
# Measured on 2026-09-01 with isolated Lightsail instances: cloud-init on this
# image runs user-data with sh (dash) and IGNORES the #!/bin/bash shebang.
# dash has no "pipefail", so "set -o pipefail" aborts the shell on that very
# line, before anything runs - no log, no listener, nothing to diagnose.
# That is what silently broke builds #1-#3.
#
#   A: shebang + "set -uo pipefail" + http server  -> never ran (port 80 dead)
#   B: shebang + "exec >> log 2>&1" + http server  -> ran fine (port 80 served)
#
# Keep this script POSIX-sh compatible and check every step explicitly rather
# than relying on shell options. The error handling below does not need them.
exec >> /var/log/bello-relay-setup.log 2>&1

RELAY_DIR=/etc/bello-relay
APP_DIR=/opt/bello-relay
RELAY_USER=bello-relay
export DEBIAN_FRONTEND=noninteractive
STEP_FAILED=""

step() { echo "=== STEP $1 : $(date -Is)"; }
fail() { echo "FATAL: $1"; STEP_FAILED="$STEP_FAILED $1"; }

# Always wipe the copies of user-data that cloud-init leaves on disk, however
# this script exits. That file carries the server private key and shared key.
wipe_userdata() {
  step "wipe-user-data"
  for f in /var/lib/cloud/instance/user-data.txt \
           /var/lib/cloud/instance/user-data.txt.i \
           /var/lib/cloud/instance/scripts/part-001 \
           /var/lib/cloud/instances/*/user-data.txt \
           /var/lib/cloud/instances/*/user-data.txt.i; do
    [ -e "$f" ] && shred -u -z "$f" 2>/dev/null
  done
  echo "user-data copies wiped"
}
trap wipe_userdata EXIT

step "start"
. /etc/os-release; echo "ubuntu ${VERSION_ID}"

step "payload"
umask 077
PAYLOAD_DIR=$(mktemp -d)
echo "__PAYLOAD_TGZ_B64__" | tr -d '\n' | base64 -d | tar xzf - -C "$PAYLOAD_DIR" || fail "payload-extract"
for f in server.mjs server.crt server.key relay.key; do
  [ -s "$PAYLOAD_DIR/$f" ] || fail "payload-missing-$f"
done

step "install-files"
id -u "$RELAY_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RELAY_USER"
install -d -m 0750 -o root -g "$RELAY_USER" "$RELAY_DIR"
install -m 0640 -o root -g "$RELAY_USER" "$PAYLOAD_DIR/relay.key"  "$RELAY_DIR/relay.key"
install -m 0640 -o root -g "$RELAY_USER" "$PAYLOAD_DIR/server.key" "$RELAY_DIR/server.key"
install -m 0644 -o root -g "$RELAY_USER" "$PAYLOAD_DIR/server.crt" "$RELAY_DIR/server.crt"
install -d -m 0755 -o root -g root "$APP_DIR"
install -m 0644 -o root -g root "$PAYLOAD_DIR/server.mjs" "$APP_DIR/server.mjs"
find "$PAYLOAD_DIR" -type f -exec shred -u -z {} \; 2>/dev/null
rm -rf "$PAYLOAD_DIR"
ls -l "$RELAY_DIR" "$APP_DIR"

# Temporary diagnostics, started EARLY - before the slow apt steps - so the
# whole provisioning run can be watched from outside while it happens. It is
# stopped again just before the relay binds 443, so a healthy build never
# leaves it exposed. Requires the shared HMAC key over TLS and redacts long
# base64-looking runs, so no key material can be read back.

# Temporary diagnostics, started ONLY when the relay did not come up. A healthy
# build never exposes it, so 443 is never contended. It requires the shared HMAC
# key over TLS, and redacts long base64-looking runs so no key material can be
# read back. Removed automatically by the next successful build; the create
# script also tears it down explicitly once the cause is fixed.
step "diagnostics-early"
  cat > /usr/local/bin/bello-relay-diag.py <<'PYEOF'
import http.server, ssl, re, subprocess
KEY = open('/etc/bello-relay/relay.key').read().strip()
def run(c):
    try: return subprocess.run(c, capture_output=True, text=True, timeout=20).stdout
    except Exception as e: return 'ERR ' + str(e)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.headers.get('X-Bello-Relay-Key') != KEY:
            self.send_response(401); self.end_headers(); self.wfile.write(b'unauthorized'); return
        if self.path != '/diag':
            self.send_response(404); self.end_headers(); return
        p = ['== systemctl ==', run(['systemctl','status','bello-relay','--no-pager','-l'])[-3000:],
             '== journal ==',   run(['journalctl','-u','bello-relay','-n','80','--no-pager'])[-6000:],
             '== env ==',       run(['bash','-lc','command -v node; node --version; ls -l /opt/bello-relay /etc/bello-relay'])[-1500:],
             '== setup log ==']
        try: p.append(open('/var/log/bello-relay-setup.log').read()[-9000:])
        except Exception as e: p.append(str(e))
        body = re.sub(r'[A-Za-z0-9+/=]{60,}', '<redacted>', '\n'.join(p))
        b = body.encode('utf-8','replace')
        self.send_response(200); self.send_header('Content-Type','text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('/etc/bello-relay/server.crt', '/etc/bello-relay/server.key')
s = http.server.HTTPServer(('0.0.0.0', 443), H)
s.socket = ctx.wrap_socket(s.socket, server_side=True)
s.serve_forever()
PYEOF
  chmod 0700 /usr/local/bin/bello-relay-diag.py
  printf '[Unit]\nDescription=BELLO relay TEMPORARY diagnostics\n[Service]\nType=simple\nExecStart=/usr/bin/python3 /usr/local/bin/bello-relay-diag.py\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/bello-relay-diag.service
  systemctl daemon-reload
  systemctl enable --now bello-relay-diag.service

step "nodejs"
apt-get update -y || fail "apt-update"
apt-get install -y nodejs || fail "apt-install-nodejs"
if command -v node >/dev/null 2>&1; then
  echo "node $(node --version) at $(command -v node)"
else
  fail "node-missing"
fi
NODE_BIN=$(command -v node || echo /usr/bin/node)

step "systemd-unit"
# Type=exec, not notify: Node cannot create AF_UNIX datagram sockets, so it has
# no way to send sd_notify READY=1 from the standard library alone. With
# Type=notify systemd times out and restarts forever - observed on build #1.
cat > /etc/systemd/system/bello-relay.service <<UNIT
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
ExecStart=$NODE_BIN /opt/bello-relay/server.mjs
Environment=NODE_ENV=production
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
LockPersonality=yes
ReadOnlyPaths=/etc/bello-relay
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bello-relay

[Install]
WantedBy=multi-user.target
UNIT

install -d -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=30day\n' > /etc/systemd/journald.conf.d/bello-relay.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl disable --now bello-relay-diag.service 2>/dev/null
sleep 1
systemctl enable bello-relay.service
systemctl start bello-relay.service || fail "relay-start"
sleep 5
systemctl is-active bello-relay.service || { fail "relay-inactive"; systemctl enable --now bello-relay-diag.service; }

step "certcheck-timer"
cat > /usr/local/bin/bello-relay-certcheck <<'CHK'
#!/bin/bash
END=$(openssl x509 -enddate -noout -in /etc/bello-relay/server.crt | cut -d= -f2)
LEFT=$(( ( $(date -d "$END" +%s) - $(date +%s) ) / 86400 ))
if [ "$LEFT" -le 60 ]; then
  logger -t bello-relay-certcheck "WARN: certificate expires in ${LEFT} days (${END})"
else
  logger -t bello-relay-certcheck "OK: certificate valid for ${LEFT} more days"
fi
CHK
chmod 0755 /usr/local/bin/bello-relay-certcheck
printf '[Unit]\nDescription=Check relay TLS cert expiry\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/bello-relay-certcheck\n' > /etc/systemd/system/bello-relay-certcheck.service
printf '[Unit]\nDescription=Daily relay cert expiry check\n[Timer]\nOnCalendar=daily\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/bello-relay-certcheck.timer
systemctl daemon-reload
systemctl enable --now bello-relay-certcheck.timer

step "unattended-upgrades"
apt-get install -y unattended-upgrades || fail "apt-install-uu"
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
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades


step "done"
echo "failed steps:${STEP_FAILED:- none}"
systemctl is-active bello-relay.service
