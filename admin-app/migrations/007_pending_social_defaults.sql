PRAGMA foreign_keys = ON;

CREATE TABLE pending_social_link_defaults (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  telegram_url TEXT NOT NULL,
  youtube_url TEXT,
  vk_url TEXT,
  futuchat_url TEXT
);

INSERT INTO pending_social_link_defaults
  (singleton, telegram_url, youtube_url, vk_url, futuchat_url)
SELECT singleton, telegram_url, youtube_url, vk_url, futuchat_url
FROM site_social_links
WHERE singleton = 1;
