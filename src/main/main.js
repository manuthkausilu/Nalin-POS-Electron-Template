const { app, BrowserWindow, dialog } = require('electron');
// 🛑 Add this fix!
app.disableHardwareAcceleration();
// Optional:
app.commandLine.appendSwitch('disable-gpu');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let backendProcess;
let loadingWindow;
let mainWindow;
let isBackendReady = false;

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    alwaysOnTop: true,
    transparent: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  loadingWindow.loadFile(path.join(__dirname, '../../public/loading.html'));
  loadingWindow.center();
}

function checkBackendHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:8080', () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend() {
  console.log('Waiting for backend to be ready...');
  while (!isBackendReady) {
    const isHealthy = await checkBackendHealth();
    if (isHealthy) {
      isBackendReady = true;
      console.log('Backend is ready!');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function startBackend() {
  return new Promise((resolve, reject) => {
    // ✅ Use app.isPackaged instead of NODE_ENV
    const jarPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'backend.jar')
      : path.resolve(__dirname, '../../backend/backend.jar');

    console.log('Starting backend from:', jarPath);

    backendProcess = spawn('java', ['-jar', jarPath], {
      cwd: path.dirname(jarPath),
      stdio: 'pipe'
    });

    let startupDetected = false;

    backendProcess.stdout.on('data', async data => {
      console.log(`BACKEND: ${data}`);
      const output = data.toString();

      if (!startupDetected && (
        (output.includes('Started') && output.includes('Application')) ||
        output.includes('Tomcat started') ||
        output.includes('JVM running') ||
        output.includes('Spring Boot')
      )) {
        startupDetected = true;
        setTimeout(async () => {
          await waitForBackend();
          resolve();
        }, 3000);
      }
    });

    backendProcess.stderr.on('data', data => {
      console.error(`BACKEND ERROR: ${data}`);
      dialog.showErrorBox('Backend Error', data.toString());
    });

    backendProcess.on('error', (error) => {
      console.error('Failed to start backend:', error);
      reject(error);
    });

    backendProcess.on('close', (code) => {
      console.log(`Backend exited with code ${code}`);
      isBackendReady = false;
      if (!startupDetected && code !== 0) {
        reject(new Error(`Backend exited with code ${code}`));
      }
    });

    setTimeout(async () => {
      if (!startupDetected) {
        console.log('No startup message detected, trying health check anyway...');
        await waitForBackend();
        if (isBackendReady) {
          startupDetected = true;
          resolve();
        } else {
          reject(new Error('Backend failed to start within timeout period'));
        }
      }
    }, 30000);
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'));

  mainWindow.once('ready-to-show', () => {
    if (loadingWindow) {
      loadingWindow.close();
      loadingWindow = null;
    }
    mainWindow.show();
  });
}

function stopBackend() {
  return new Promise((resolve) => {
    if (backendProcess) {
      console.log('Stopping backend...');
      backendProcess.kill('SIGTERM');

      setTimeout(() => {
        if (backendProcess && !backendProcess.killed) {
          console.log('Force killing backend...');
          backendProcess.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      backendProcess.on('close', () => {
        console.log('Backend stopped');
        backendProcess = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

app.whenReady().then(async () => {
  try {
    createLoadingWindow();
    await startBackend();
    createMainWindow();
  } catch (error) {
    console.error('Failed to start application:', error);
    dialog.showErrorBox('Startup Error', 'Failed to start the backend service. Please check your Java installation.');
    app.quit();
  }
});

app.on('window-all-closed', async () => {
  await stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (backendProcess && !backendProcess.killed) {
    event.preventDefault();
    await stopBackend();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (isBackendReady) {
      createMainWindow();
    } else {
      app.whenReady().then(async () => {
        try {
          createLoadingWindow();
          await startBackend();
          createMainWindow();
        } catch (error) {
          console.error('Failed to restart application:', error);
          app.quit();
        }
      });
    }
  }
});
