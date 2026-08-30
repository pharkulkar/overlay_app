@echo off
:: ============================================================================
:: Background Launcher for Electron Overlay
:: ============================================================================

:: 1. Define temporary VBScript file path
set VBS_FILE=%temp%\run_electron_hidden.vbs

:: 2. Create VBScript wrapper that hides the CMD window (0 = Hidden Window)
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_FILE%"
echo WshShell.Run "cmd /c npm start", 0, False >> "%VBS_FILE%"

:: 3. Execute VBScript to launch Electron in the background
cscript //nologo "%VBS_FILE%"

:: 4. Clean up temporary VBScript file
del "%VBS_FILE%"

exit