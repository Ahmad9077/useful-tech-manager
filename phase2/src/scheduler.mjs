import { isoNow, randomId } from './util.mjs';

export class DurableScheduler {
  constructor(store) { this.store = store; }
  scheduleDailyResearch(date = new Date().toISOString().slice(0, 10)) { this.store.queueJob('DISCOVER_IDEAS', { date }, isoNow(), `daily-discovery:${date}`); }
  claimDueJob() {
    return this.store.transaction(() => {
      const now = isoNow(); const job = this.store.db.prepare("SELECT * FROM workflow_jobs WHERE status='QUEUED' AND run_after<=? ORDER BY run_after LIMIT 1").get(now); if (!job) return null;
      const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString(); const result = this.store.db.prepare("UPDATE workflow_jobs SET status='CLAIMED',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=? AND status='QUEUED'").run(leaseUntil, now, job.id); return result.changes ? { ...job, lease_until: leaseUntil } : null;
    });
  }
  claimJob(jobId) {
    return this.store.transaction(() => {
      const now = isoNow(); const job = this.store.db.prepare("SELECT * FROM workflow_jobs WHERE id=? AND status='QUEUED'").get(jobId); if (!job) return null;
      const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString(); const result = this.store.db.prepare("UPDATE workflow_jobs SET status='CLAIMED',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=? AND status='QUEUED'").run(leaseUntil, now, job.id);
      return result.changes ? { ...job, lease_until: leaseUntil } : null;
    });
  }
  extendLease(jobId) { this.store.db.prepare("UPDATE workflow_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='CLAIMED'").run(new Date(Date.now() + 5 * 60_000).toISOString(), isoNow(), jobId); }
  finish(jobId, error = null) { const now = isoNow(); this.store.db.prepare("UPDATE workflow_jobs SET status=?,error_code=?,lease_until=NULL,updated_at=? WHERE id=? AND status='CLAIMED'").run(error ? 'FAILED' : 'DONE', error ? String(error).slice(0, 160) : null, now, jobId); }
  recoverExpiredLeases() { this.store.db.prepare("UPDATE workflow_jobs SET status='QUEUED',lease_until=NULL,updated_at=? WHERE status='CLAIMED' AND lease_until<?").run(isoNow(), isoNow()); }
}
