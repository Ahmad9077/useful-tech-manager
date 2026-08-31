# Technical plan

Local Node 26 ESM service using `node:sqlite`, loopback HTTP, Telegram long polling, ffmpeg/ffprobe adapters, and a launchd user agent. Runtime state is in `~/Library/Application Support/Useful Tech Manager`, never the iCloud video archive. The public Worker and submitted Production TikTok configuration remain untouched.

Components: SQLite repository and state machine; signed Telegram callbacks; durable scheduler/outbox; discovery and source records; rendering/QC interfaces; archive; TikTok environment adapter; analytics; loopback dashboard; backups and launchd installation.
