import {
  acquirePublisherLock,
  releasePublisherLock,
} from '../render/publisher.js';

export function createWeeklyIngestion({ contentService, releasesRoot } = {}) {
  if (!contentService?.ingestWeeklyDraft) {
    throw new TypeError('contentService with weekly ingestion is required');
  }
  if (!releasesRoot) throw new TypeError('releasesRoot is required');
  return Object.freeze({
    upsertDraft(input) {
      const lock = acquirePublisherLock(releasesRoot);
      try {
        return contentService.ingestWeeklyDraft(input);
      } finally {
        releasePublisherLock(lock);
      }
    },
  });
}
