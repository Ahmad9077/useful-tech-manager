# Useful Tech Manager Phase 2

Local Phase 2 is intentionally separate from the submitted public TikTok application. Run `npm test` and `npm run check` here. Runtime data is created under `~/Library/Application Support/Useful Tech Manager`; it is not committed and never uses the iCloud final-video archive as a workspace.

The service defaults to TikTok Sandbox and refuses Production while the app is In Review. Configure Telegram locally only after the bot is created, using `node bin/provision-telegram.mjs`. The helper creates a mode-600 local configuration file outside Git.

`node bin/install-launchd.mjs` installs a user LaunchAgent for the loopback dashboard and durable scheduler. The dashboard is available only locally at `http://127.0.0.1:8786/` and provides no control endpoints.
