PRAGMA foreign_keys = ON;

ALTER TABLE site_social_links
ADD COLUMN futuchat_url TEXT;

UPDATE site_social_links
SET youtube_url = COALESCE(youtube_url, 'https://youtube.com/@oknotika'),
    vk_url = COALESCE(vk_url, 'https://vk.ru/oknotika'),
    futuchat_url = COALESCE(futuchat_url, 'https://t.me/FUTU_CHAT')
WHERE singleton = 1;
