import { execFileSync } from 'node:child_process';

export function keychainSecret(service, account) {
  if (!service || !account) throw new Error('Keychain binding is not configured');
  try { return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim(); }
  catch { throw new Error(`Keychain secret is unavailable for ${service}`); }
}
