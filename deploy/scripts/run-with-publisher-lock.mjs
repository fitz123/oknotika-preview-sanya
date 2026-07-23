#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  acquirePublisherLock,
  releasePublisherLock,
} from '../../admin-app/src/render/publisher.js';

const [releasesRootArgument, command, ...args] = process.argv.slice(2);
if (!releasesRootArgument || !command) {
  throw new Error('Usage: run-with-publisher-lock.mjs RELEASES_ROOT COMMAND [ARG ...]');
}

const deadline = Date.now() + 60_000;
let lock;
while (!lock) {
  try {
    lock = acquirePublisherLock(resolve(releasesRootArgument));
  } catch (error) {
    if (!/Another publisher/.test(error.message) || Date.now() >= deadline) throw error;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
}

try {
  const status = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: { ...process.env, OKNOTIKA_PUBLISHER_LOCK_HELD: '1' },
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) rejectPromise(new Error(`Locked command terminated by ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
  process.exitCode = status;
} finally {
  releasePublisherLock(lock);
}
