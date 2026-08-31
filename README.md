# Useful Tech Manager

Public website and secure TikTok OAuth backend for the Useful Tech Manager TikTok developer application.

## Pages

- `/` — official website
- `/privacy/` — Privacy Policy
- `/terms/` — Terms of Service
- `worker/` — Cloudflare Worker for TikTok OAuth, authorized account data, and creator-approved TikTok deliveries

The public site is static HTML and CSS. The manager runs on the Cloudflare Worker so TikTok tokens and the client secret never reach browser JavaScript. Runtime secrets are configured only as Cloudflare Worker secrets and are not committed to this repository.

## Local preview

Open `index.html` directly in a browser, or serve this directory with any static HTTP server.

## Worker

The Worker is deployed from `worker/`. Apply its D1 migrations before deployment. Configure the TikTok sandbox client key, client secret, and 32-byte base64url token-encryption key as Worker secrets; never place them in repository files.

The app supports explicit creator-approved TikTok Direct Posts. It requests the current creator information before the posting form is shown, uses TikTok's current privacy and interaction settings, and never publishes content automatically. During unaudited Sandbox testing, TikTok restricts Direct Posts to private viewing when the account is eligible.

## Contact

For privacy, data-deletion, and service questions, contact [useful.tech.ar@gmail.com](mailto:useful.tech.ar@gmail.com).
