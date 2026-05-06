const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const server = require('./server');

nativeTheme.themeSource = 'dark';
app.disableHardwareAcceleration();

let controlPanel;

function createControlPanel() {
  controlPanel = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 680,
    minHeight: 600,
    title: 'Panel de Control — JotaOverlay',
    backgroundColor: '#111318',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  controlPanel.loadFile(path.join(__dirname, 'control-panel', 'index.html'));
  controlPanel.setMenuBarVisibility(false);

  // Focus fix for Windows
  controlPanel.on('focus', () => {
    controlPanel.webContents.focus();
  });

  // Open external links in the default browser
  controlPanel.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  controlPanel.on('closed', () => {
    app.quit();
  });

  controlPanel.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'local-fonts') {
      callback(true);
    } else {
      callback(true);
    }
  });
}

app.whenReady().then(() => {
  server.start(__dirname);
  createControlPanel();
});

app.on('window-all-closed', () => {
  app.quit();
});
