@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 请右键此文件，选择“以管理员身份运行”。
  pause
  exit /b 1
)
echo 正在放行 AirBridge TCP 8787 端口...
netsh advfirewall firewall delete rule name="AirBridge 8787" >nul 2>&1
netsh advfirewall firewall add rule name="AirBridge 8787" dir=in action=allow protocol=TCP localport=8787 profile=private
if %errorlevel% equ 0 (
  echo.
  echo 已完成：Windows 专用网络允许 TCP 8787 入站。
  echo 现在重新运行 npm start，然后让手机与电脑连接同一个 Wi-Fi。
) else (
  echo 放行失败，请检查管理员权限。
)
pause
