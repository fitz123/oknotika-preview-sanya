import process from 'node:process';
import {
  acquirePublisherLock,
  releasePublisherLock,
} from '../../src/render/publisher.js';

const [releasesRoot] = process.argv.slice(2);
let lock = null;

process.on('message', (message) => {
  if (message?.type === 'acquire') {
    try {
      lock = acquirePublisherLock(releasesRoot);
      process.send?.({ type: 'acquired' });
    } catch (error) {
      if (!/Another publisher holds the release lock/.test(error.message)) throw error;
      process.send?.({ type: 'busy' }, () => process.exit(0));
    }
  } else if (message?.type === 'release' && lock) {
    releasePublisherLock(lock);
    lock = null;
    process.send?.({ type: 'released' }, () => process.exit(0));
  }
});

process.send?.({ type: 'ready' });
