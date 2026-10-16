import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';

const { inject } = postject;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const downloadDir = path.join(buildDir, 'downloads');
const bundle = path.join(buildDir, 'airbridge.cjs');
const blob = path.join(buildDir, 'sea-prep.blob');
const config = path.join(buildDir, 'sea-config.json');
const nodeVersion = process.version;
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const serverSource = await readFile(path.join(root, 'server.js'), 'utf8');
const buildAll = process.argv.includes('--all');
const targets = buildAll
  ? [
      { platform: 'win32', arch: 'x64' },
      { platform: 'linux', arch: 'x64' },
      { platform: 'darwin', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' }
    ]
  : [{ platform: process.platform, arch: process.arch }];

await mkdir(buildDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });
await Promise.all([
  rm(bundle, { force: true }),
  rm(blob, { force: true }),
  rm(config, { force: true })
]);

await build({
  absWorkingDir: root,
  stdin: {
    contents: serverSource,
    resolveDir: root,
    sourcefile: 'server.js',
    loader: 'js'
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  minify: false,
  sourcemap: false,
  logLevel: 'info'
});

await writeFile(config, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { 'index.html': path.join(root, 'public', 'index.html') }
}, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const blobData = await readFile(blob);

async function download(url, destination) {
  try {
    await stat(destination);
    return;
  } catch {}

  console.log(`下载：${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 (${response.status})：${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

let checksumText;
async function getRuntime(target) {
  if (target.platform === process.platform && target.arch === process.arch) return process.execPath;

  const distPlatform = target.platform === 'win32' ? 'win' : target.platform;
  const extension = target.platform === 'win32' ? 'zip' : 'tar.xz';
  const basename = `node-${nodeVersion}-${distPlatform}-${target.arch}`;
  const archiveName = `${basename}.${extension}`;
  const archive = path.join(downloadDir, archiveName);
  const baseUrl = `https://nodejs.org/dist/${nodeVersion}`;

  await download(`${baseUrl}/${archiveName}`, archive);
  checksumText ??= await (await fetch(`${baseUrl}/SHASUMS256.txt`)).text();
  const expected = checksumText.split(/\r?\n/).find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`官方校验文件中没有找到 ${archiveName}`);
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (actual !== expected) throw new Error(`${archiveName} SHA-256 校验失败`);

  const extracted = path.join(downloadDir, basename);
  const runtime = path.join(extracted, target.platform === 'win32' ? 'node.exe' : 'bin', target.platform === 'win32' ? '' : 'node');
  try {
    await stat(runtime);
  } catch {
    await rm(extracted, { recursive: true, force: true });
    const runtimeMember = target.platform === 'win32' ? `${basename}/node.exe` : `${basename}/bin/node`;
    execFileSync('tar', ['-xf', archive, '-C', downloadDir, runtimeMember], { stdio: 'inherit' });
  }
  return runtime;
}

function verifyExecutable(data, target) {
  const fuse = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1');
  if (!data.includes(fuse)) throw new Error(`${target.platform}-${target.arch} SEA 注入校验失败`);

  if (target.platform === 'win32') {
    const peOffset = data.readUInt32LE(0x3c);
    if (data.subarray(0, 2).toString() !== 'MZ' || data.readUInt16LE(peOffset + 4) !== 0x8664) {
      throw new Error('Windows 产物不是有效的 x64 PE 文件');
    }
  }
  if (target.platform === 'linux') {
    const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    if (!data.subarray(0, 4).equals(elfMagic) || data.readUInt16LE(18) !== 0x3e) {
      throw new Error('Linux 产物不是有效的 x64 ELF 文件');
    }
  }
  if (target.platform === 'darwin') {
    const magic = data.readUInt32LE(0);
    const cpu = data.readUInt32LE(4);
    const expectedCpu = target.arch === 'arm64' ? 0x0100000c : 0x01000007;
    if (magic !== 0xfeedfacf || cpu !== expectedCpu) throw new Error(`macOS ${target.arch} Mach-O 架构校验失败`);
  }
}

async function buildTarget(target) {
  const outputDir = path.join(root, 'dist', `AirBridge-${target.platform}-${target.arch}`);
  const executableName = target.platform === 'win32' ? 'AirBridge.exe' : 'AirBridge';
  const executable = path.join(outputDir, executableName);
  const runtime = await getRuntime(target);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyFile(runtime, executable);

  if (target.platform === 'darwin' && process.platform === 'darwin') {
    try { execFileSync('codesign', ['--remove-signature', executable], { stdio: 'ignore' }); } catch {}
  }

  await inject(executable, 'NODE_SEA_BLOB', blobData, {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: target.platform === 'darwin' ? 'NODE_SEA' : undefined
  });
  await chmod(executable, 0o755);

  if (target.platform === 'darwin') {
    if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
    const launcher = '#!/bin/sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nchmod +x "$DIR/AirBridge"\ncodesign --remove-signature "$DIR/AirBridge" >/dev/null 2>&1 || true\ncodesign --force --sign - "$DIR/AirBridge" || exit 1\nexec "$DIR/AirBridge" "$@"\n';
    const launcherPath = path.join(outputDir, 'Start AirBridge.command');
    await writeFile(launcherPath, launcher);
    await chmod(launcherPath, 0o755);
  } else if (target.platform === 'linux') {
    const launcher = '#!/bin/sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nchmod +x "$DIR/AirBridge"\nexec "$DIR/AirBridge" "$@"\n';
    const launcherPath = path.join(outputDir, 'start-airbridge.sh');
    await writeFile(launcherPath, launcher);
    await chmod(launcherPath, 0o755);
  } else {
    const firewallOutput = path.join(outputDir, 'Allow Firewall Access.bat');
    try {
      await copyFile(path.join(root, 'allow-firewall-windows.bat'), firewallOutput);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(firewallOutput, '@echo off\r\nnetsh advfirewall firewall add rule name="AirBridge 8787-8797" dir=in action=allow protocol=TCP localport=8787-8797 profile=private\r\npause\r\n');
    }
  }

  const start = target.platform === 'win32'
    ? '双击 AirBridge.exe 启动。'
    : target.platform === 'darwin'
      ? '首次使用请在终端执行：chmod +x AirBridge "Start AirBridge.command"\n然后双击 Start AirBridge.command。'
      : '首次使用请执行：chmod +x AirBridge start-airbridge.sh && ./start-airbridge.sh';
  await writeFile(path.join(outputDir, 'README.txt'), `AirBridge v${version}\n适用系统：${target.platform}-${target.arch}\n\n${start}\n`, 'utf8');

  verifyExecutable(await readFile(executable), target);
  console.log(`已生成并校验：${outputDir}`);
}

for (const target of targets) await buildTarget(target);
