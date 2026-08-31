import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const phase2Root = path.resolve(import.meta.dirname, '..'); const node = process.execPath; const home = os.homedir(); const label = 'com.usefultech.manager.phase2'; const logs = path.join(home, 'Library', 'Logs', 'Useful Tech Manager'); const plistPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
await mkdir(path.dirname(plistPath), { recursive: true }); await mkdir(logs, { recursive: true, mode: 0o700 });
const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>-i</string><string>HOME=${esc(home)}</string><string>PATH=/opt/homebrew/bin:/usr/bin:/bin</string><string>${esc(node)}</string><string>${esc(path.join(phase2Root, 'src', 'main.mjs'))}</string></array><key>WorkingDirectory</key><string>${esc(phase2Root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${esc(path.join(logs, 'phase2.out.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(logs, 'phase2.err.log'))}</string></dict></plist>\n`;
await writeFile(plistPath, plist, { mode: 0o600 }); await chmod(plistPath, 0o600);
const domain = `gui/${process.getuid()}`; try { execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); } catch {} execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' }); execFileSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], { stdio: 'ignore' }); process.stdout.write(`${plistPath}\n`);
