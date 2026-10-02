import { APP_NAME, APP_VERSION } from './util.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function readLevel() {
  const raw = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  return raw in LEVELS ? raw : 'info';
}

let currentLevel = LEVELS[readLevel()];

export function setLogLevel(level) {
  const raw = String(level || '').trim().toLowerCase();
  if (raw in LEVELS) currentLevel = LEVELS[raw];
}

function emit(level, message, extra) {
  if (LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) {
    out(line);
  } else {
    let tail;
    try {
      tail = typeof extra === 'string' ? extra : JSON.stringify(extra);
    } catch {
      tail = String(extra);
    }
    out(`${line} ${tail}`);
  }
}

export const log = {
  error: (msg, extra) => emit('error', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  debug: (msg, extra) => emit('debug', msg, extra),
  banner(extra) {
    emit('info', `${APP_NAME} v${APP_VERSION} 启动`, extra);
  },
};
