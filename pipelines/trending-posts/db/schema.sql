PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS influencers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT NOT NULL,
    platform TEXT NOT NULL,
    focus TEXT,
    why_follow TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(handle, platform)
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    influencer_id INTEGER REFERENCES influencers(id),
    platform_post_id TEXT,
    url TEXT,
    content TEXT,
    transcript TEXT,
    post_date TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    mined_at TEXT,
    UNIQUE(influencer_id, platform_post_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER REFERENCES posts(id),
    author TEXT,
    content TEXT,
    likes INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_fetched ON posts(fetched_at);
CREATE INDEX IF NOT EXISTS idx_posts_influencer ON posts(influencer_id);
