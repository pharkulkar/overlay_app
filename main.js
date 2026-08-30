// const { app, BrowserWindow } = require('electron');

// function createOverlayWindow() {
//   const overlayWindow = new BrowserWindow({
//     width: 800,
//     height: 600,
//     alwaysOnTop: true,
//     frame: false,
//     transparent: true,
//     hasShadow: false,
//     webPreferences: {
//       contextIsolation: true,
//       nodeIntegration: false
//     }
//   });

//   // Hides window from macOS QuickTime / Zoom screen sharing
//   overlayWindow.setContentProtection(true);
// //   overlayWindow.loadURL('http://192.168.0.103:5000/typings');
// overlayWindow.loadFile('index.html');
//   return overlayWindow;
// }

// app.whenReady().then(() => {
//   createOverlayWindow();
//   console.log('Overlay running on macOS.');
// });

// app.on('window-all-closed', () => {
//   if (process.platform !== 'darwin') app.quit();
// });

// ----------------------------------------------------------


const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let overlayWindow;

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 1. PIN TO ALL VIRTUAL DESKTOPS / SPACES (macOS & Windows)
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  
  // 2. HIGHEST ALWAYS-ON-TOP PRIORITY LEVEL
  // "screen-saver" level keeps it above full-screen apps and space switches
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  overlayWindow.setContentProtection(true);
  overlayWindow.loadURL('http://192.168.0.103:3000/typings');
//   overlayWindow.loadFile('index.html');
}

// Write speech transcription to conversation.txt
ipcMain.on('save-transcript', (event, { speaker, text }) => {
  const logFilePath = path.join(__dirname, 'conversation.txt');
  const timestamp = new Date().toLocaleTimeString();
  const logLine = `[${timestamp}] ${speaker}: ${text}\n`;

  fs.appendFile(logFilePath, logLine, (err) => {
    if (err) console.error('Failed to write transcript:', err);
  });
});

// 3. LISTEN FOR MINIMIZE / EXPAND TOGGLE FROM RENDERER
ipcMain.on('toggle-overlay-mode', (event, isMinimized) => {
  if (!overlayWindow) return;

  if (isMinimized) {
    // Shrink window down to a small square for the floating dot
    overlayWindow.setSize(50, 50);
  } else {
    // Restore full overlay size
    overlayWindow.setSize(400, 300);
  }
});

app.whenReady().then(createOverlayWindow);