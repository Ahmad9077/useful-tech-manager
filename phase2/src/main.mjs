import { Phase2Service } from './service.mjs';

const once = process.argv.includes('--once'); const service = await new Phase2Service().start({ dashboard: !once }); await service.tick();
if (once) { await service.stop(); process.exit(0); }
const interval = setInterval(() => service.tick().catch((error) => process.stderr.write(`phase2 tick failed: ${error.message}\n`)), 3_000); interval.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.stop(); process.exit(0); });
