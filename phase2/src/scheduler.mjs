import { isoNow, randomId } from './util.mjs';

export class DurableScheduler {
  constructor(store) { this.store = store; }
  scheduleDailyResearch(date = new Date().toISOString().slice(0, 10)) { this.store.queueJob('DISCOVER_IDEAS', { date }, isoNow(), `daily-discovery:${date}`); }
  claimDueJob(workerId = 'scheduler') {
    return this.store.transaction(() => {
      const now = isoNow(); const job = this.store.db.prepare("SELECT * FROM workflow_jobs WHERE status='QUEUED' AND run_after<=? ORDER BY run_after LIMIT 1").get(now); if (!job) return null;
      const leaseUntil = new Date(Date.now() + 90_000).toISOString(); const result = this.store.db.prepare("UPDATE workflow_jobs SET status='CLAIMED',attempts=attempts+1,lease_until=?,worker_id=?,claimed_at=?,heartbeat_at=?,updated_at=? WHERE id=? AND status='QUEUED'").run(leaseUntil, workerId, now, now, now, job.id); return result.changes ? { ...job, lease_until: leaseUntil, worker_id: workerId, claimed_at: now, heartbeat_at: now } : null;
    });
  }
  claimJob(jobId, workerId = 'scheduler') {
    return this.store.transaction(() => {
      const now = isoNow(); const job = this.store.db.prepare("SELECT * FROM workflow_jobs WHERE id=? AND status='QUEUED'").get(jobId); if (!job) return null;
      const leaseUntil = new Date(Date.now() + 90_000).toISOString(); const result = this.store.db.prepare("UPDATE workflow_jobs SET status='CLAIMED',attempts=attempts+1,lease_until=?,worker_id=?,claimed_at=?,heartbeat_at=?,updated_at=? WHERE id=? AND status='QUEUED'").run(leaseUntil, workerId, now, now, now, job.id);
      return result.changes ? { ...job, lease_until: leaseUntil, worker_id: workerId, claimed_at: now, heartbeat_at: now } : null;
    });
  }
  extendLease(jobId, workerId = 'scheduler') { const now = isoNow(); this.store.db.prepare("UPDATE workflow_jobs SET lease_until=?,heartbeat_at=?,updated_at=? WHERE id=? AND status='CLAIMED' AND worker_id=?").run(new Date(Date.now() + 90_000).toISOString(), now, now, jobId, workerId); }
  finish(jobId, error = null, workerId = 'scheduler') { const now = isoNow(); this.store.db.prepare("UPDATE workflow_jobs SET status=?,error_code=?,lease_until=NULL,updated_at=? WHERE id=? AND status='CLAIMED' AND worker_id=?").run(error ? 'FAILED' : 'DONE', error ? String(error).slice(0, 160) : null, now, jobId, workerId); }
  recoverExpiredLeases() { const rows = this.store.db.prepare("SELECT * FROM workflow_jobs WHERE status='CLAIMED' AND lease_until<?").all(isoNow()); this.store.db.prepare("UPDATE workflow_jobs SET status='QUEUED',lease_until=NULL,worker_id=NULL,updated_at=? WHERE status='CLAIMED' AND lease_until<?").run(isoNow(), isoNow()); return rows; }
}
