-- Trend Pain Analyzer — DB Schema
-- One DB per pipeline, shared across all blocks

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL CHECK(mode IN ('daily', 'weekly')),
    target_region TEXT,
    lookback TEXT,
    platforms_searched TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    influencer_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    url TEXT,
    published_at TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    total_engagement INTEGER DEFAULT 0,
    raw_data TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS top_titles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    rank INTEGER NOT NULL,
    post_id INTEGER REFERENCES posts(id),
    title TEXT NOT NULL,
    platform TEXT NOT NULL,
    influencer_name TEXT NOT NULL,
    total_engagement INTEGER NOT NULL,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    ranked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    search_query TEXT NOT NULL,
    platform TEXT NOT NULL,
    target_region TEXT,
    title TEXT,
    snippet TEXT,
    url TEXT,
    author TEXT,
    engagement_score INTEGER DEFAULT 0,
    published_at TEXT,
    raw_data TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    trend_id INTEGER REFERENCES trends(id),
    platform TEXT NOT NULL,
    author TEXT,
    text TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    is_spam INTEGER DEFAULT 0,
    language TEXT,
    published_at TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pain_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    theme TEXT NOT NULL,
    description TEXT NOT NULL,
    frequency INTEGER DEFAULT 1,
    evidence_quotes TEXT,
    source_platforms TEXT,
    severity TEXT CHECK(severity IN ('high', 'medium', 'low')),
    extracted_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_run ON posts(run_id);
CREATE INDEX IF NOT EXISTS idx_posts_engagement ON posts(total_engagement DESC);
CREATE INDEX IF NOT EXISTS idx_top_titles_run ON top_titles(run_id);
CREATE INDEX IF NOT EXISTS idx_trends_run ON trends(run_id);
CREATE INDEX IF NOT EXISTS idx_comments_run ON comments(run_id);
CREATE INDEX IF NOT EXISTS idx_comments_spam ON comments(is_spam);
CREATE INDEX IF NOT EXISTS idx_pain_points_run ON pain_points(run_id);
CREATE INDEX IF NOT EXISTS idx_pain_points_freq ON pain_points(frequency DESC);
