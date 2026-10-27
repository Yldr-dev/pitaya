// Tiny file logger so problems on other computers can be diagnosed.
const fs = require('fs');
const paths = require('./paths');

const MAX_BYTES = 1024 * 1024;

function rotate() {
  try {
    if (fs.statSync(paths.logFile).size > MAX_BYTES) {
      fs.renameSync(paths.logFile, paths.logFile + '.old');
    }
  } catch {}
}
rotate();

function write(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  try {
    fs.appendFileSync(paths.logFile, line);
  } catch {}
  if (process.env.PITAYA_DEBUG) process.stdout.write(line);
}

module.exports = {
  info: (...a) => write('INFO ', a),
  warn: (...a) => write('WARN ', a),
  error: (...a) => write('ERROR', a),
};
