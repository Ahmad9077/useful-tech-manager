import { Phase2Service } from './service.mjs';

const once = process.argv.includes('--once'); const service = await new Phase2Service().start({ dashboard: !once });
let ticking = false;
const tick = async () => {
  // Long polling Telegram may take longer than the scheduler cadence. Do not let
  // overlapping polls race each other and make a healthy service look broken.
  if (ticking) return;
  ticking = true;
  try { await service.tick(); } catch (error) { process.stderr.write(`phase2 tick failed: ${error.message}\n`); } finally { ticking = false; }
};
await tick();
if (once) { await service.stop(); process.exit(0); }
const interval = setInterval(tick, 3_000); interval.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.stop(); process.exit(0); });
