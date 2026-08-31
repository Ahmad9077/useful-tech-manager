import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store.mjs';
import { loadConfig, assertSandboxOnly } from './config.mjs';
import { DurableScheduler } from './scheduler.mjs';
import { DiscoveryEngine } from './discovery.mjs';
import { createDashboard } from './dashboard.mjs';
import { telegramReady, TelegramClient } from './telegram.mjs';
import { parseJson, isoNow, redact } from './util.mjs';

export class Phase2Service {
  constructor(config = loadConfig()) { assertSandboxOnly(config); this.config = config; }
  async start({ dashboard = true } = {}) {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 }); this.store = new Store(path.join(this.config.dataDir, 'useful-tech-manager.sqlite')); this.scheduler = new DurableScheduler(this.store); this.discovery = new DiscoveryEngine({ store: this.store }); this.scheduler.recoverExpiredLeases();
    if (dashboard) { this.dashboard = createDashboard(this.store, this.config); await new Promise((resolve) => this.dashboard.listen(this.config.dashboardPort, this.config.dashboardHost, resolve)); }
    return this;
  }
  async tick() {
    this.scheduler.scheduleDailyResearch(); const job = this.scheduler.claimDueJob(); if (job && job.kind === 'DISCOVER_IDEAS') { try { const signals = await this.discovery.discover(); this.store.audit('DISCOVERY_COMPLETED', 'scheduler', { sourceCount: signals.length }); this.scheduler.finish(job.id); } catch (error) { this.scheduler.finish(job.id, redact(error.message)); } }
    if (telegramReady(this.config)) await this.flushOutbox();
  }
  async flushOutbox() {
    const client = new TelegramClient(this.config.telegram.token); const rows = this.store.db.prepare("SELECT * FROM outbox WHERE status='QUEUED' AND run_after<=? ORDER BY created_at LIMIT 10").all(isoNow());
    for (const row of rows) { try { const payload = parseJson(row.payload_json); if (row.kind === 'message') await client.call('sendMessage', { chat_id: this.config.telegram.ownerChatId, text: payload.text }); this.store.db.prepare("UPDATE outbox SET status='SENT',updated_at=? WHERE id=?").run(isoNow(), row.id); } catch (error) { this.store.db.prepare("UPDATE outbox SET status='FAILED',attempts=attempts+1,error_code=?,updated_at=? WHERE id=?").run(redact(error.message).slice(0, 160), isoNow(), row.id); } }
  }
  async stop() { if (this.dashboard) await new Promise((resolve) => this.dashboard.close(resolve)); this.store?.close(); }
}
