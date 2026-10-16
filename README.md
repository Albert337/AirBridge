# AirBridge

AirBridge 是一个局域网文件互传工具。电脑启动后，手机扫描二维码即可连接；文件通过 WebRTC 在设备间直接传输，不上传到云端。

## 最简单的用法（推荐）

电脑和手机需要连接同一个 Wi-Fi。

### Windows

1. 解压 `AirBridge-windows-latest`。
2. 双击 `AirBridge.exe`，浏览器会自动打开。
3. 手机扫描网页上的二维码。
4. 两端都可以选择文件并发送；手机收到文件后，点击“下载文件”保存。

如果手机打不开二维码地址，请右键 `Allow Firewall Access.bat`，选择“以管理员身份运行”，然后重新启动 AirBridge。

### macOS

1. Apple 芯片（M1/M2/M3/M4 等）使用 `AirBridge-darwin-arm64`，Intel 芯片使用 `AirBridge-darwin-x64`。
2. 双击 `Start AirBridge.command`。
3. 如果不能双击，先在该目录打开终端并执行 `chmod +x AirBridge "Start AirBridge.command"`，再右键启动脚本选择“打开”。
4. 浏览器打开后，用手机扫描二维码。

### Linux

进入解压目录后运行：

```bash
chmod +x AirBridge start-airbridge.sh
./start-airbridge.sh
```

终端出现 `按 Ctrl+C 退出` 即表示启动成功。

## 命令行选项

```text
AirBridge.exe --help                 查看帮助（Windows）
./AirBridge --help                   查看帮助（Linux/macOS）
AirBridge.exe --port 9000            指定端口
AirBridge.exe --lan-ip 192.168.1.20  指定手机可访问的网卡地址
AirBridge.exe --no-open              不自动打开浏览器
```

默认使用端口 `8787`。如果已被占用，会自动尝试 `8788` 至 `8797`；重复启动时会复用已经运行的 AirBridge，不再报 `EADDRINUSE`。

## 从源码运行

需要先安装 [Node.js 22 或更高版本](https://nodejs.org/)：

```bash
npm install
npm start
```

常用示例：

```bash
npm start -- --port 9000
npm start -- --lan-ip 192.168.1.20
npm start -- --no-open
```

停止服务：回到运行窗口，按 `Ctrl+C`。

## 自己构建安装包

```bash
npm ci
npm test
npm run build
```

`npm run build` 生成当前系统的成品。要在一台电脑上同时生成 Windows x64、Linux x64、macOS Intel 和 macOS Apple 芯片四套成品，运行：

```bash
npm run build:all
```

首次运行会从 Node.js 官网下载对应系统的运行文件并校验 SHA-256，成品位于 `dist/AirBridge-系统名-架构/`。跨平台生成的 macOS 文件会在首次启动时自动执行本机 ad-hoc 签名。

也可以推送 `v*` 标签或手动运行 GitHub Actions 的 `Build AirBridge` 工作流，让三个系统分别原生构建。

## 发布到 GitHub

仓库只提交源码、测试和构建脚本；`node_modules/`、`build/`、`dist/`、`release/` 均不会进入 Git。正式版本将 `dist` 中各平台目录压缩后，作为 GitHub Release 附件上传，不要把大型可执行文件直接提交到仓库。

## 常见问题

- **手机显示无法访问**：确认手机和电脑连接同一个 Wi-Fi，并关闭访客网络或 AP 隔离；Windows 还需允许防火墙访问。
- **二维码中的 IP 不对**：电脑有多个网卡时，用 `--lan-ip` 指定和手机同网段的 IPv4。`127.0.0.1` 只代表本机，不会用于手机二维码。
- **iPhone 收到但找不到文件**：在 Safari 中点击“下载文件”，然后到“文件”App 的“下载项”中查看；传输时尽量让 Safari 保持在前台。
- **端口仍然冲突**：显式换一个端口，例如 `--port 9000`；同时记得在防火墙中允许该端口。
- **没有二维码**：确认电脑已经连接局域网。也可运行 `ipconfig`（Windows）或 `ip addr`（Linux/macOS）查看 IPv4，再用 `--lan-ip` 指定。

## 功能说明

- 电脑与手机双向、多文件传输
- 二维码快速配对
- 32 KiB 分块、流量控制和接收确认，改善移动端稳定性
- iPhone/iPad Safari 下载兼容
- 桌面 Chrome/Edge 可选择下载目录；不支持时自动使用浏览器下载
- 仅限局域网直连，不包含公网中转或 TURN 服务
