/** Minimalan strukturirani logger — radi i u Node workeru i u Vercel funkciji. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} — ${message}`;
  const payload = meta && Object.keys(meta).length > 0 ? `${line} ${JSON.stringify(meta)}` : line;
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', scope, msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => emit('info', scope, msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', scope, msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => emit('error', scope, msg, meta),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
