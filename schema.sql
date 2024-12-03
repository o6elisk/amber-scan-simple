-- User settings table
CREATE TABLE IF NOT EXISTS user_settings (
    api_token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    site_id TEXT,
    high_price REAL,
    low_price REAL,
    renewables INTEGER,
    high_price_enabled BOOLEAN DEFAULT 1,
    low_price_enabled BOOLEAN DEFAULT 1,
    renewables_enabled BOOLEAN DEFAULT 1,
    quiet_hours TEXT DEFAULT '[]',
    quiet_hours_enabled BOOLEAN DEFAULT 1,
    email_notifications BOOLEAN DEFAULT 1,
    timezone TEXT DEFAULT 'UTC',
    last_high_alert TIMESTAMP,
    last_low_alert TIMESTAMP,
    last_renewables_alert TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trigger to update the updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_timestamp 
AFTER UPDATE ON user_settings
BEGIN
    UPDATE user_settings SET updated_at = CURRENT_TIMESTAMP WHERE api_token = OLD.api_token;
END; 