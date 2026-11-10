const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let threshold = LEVELS.warn;

const SINK = [];

export const setLogLevel = (name) => {
  if (typeof name === 'string' && name in LEVELS) threshold = LEVELS[name];
  else if (typeof name === 'number') threshold = name;
};

export const getLogs = () => SINK.slice();

export const clearLogs = () => {
  SINK.length = 0;
};

const emit = (level, scope, message, data) => {
  if (LEVELS[level] < threshold) return;
  const entry = {
    time: Date.now(),
    level,
    scope,
    message,
    data: data === undefined ? undefined : data,
  };
  SINK.push(entry);
  if (SINK.length > 500) SINK.shift();
  const line = `[photografix:${scope}] ${message}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
};

export const createLogger = (scope) => ({
  debug: (m, d) => emit('debug', scope, m, d),
  info: (m, d) => emit('info', scope, m, d),
  warn: (m, d) => emit('warn', scope, m, d),
  error: (m, d) => emit('error', scope, m, d),
});
