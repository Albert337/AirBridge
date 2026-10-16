@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 请右键此文件，选择“以管理员身份运行”。
  pause
  exit /b 1
)

echo 正在允许 AirBridge 使用 TCP 8787-8797 端口...
netsh advfirewall firewall delete rule name="AirBridge 8787" >nul 2>&1
netsh advfirewall firewall delete rule name="AirBridge 8787-8797" >nul 2>&1
netsh advfirewall firewall add rule name="AirBridge 8787-8797" dir=in action=allow protocol=TCP localport=8787-8797 profile=private

if %errorlevel% equ 0 (
  echo.
  echo 设置完成。请重新启动 AirBridge，并确保手机和电脑连接同一个 Wi-Fi。
) else (
  echo 设置失败，请确认当前账户具有管理员权限。
)
pause
