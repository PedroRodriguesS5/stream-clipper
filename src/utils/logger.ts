export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

export const log = (level: LogLevel, moduleName: string, message: string, meta?: unknown): void => {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}] [${moduleName}]`;
  if (meta !== undefined) {
    console.log(`${prefix} ${message}`, typeof meta === 'object' ? JSON.stringify(meta) : meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
};
