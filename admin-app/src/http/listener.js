import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function startListener(server, listener, onListening = () => {}) {
  if (listener.mode === 'unix') {
    mkdirSync(dirname(listener.path), { recursive: true, mode: 0o700 });
    rmSync(listener.path, { force: true });
    server.listen(listener.path, () => {
      chmodSync(listener.path, 0o660);
      onListening();
    });
    return;
  }
  server.listen(listener.port, listener.host, onListening);
}

export function stopListener(server, listener, onStopped = () => {}) {
  server.close(() => {
    if (listener.mode === 'unix') rmSync(listener.path, { force: true });
    onStopped();
  });
}
