CREATE TABLE IF NOT EXISTS influencers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT NOT NULL,
    platform TEXT NOT NULL,
    focus TEXT,
    why_follow TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS market_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    platform TEXT NOT NULL,
    language TEXT DEFAULT 'en',
    topic TEXT,
    searched_at TEXT DEFAULT (datetime('now')),
    result_count INTEGER DEFAULT 0,
    UNIQUE(query, platform, language)
);

CREATE TABLE IF NOT EXISTS market_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER REFERENCES market_searches(id),
    platform TEXT,
    author TEXT,
    content TEXT,
    url TEXT,
    post_date TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now')),
    platform_post_id TEXT,
    mined_at TEXT,
    UNIQUE(platform, platform_post_id)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT DEFAULT (date('now')),
    mode TEXT DEFAULT 'daily',
    posts_analyzed INTEGER DEFAULT 0,
    signals_analyzed INTEGER DEFAULT 0,
    transcripts_analyzed INTEGER DEFAULT 0,
    findings_created INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES analysis_runs(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    evidence TEXT,
    pillar TEXT,
    signal_strength TEXT DEFAULT 'medium',
    engagement_total INTEGER DEFAULT 0,
    source_count INTEGER DEFAULT 0,
    suggested_angle TEXT,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finding_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER REFERENCES findings(id),
    related_finding_id INTEGER REFERENCES findings(id),
    link_type TEXT DEFAULT 'related',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS market_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER REFERENCES findings(id),
    market TEXT DEFAULT 'gcc',
    relevance TEXT DEFAULT 'medium',
    context TEXT,
    audience TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(finding_id, market)
);

CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER REFERENCES findings(id),
    category TEXT,
    title TEXT NOT NULL,
    description TEXT,
    target_market TEXT,
    evidence TEXT,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'idea',
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_posts_fetched ON posts(fetched_at);
CREATE INDEX IF NOT EXISTS idx_posts_mined ON posts(mined_at);
CREATE INDEX IF NOT EXISTS idx_posts_influencer ON posts(influencer_id);
CREATE INDEX IF NOT EXISTS idx_signals_fetched ON market_signals(fetched_at);
CREATE INDEX IF NOT EXISTS idx_signals_mined ON market_signals(mined_at);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type);
CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at);
CREATE INDEX IF NOT EXISTS idx_scores_market ON market_scores(market);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
