@echo off
rem Builds the two downloads of the demo into dist\ : FanucRmiDemo.exe and fanuc-rmi-demo-python.zip
setlocal
cd /d "%~dp0"
if exist dist rmdir /s /q dist

echo === .NET backend: one executable with the .NET runtime and the web page inside (settings in the csproj)
dotnet publish src\Backend.DotNet -c Release -o dist -nologo || exit /b 1

echo === Python backend: the two scripts and the web page
mkdir dist\fanuc-rmi-demo-python\Client
copy src\Backend.Python\app.py dist\fanuc-rmi-demo-python\ >nul
copy src\Backend.Python\rmi_session.py dist\fanuc-rmi-demo-python\ >nul
copy src\Backend.Python\requirements.txt dist\fanuc-rmi-demo-python\ >nul
xcopy /e /q src\Client dist\fanuc-rmi-demo-python\Client\ >nul
rem tar writes forward slashes in the zip. Compress-Archive of Windows PowerShell writes backslashes, and Linux cannot unzip them.
"%SystemRoot%\System32\tar.exe" -a -c -f dist\fanuc-rmi-demo-python.zip -C dist fanuc-rmi-demo-python || exit /b 1
rmdir /s /q dist\fanuc-rmi-demo-python

dir /b dist
