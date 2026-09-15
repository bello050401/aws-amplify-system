import { redactText } from '../log/redact.mjs';
export class Notifications {
  constructor({ config, repo, send = fetch, env = process.env }) {
    this.settings = config.notifications ?? { enabled: false }; this.repo = repo; this.send = send; this.env = env; this.busy = false;
    if (repo.store.getMeta('notificationCursor') === null) repo.store.setMeta('notificationCursor', repo.store.get('SELECT COALESCE(MAX(id),0) AS id FROM task_state_history').id);
  }
  capture() {
    this.repo.store.transaction(() => {
      const cursor = Number(this.repo.store.getMeta('notificationCursor'));
      const events = this.repo.store.all('SELECT h.*, t.title FROM task_state_history h JOIN tasks t ON t.id=h.task_id WHERE h.id>? ORDER BY h.id LIMIT 200', [cursor]);
      for (const event of events) {
        if (['completed','failed','awaiting_user','paused'].includes(event.to_state)) {
          const payload = { eventId: `bello-${event.task_id}-${event.id}`, taskId: event.task_id, title: event.title, state: event.to_state, at: event.at, reason: event.reason };
          payload.staging = this.repo.store.get('SELECT state FROM staging_deliveries WHERE task_id=?', [event.task_id])?.state || 'not_requested';
          this.repo.store.run('INSERT OR IGNORE INTO notification_outbox(id,event_json,next_at) VALUES(?,?,?)', [payload.eventId, redactText(JSON.stringify(payload)), new Date().toISOString()]);
        }
        this.repo.store.setMeta('notificationCursor', event.id);
      }
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.capture();
      if (!this.settings.enabled) return;
      const row = this.repo.store.get("SELECT * FROM notification_outbox WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 1", [new Date().toISOString()]);
      if (!row) return;
      const attempt = row.attempts + 1;
      try {
        const url = new URL(this.env[this.settings.webhookUrlEnvVar] || '');
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('通知先は認証情報を含まないHTTPS URLが必要です');
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': row.id };
        const token = this.env[this.settings.tokenEnvVar];
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await this.send(url, { method: 'POST', headers, body: row.event_json, redirect: 'error', signal: AbortSignal.timeout((this.settings.timeoutSeconds || 10) * 1000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.repo.store.run("UPDATE notification_outbox SET status='sent', attempts=?, sent_at=?, error=NULL WHERE id=?", [attempt, new Date().toISOString(), row.id]);
      } catch (err) {
        // Do not persist fetch errors: they may contain a URL with a secret query token.
        const error = /^HTTP \d+$/.test(err.message) ? err.message : '通知先設定または通信を確認してください';
        this.repo.store.run('UPDATE notification_outbox SET status=?, attempts=?, next_at=?, error=? WHERE id=?', [attempt >= (this.settings.maxAttempts || 5) ? 'failed' : 'pending', attempt, new Date(Date.now() + Math.min(3600000, 5000 * 2 ** attempt)).toISOString(), error, row.id]);
      }
    } finally { this.busy = false; }
  }
  summary() { return this.repo.store.all('SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status'); }
}
