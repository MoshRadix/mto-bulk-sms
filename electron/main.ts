import { app, BrowserWindow, dialog, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import { registerSetupIpc } from './ipc/setup.ipc';

/** Create the isolated renderer; database and secret access remain in this main process. */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'MTO Bulk SMS Manager',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../assets/mtobulksms.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  dev ? win.loadURL(dev) : win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function configureAutoUpdates() {
  // electron-updater's GitHub feed is only available in installed Windows builds.
  if (!app.isPackaged || process.platform !== 'win32') return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', async ({ version }) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Version ${version} is ready to install.`,
      detail: 'Restart the application to finish installing the update.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (error) => console.error('Update check failed:', error));
  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error('Update check failed:', error);
  });
}

app.whenReady().then(() => {
  // Deny web permission prompts before loading any renderer content.
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  registerSetupIpc();
  createWindow();
  configureAutoUpdates();
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
