import { app, BrowserWindow, session } from 'electron';
import path from 'path';
import { registerSetupIpc } from './ipc/setup.ipc';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'MTO Bulk SMS Manager',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  dev ? win.loadURL(dev) : win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  registerSetupIpc();
  createWindow();
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
