const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

async function freePort() {
  const holder = http.createServer();
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const port = holder.address().port;
  await new Promise(resolve => holder.close(resolve));
  return port;
}

async function waitForHealth(port, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/health');
      if (response.status === 200) return JSON.parse(response.body);
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`AirBridge did not start on port ${port}`);
}

function start(args) {
  return spawn(process.execPath, ['server.js', ...args], {
    cwd: root,
    env: { ...process.env, PORT: '', LAN_IP: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2500))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('CLI help and validation', async () => {
  const help = await execFileAsync(process.execPath, ['server.js', '--help'], { cwd: root });
  assert.match(help.stdout, /--port/);
  assert.match(help.stdout, /--lan-ip/);
  assert.match(help.stdout, /--no-open/);
  await assert.rejects(
    execFileAsync(process.execPath, ['server.js', '--port', 'invalid'], { cwd: root }),
    error => error.code === 1 && /无效端口/.test(error.stderr)
  );
});

test('HTTP, QR, signaling and duplicate-instance reuse', { timeout: 15000 }, async t => {
  const port = await freePort();
  const child = start(['--port', String(port), '--no-open']);
  t.after(() => stop(child));

  const health = await waitForHealth(port);
  assert.equal(health.service, 'AirBridge');
  assert.equal(health.port, port);
  assert.equal(health.version, '1.5.0');

  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /id="pickBtn"/);
  assert.match(page.body, /a\.download=item\.name/);

  const room = await request(port, '/api/room');
  if (room.status === 200) {
    const data = JSON.parse(room.body);
    assert.match(data.code, /^\d{6}$/);
    assert.doesNotMatch(data.url, /127\.0\.0\.1/);
    assert.match(data.qr, /^data:image\/png;base64,/);
  } else {
    assert.equal(room.status, 503);
    assert.match(JSON.parse(room.body).error, /IPv4/);
  }

  const first = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const second = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([once(first, 'open'), once(second, 'open')]);
  first.send(JSON.stringify({ type: 'join', room: '123456' }));
  const [firstJoined] = await once(first, 'message');
  assert.equal(JSON.parse(firstJoined).type, 'joined');
  const peerJoined = once(first, 'message');
  second.send(JSON.stringify({ type: 'join', room: '123456' }));
  const [[notice], [secondJoined]] = await Promise.all([peerJoined, once(second, 'message')]);
  assert.equal(JSON.parse(notice).type, 'peer-joined');
  assert.equal(JSON.parse(secondJoined).count, 2);
  first.close();
  second.close();

  const duplicate = start(['--port', String(port), '--no-open']);
  let output = '';
  duplicate.stdout.on('data', chunk => { output += chunk; });
  await once(duplicate, 'exit');
  assert.equal(duplicate.exitCode, 0);
  assert.match(output, /已在运行/);
});
