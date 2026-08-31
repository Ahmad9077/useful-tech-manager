CREATE TABLE IF NOT EXISTS auth_transactions (
  state_hash TEXT PRIMARY KEY,
  cookie_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  open_id TEXT PRIMARY KEY,
  access_ciphertext TEXT NOT NULL,
  refresh_ciphertext TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  granted_scopes TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
