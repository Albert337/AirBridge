const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

function roomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isPrivateIPv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  return p[0] === 10 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}

function lanIPv4s() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal && isPrivateIPv4(n.address)) {
        result.push({ name, address: n.address });
      }
    }
  }
  return result;
}

function lanIPv4() {
  const candidates = lanIPv4s();
  return candidates[0]?.address || '127.0.0.1';
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'AirBridge', port: PORT, lan: lanIPv4s() });
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

  // IMPORTANT: Never use localhost / 127.0.0.1 for the QR code.
  // The phone must connect to the computer's LAN address.
  const ip = lanIPv4();
  const url = `http://${ip}:${PORT}/?room=${code}`;
  const qr = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 280
  });

  res.json({
    code,
    url,
    qr,
    lan: lanIPv4s(),
    warning: ip === '127.0.0.1' ? '未检测到局域网 IPv4，请检查 Wi-Fi/网线连接。' : null
  });
});

wss.on('connection', (ws) => {
  let room = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      room = String(msg.room || '').replace(/\D/g, '').slice(0, 6);
      if (!/^\d{6}$/.test(room)) {
        return send(ws, { type: 'error', message: '房间码无效' });
      }
      if (!rooms.has(room)) rooms.set(room, new Set());
      const peers = rooms.get(room);
      const existing = [...peers].filter(p => p.readyState === 1);
      peers.add(ws);
      ws.peerId = Math.random().toString(36).slice(2, 10);
      send(ws, { type: 'joined', peerId: ws.peerId, count: existing.length + 1 });
      existing.forEach(p => send(p, { type: 'peer-joined', peerId: ws.peerId }));
      return;
    }

    if (msg.type === 'signal' && room) {
      const peers = rooms.get(room) || new Set();
      for (const p of peers) {
        if (p !== ws && p.readyState === 1) {
          send(p, { type: 'signal', from: ws.peerId, data: msg.data });
        }
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(ws);
    for (const p of peers) send(p, { type: 'peer-left', peerId: ws.peerId });
    if (!peers.size) rooms.delete(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log(' AirBridge v1.4');
  console.log('========================================');
  console.log(` Local: http://localhost:${PORT}`);
  const ips = lanIPv4s();
  if (ips.length) {
    console.log(' LAN addresses:');
    for (const item of ips) console.log(`   http://${item.address}:${PORT}  (${item.name})`);
  } else {
    console.log(' WARNING: 未检测到局域网 IPv4 地址');
  }
  console.log('');
  console.log('手机扫码时必须使用 LAN 地址，不能使用 localhost。');
  console.log('========================================');
  console.log('');
});
