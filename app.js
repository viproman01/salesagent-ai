/** Serverix Node.js entry point. Run `npm run build` before starting. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('./dist/index.js');

const tunnelMode = (process.env.CLOUDFLARE_TUNNEL_MODE || 'off').trim().toLowerCase();
const tunnelUrlFile = path.resolve(process.env.CLOUDFLARE_URL_FILE || path.join(__dirname, 'https-url.txt'));
const cloudflaredPath = path.resolve(process.env.CLOUDFLARED_PATH || path.join(__dirname, 'bin', 'cloudflared'));
let tunnelProcess = null;
let tunnelRestartTimer = null;
let shuttingDown = false;

function publishTunnelUrl(output) {
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  const url = match[0];
  let current = '';
  try { current = fs.readFileSync(tunnelUrlFile, 'utf8').trim(); } catch { /* first start */ }
  if (current === url) return;
  fs.writeFileSync(tunnelUrlFile, `${url}\n`, { mode: 0o644 });
  console.log(`[HTTPS] Public URL: ${url}`);
}

function startQuickTunnel() {
  if (shuttingDown || !['quick', 'named'].includes(tunnelMode)) return;
  if (!fs.existsSync(cloudflaredPath)) {
    console.error(`[HTTPS] cloudflared binary is missing: ${cloudflaredPath}`);
    return;
  }
  const port = Number(process.env.PORT || 3000);
  const args = tunnelMode === 'named'
    ? [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        'run',
        '--token',
        process.env.CLOUDFLARE_TUNNEL_TOKEN || '',
      ]
    : [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--url',
        `http://127.0.0.1:${port}`,
      ];
  if (tunnelMode === 'named' && !process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    console.error('[HTTPS] CLOUDFLARE_TUNNEL_TOKEN is required for named tunnel mode');
    return;
  }
  tunnelProcess = spawn(cloudflaredPath, args, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const consume = chunk => {
    const output = chunk.toString();
    if (tunnelMode === 'quick') publishTunnelUrl(output);
    if (/registered tunnel connection/i.test(output)) {
      console.log(`[HTTPS] ${tunnelMode === 'named' ? 'Named' : 'Quick'} tunnel connected`);
    }
  };
  tunnelProcess.stdout.on('data', consume);
  tunnelProcess.stderr.on('data', consume);
  tunnelProcess.on('error', error => {
    console.error(`[HTTPS] Failed to start tunnel: ${error.message}`);
  });
  tunnelProcess.on('exit', (code, signal) => {
    tunnelProcess = null;
    if (shuttingDown) return;
    console.error(`[HTTPS] Tunnel stopped (${signal || code}); retrying in 5 seconds`);
    tunnelRestartTimer = setTimeout(startQuickTunnel, 5000);
  });
}

function stopTunnel() {
  shuttingDown = true;
  if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
  tunnelProcess?.kill('SIGTERM');
}

process.on('SIGTERM', stopTunnel);
process.on('SIGINT', stopTunnel);
startQuickTunnel();
