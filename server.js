const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseArgs } = require('util');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { version: VERSION } = require('./package.json');

const DEFAULT_PORT = 8787;
const MAX_FALLBACK_PORT = DEFAULT_PORT + 10;
let PORT = DEFAULT_PORT;
let preferredLanIp = '';
let shouldOpenBrowser = true;
let canFallbackPort = true;
let shuttingDown = false;

function parseIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return parts;
}

function isPrivateIPv4(address) {
  const p = parseIPv4(address);
  if (!p) return false;
  return p[0] === 10 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}

function isUsableIPv4(address) {
  const p = parseIPv4(address);
  if (!p) return false;
  return p[0] !== 0 && p[0] !== 127 &&
    !(p[0] === 169 && p[1] === 254) && p[0] < 224;
}

function lanIPv4s() {
  const result = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal && isUsableIPv4(n.address)) {
        result.push({ name, address: n.address, private: isPrivateIPv4(n.address) });
      }
    }
  }
  if (preferredLanIp) {
    result.sort((a, b) => Number(b.address === preferredLanIp) - Number(a.address === preferredLanIp));
  }
  return result;
}

function lanIPv4() {
  return lanIPv4s()[0]?.address || null;
}

function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      port: { type: 'string', short: 'p' },
      'lan-ip': { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  const portText = values.port ?? env.PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(portText)) throw new Error(`无效端口：${portText}`);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口：${portText}`);
  const lanIp = values['lan-ip'] ?? env.LAN_IP ?? '';
  if (lanIp && !isUsableIPv4(lanIp)) throw new Error(`无效 LAN IPv4：${lanIp}`);
  return {
    help: Boolean(values.help),
    port,
    lanIp,
    openBrowser: !values['no-open'],
    canFallback: values.port === undefined && env.PORT === undefined
  };
}

function printHelp() {
  console.log(`AirBridge v${VERSION} - 局域网文件互传

用法：
  airbridge [选项]
  npm start -- [选项]

选项：
  -p, --port <端口>     指定端口，默认 8787
      --lan-ip <地址>   多网卡时指定手机可访问的 IPv4
      --no-open         启动后不自动打开浏览器
  -h, --help            显示帮助`);
}

function loadEmbeddedIndex() {
  try {
    const sea = require('node:sea');
    return sea.isSea() ? sea.getAsset('index.html', 'utf8') : null;
  } catch {
    return null;
  }
}

function createApplication() {
  const application = express();
  const embeddedIndex = loadEmbeddedIndex();
  if (embeddedIndex) {
    application.get('/', (req, res) => res.type('html').send(embeddedIndex));
  } else {
    application.use(express.static(path.join(__dirname, 'public')));
  }
  return application;
}

const app = createApplication();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();

function roomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'AirBridge', version: VERSION, pid: process.pid, port: PORT, lan: lanIPv4s() });
});

app.get('/api/network', (req, res) => {
  const ips = lanIPv4s();
  res.json({
    ips,
    primary: ips[0]?.address || null,
    port: PORT,
    urls: ips.map(x => `http://${x.address}:${PORT}`)
  });
});

app.get('/api/room', async (req, res) => {
  let code = roomCode();
  while (rooms.has(code)) code = roomCode();
  rooms.set(code, new Set());

  const ip = lanIPv4();
  if (!ip) {
    rooms.delete(code);
    return res.status(503).json({
      error: '未检测到可供手机访问的 IPv4 地址，请检查 Wi-Fi/网线连接或设置 --lan-ip。',
      lan: []
    });
  }
  const url = `http://${ip}:${PORT}/?room=${code}`;
  const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
  res.json({ code, url, qr, lan: lanIPv4s(), warning: null });
});

