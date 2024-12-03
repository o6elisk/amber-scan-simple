-- Basic queries
SELECT * FROM user_settings;
SELECT COUNT(*) as total_users FROM user_settings;
SELECT * FROM user_settings WHERE api_token = ?;

-- User management queries
INSERT INTO user_settings (api_token, email, site_id) VALUES (?, ?, ?);
UPDATE user_settings SET email = ?, site_id = ? WHERE api_token = ?;
DELETE FROM user_settings WHERE api_token = ?;

-- Alert settings queries
UPDATE user_settings 
SET high_price = ?,
    low_price = ?,
    renewables = ?,
    high_price_enabled = ?,
    low_price_enabled = ?,
    renewables_enabled = ?
WHERE api_token = ?;

-- Notification settings queries
UPDATE user_settings 
SET quiet_hours = ?,
    quiet_hours_enabled = ?,
    email_notifications = ?,
    timezone = ?
WHERE api_token = ?;

-- Alert timestamp updates
UPDATE user_settings SET last_high_alert = CURRENT_TIMESTAMP WHERE api_token = ?;
UPDATE user_settings SET last_low_alert = CURRENT_TIMESTAMP WHERE api_token = ?;
UPDATE user_settings SET last_renewables_alert = CURRENT_TIMESTAMP WHERE api_token = ?;

-- Useful queries for monitoring
SELECT COUNT(*) as enabled_users 
FROM user_settings 
WHERE email_notifications = 1;

SELECT COUNT(*) as users_by_timezone, timezone 
FROM user_settings 
GROUP BY timezone;

-- Find users who haven't received alerts in a while (potentially inactive)
SELECT email, api_token 
FROM user_settings 
WHERE (last_high_alert IS NULL OR last_high_alert < datetime('now', '-30 days'))
AND (last_low_alert IS NULL OR last_low_alert < datetime('now', '-30 days'))
AND (last_renewables_alert IS NULL OR last_renewables_alert < datetime('now', '-30 days'));