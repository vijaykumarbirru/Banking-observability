import { trace } from '@opentelemetry/api';

// trace_id / span_id link a log line to its trace in Grafana (empty when there is no active span).
const traceFields = () => {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
};

// One JSON object per line on stdout, matching the other services.
const write = (level, message, fields = {}) =>
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(), level, service: 'notification-service', message, ...traceFields(), ...fields,
    }) + '\n',
  );

export const log = {
  info: (message, fields) => write('INFO', message, fields),
  warn: (message, fields) => write('WARN', message, fields),
  error: (message, fields) => write('ERROR', message, fields),
};