wss.on('connection', ws => {
  let room = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      const nextRoom = String(msg.room || '').replace(/\D/g, '').slice(0, 6);
      if (!/^\d{6}$/.test(nextRoom)) return send(ws, { type: 'error', message: '房间码无效' });
      if (room && rooms.has(room)) {
        rooms.get(room).delete(ws);
        if (!rooms.get(room).size) rooms.delete(room);
      }
      room = nextRoom;
      if (!rooms.has(room)) rooms.set(room, new Set());
      const peers = rooms.get(room);
      const existing = [...peers].filter(peer => peer.readyState === 1);
      peers.add(ws);
      ws.peerId = Math.random().toString(36).slice(2, 10);
      send(ws, { type: 'joined', peerId: ws.peerId, count: existing.length + 1 });
      existing.forEach(peer => send(peer, { type: 'peer-joined', peerId: ws.peerId }));
      return;
    }

    if (msg.type === 'signal' && room) {
      for (const peer of rooms.get(room) || []) {
        if (peer !== ws && peer.readyState === 1) {
          send(peer, { type: 'signal', from: ws.peerId, data: msg.data });
        }
      }
    }
  });

  ws.on('close', () => {
    if (!room || !rooms.has(room)) return;
    const peers = rooms.get(room);
    peers.delete(ws);
    for (const peer of peers) send(peer, { type: 'peer-left', peerId: ws.peerId });
    if (!peers.size) rooms.delete(room);
  });
});

wss.on('error', error => {
  if (!['EADDRINUSE', 'EACCES'].includes(error.code)) console.error('WebSocket 服务异常：', error.message);
});

function probeAirBridge(port, timeout = 500) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 8192) body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data?.ok && data?.service === 'AirBridge' ? { port, data } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findRunningInstance(ports) {
  const results = await Promise.all(ports.map(port => probeAirBridge(port)));
  return results.find(Boolean) || null;
}

function openUrl(url) {
  const commands = {
    win32: [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]]
  };
  const selected = commands[process.platform];
  if (!selected) return;
  const child = spawn(selected[0], selected[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', error => console.warn(`无法自动打开浏览器：${error.message}`));
  child.unref();
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function startServer() {
  while (true) {
    try {
      await listenOnce(PORT);
      return;
    } catch (error) {
      if (error.code === 'EADDRINUSE' && canFallbackPort && PORT < MAX_FALLBACK_PORT) {
        console.warn(`端口 ${PORT} 已被占用，自动尝试备用端口 ${PORT + 1}…`);
        PORT += 1;
        continue;
      }
      throw error;
    }
  }
}

function printReady() {
  console.log('\n========================================');
  console.log(` AirBridge v${VERSION}`);
  console.log('========================================');
  console.log(` 电脑访问：http://localhost:${PORT}`);
  const ips = lanIPv4s();
  if (ips.length) {
    console.log(' 手机访问：');
    for (const item of ips) console.log(`   http://${item.address}:${PORT}  (${item.name})`);
  } else {
    console.log(' 提示：未检测到手机可访问的 IPv4 地址');
  }
  console.log(' 按 Ctrl+C 退出');
  console.log('========================================\n');
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭 AirBridge…`);
  for (const client of wss.clients) client.terminate();
  wss.close(() => server.close(() => {
    console.log('AirBridge 已安全退出。');
    process.exit(0);
  }));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.once('SIGINT', () => shutdown('Ctrl+C'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  let options;
  try {
    options = parseOptions();
  } catch (error) {
    console.error(error.message);
    console.error('运行 airbridge --help 查看用法。');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  PORT = options.port;
  preferredLanIp = options.lanIp;
  shouldOpenBrowser = options.openBrowser;
  canFallbackPort = options.canFallback;

  if (preferredLanIp && !lanIPv4s().some(item => item.address === preferredLanIp)) {
    console.error(`当前电脑没有 IPv4 地址 ${preferredLanIp}。`);
    const available = lanIPv4s().map(item => item.address).join('、') || '无';
    console.error(`可用地址：${available}`);
    process.exitCode = 1;
    return;
  }

  const ports = canFallbackPort
    ? Array.from({ length: MAX_FALLBACK_PORT - DEFAULT_PORT + 1 }, (_, i) => DEFAULT_PORT + i)
    : [PORT];
  const running = await findRunningInstance(ports);
  if (running) {
    const url = `http://localhost:${running.port}`;
    console.log(`AirBridge 已在运行：${url}`);
    if (shouldOpenBrowser) openUrl(url);
    return;
  }

  try {
    await startServer();
  } catch (error) {
    if (error.code === 'EADDRINUSE') console.error(`无法启动：端口 ${PORT} 已被其他程序占用。`);
    else if (error.code === 'EACCES') console.error(`无法启动：没有权限监听端口 ${PORT}。`);
    else console.error(`AirBridge 启动失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  printReady();
  if (shouldOpenBrowser) openUrl(`http://localhost:${PORT}`);
}

main().catch(error => {
  console.error(`AirBridge 启动失败：${error.message}`);
  process.exitCode = 1;
});
