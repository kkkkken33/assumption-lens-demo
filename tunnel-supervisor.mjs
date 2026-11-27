import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ownerPid = Number(process.env.LAUNCHER_PID || 0);
const binary = process.env.CLOUDFLARED_BIN;
const shareFile = process.env.SHARE_URL_FILE;
const port = Number(process.env.PORT || 4173);
if (!ownerPid || !binary || !shareFile) throw new Error('Tunnel supervisor configuration is incomplete');

const child = spawn(binary, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let log = '';
let published = false;
function inspect(data) {
  const chunk = data.toString();
  process.stdout.write(chunk);
  log = (log + chunk).slice(-20000);
  if (!published) {
    const match = log.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      fs.writeFileSync(shareFile, match[0], 'utf8');
      published = true;
      console.log(`SHARE_URL=${match[0]}`);
    }
  }
}
child.stdout.on('data', inspect);
child.stderr.on('data', inspect);
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));

function stop() {
  if (!child.killed) child.kill();
  setTimeout(() => process.exit(0), 3000).unref();
}
setInterval(() => {
  try { process.kill(ownerPid, 0); }
  catch { stop(); }
}, 1500);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
