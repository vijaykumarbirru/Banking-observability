// One JSON object per line on stdout, matching the other services.
const write = (level, message, fields = {}) =>
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'notification-service', message, ...fields }) + '\n',
  );

export const log = {
  info: (message, fields) => write('INFO', message, fields),
  warn: (message, fields) => write('WARN', message, fields),
  error: (message, fields) => write('ERROR', message, fields),
};
