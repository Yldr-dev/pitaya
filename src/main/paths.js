// Where Pitaya keeps its data. Portable first: a "data" folder next to
// Pitaya.exe. If that folder can't be written (e.g. the app was put in
// Program Files), fall back to %APPDATA%\Pitaya.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveAppDir() {
  // Packaged: folder containing Pitaya.exe. Dev: project root.
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
}

const appDir = resolveAppDir();
const portableData = path.join(appDir, 'data');
const dataDir = isWritable(portableData)
  ? portableData
  : path.join(process.env.APPDATA || app.getPath('appData'), 'Pitaya');

fs.mkdirSync(dataDir, { recursive: true });

const paths = {
  appDir,
  dataDir,
  binDir: path.join(dataDir, 'bin'),
  tempDir: path.join(dataDir, 'temp'),
  updateDir: path.join(dataDir, 'update'),
  logFile: path.join(dataDir, 'pitaya.log'),
  configFile: path.join(dataDir, 'config.json'),
  electronData: path.join(dataDir, 'electron'),
  isPortable: dataDir === portableData,
};

for (const d of [paths.binDir, paths.tempDir]) fs.mkdirSync(d, { recursive: true });

module.exports = paths;
