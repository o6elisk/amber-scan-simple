import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cors from 'cors';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';

// INITIALIZE EVERYTHING
dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, 'amber-monitor.sqlite');

// DATABASE SETUP
let db;
try {
    console.log('🔥 INITIALIZING DATABASE');
    db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });
    
    await db.exec(`
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
        )
    `);
    console.log('✅ DATABASE READY');
} catch (error) {
    console.error('💀 DATABASE FAILED:', error);
    process.exit(1);
}

// EXPRESS SETUP
const app = express();
app.use(cors({ 
    origin: process.env.CORS_ORIGIN.split(','),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static('.'));

// LOGGING MIDDLEWARE
app.use((req, res, next) => {
    console.log(`\n🚀 ${req.method} ${req.url}`);
    if (Object.keys(req.body).length > 0) console.log('📦 Body:', req.body);
    next();
});

// GET USER SETTINGS
app.get('/api/settings/:apiToken', async (req, res) => {
    try {
        const settings = await db.get(
            'SELECT * FROM user_settings WHERE api_token = ?', 
            [req.params.apiToken]
        );
        res.json(settings || {});
    } catch (error) {
        console.error('❌ Error fetching settings:', error);
        res.status(500).json({ error: error.message });
    }
});

// SAVE USER SETTINGS
app.post('/api/settings', async (req, res) => {
    const { 
        apiToken, email, highPrice, lowPrice, renewables,
        highPriceEnabled, lowPriceEnabled, renewablesEnabled,
        quietHours, quietHoursEnabled, timezone, emailNotifications
    } = req.body;

    // Validate timezone
    try {
        if (timezone) {
            // This will throw if timezone is invalid
            DateTime.now().setZone(timezone);
        }
    } catch (error) {
        return res.status(400).json({ error: 'Invalid timezone' });
    }

    try {
        // First check if we already have a site_id
        const existing = await db.get(
            'SELECT site_id FROM user_settings WHERE api_token = ?', 
            [apiToken]
        );

        // Get site ID if we don't have one
        const siteId = existing?.site_id || await getSiteId(apiToken);

        // Update database with all settings including site_id
        await db.run(`
            INSERT INTO user_settings (
                api_token, email, site_id, high_price, low_price, renewables,
                high_price_enabled, low_price_enabled, renewables_enabled,
                quiet_hours, quiet_hours_enabled, timezone, email_notifications
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(api_token) DO UPDATE SET
                email=excluded.email,
                site_id=excluded.site_id,
                high_price=excluded.high_price,
                low_price=excluded.low_price,
                renewables=excluded.renewables,
                high_price_enabled=excluded.high_price_enabled,
                low_price_enabled=excluded.low_price_enabled,
                renewables_enabled=excluded.renewables_enabled,
                quiet_hours=excluded.quiet_hours,
                quiet_hours_enabled=excluded.quiet_hours_enabled,
                timezone=excluded.timezone,
                email_notifications=excluded.email_notifications
        `, [
            apiToken, email, siteId, highPrice, lowPrice, renewables,
            highPriceEnabled, lowPriceEnabled, renewablesEnabled,
            JSON.stringify(quietHours || []), quietHoursEnabled, timezone,
            emailNotifications
        ]);

        const saved = await db.get('SELECT * FROM user_settings WHERE api_token = ?', [apiToken]);
        console.log('✅ Settings saved:', saved);
        res.json({ success: true, data: saved });
    } catch (error) {
        console.error('❌ Error saving settings:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this helper function at the top of server.js
async function fetchWithRetry(url, options, maxRetries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            console.log(`Attempt ${attempt}/${maxRetries} failed:`, error.message);
            
            if (attempt === maxRetries) {
                throw error;
            }
            
            // If it's a DNS or network error, wait before retrying
            if (error.code === 'EAI_AGAIN' || error.type === 'system') {
                await new Promise(resolve => setTimeout(resolve, delay * attempt));
            } else {
                throw error; // Don't retry other types of errors
            }
        }
    }
}

// Update the current price endpoint to use the retry logic
app.get('/api/current-price', async (req, res) => {
    const { apiToken } = req.query;
    if (!apiToken) return res.status(400).json({ error: 'API token required' });

    try {
        let user = await db.get(
            'SELECT site_id FROM user_settings WHERE api_token = ?', 
            [apiToken]
        );

        if (!user?.site_id) {
            const siteId = await getSiteId(apiToken);
            await db.run(
                'UPDATE user_settings SET site_id = ? WHERE api_token = ?',
                [siteId, apiToken]
            );
            user = { site_id: siteId };
        }

        // Use fetchWithRetry instead of fetch
        const priceResponse = await fetchWithRetry(
            `${process.env.AMBER_API_URL}/sites/${user.site_id}/prices/current`,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        const prices = await priceResponse.json();
        const generalPrice = prices.find(p => p.channelType === 'general');
        
        if (!generalPrice) throw new Error('No general price found');

        res.json({
            price: Number((generalPrice.perKwh || generalPrice.spotPerKwh || 0).toFixed(2)),
            renewables: Math.round(generalPrice.renewables || 0)
        });
    } catch (error) {
        console.error('❌ Error fetching price:', error);
        res.status(500).json({ 
            error: error.code === 'EAI_AGAIN' 
                ? 'Temporary network issue, please try again' 
                : error.message 
        });
    }
});

// Update the sendAlert function to match Loops SDK documentation
async function sendAlert(type, email, value, threshold) {
    try {
        // Format alert details based on type
        const alertDetails = {
            high_price: {
                alert_descriptor: "High Price",
                threshold_descriptor: "maximum price threshold",
                current_price: `${Number(value).toFixed(2)}¢/kWh`,
                alert_message: `The current electricity price (${Number(value).toFixed(2)}¢/kWh) has exceeded your maximum threshold of ${Number(threshold).toFixed(2)}¢/kWh.`
            },
            low_price: {
                alert_descriptor: "Low Price",
                threshold_descriptor: "minimum price threshold",
                current_price: `${Number(value).toFixed(2)}¢/kWh`,
                alert_message: `The current electricity price (${Number(value).toFixed(2)}¢/kWh) has dropped below your minimum threshold of ${Number(threshold).toFixed(2)}¢/kWh.`
            },
            renewables: {
                alert_descriptor: "High Renewables",
                threshold_descriptor: "renewables threshold",
                current_price: `${Math.round(value)}%`,
                alert_message: `The current renewable energy percentage (${Math.round(value)}%) has exceeded your threshold of ${Math.round(threshold)}%.`
            }
        };

        const details = alertDetails[type];
        
        const response = await fetchWithRetry(
            'https://app.loops.so/api/v1/transactional', // Updated URL
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.LOOPS_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    transactionalId: process.env.LOOPS_TEMPLATE_ID,
                    email: email,
                    dataVariables: {
                        first_name: email.split('@')[0],
                        alert_descriptor: details.alert_descriptor,
                        current_price: details.current_price,
                        threshold_descriptor: details.threshold_descriptor,
                        alert_message: details.alert_message
                    }
                })
            },
            3, // max retries
            5000 // delay between retries (5 seconds)
        );

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Loops API error: ${errorData.message || response.status}`);
        }

        console.log(`✅ ${type} alert sent to ${email}`);
        return await response.json();
    } catch (error) {
        console.error(`❌ Failed to send ${type} alert:`, error);
        throw error;
    }
}

// CHECK PRICES AND SEND ALERTS
async function checkPricesAndAlert() {
    console.log('\n🔍 Checking prices for all users...');
    try {
        const users = await db.all('SELECT * FROM user_settings');
        console.log(`Found ${users.length} users to check`);

        for (const user of users) {
            try {
                // Get current price
                const response = await fetch(`${process.env.AMBER_API_URL}/sites`, {
                    headers: {
                        'Authorization': `Bearer ${user.api_token}`,
                        'Accept': 'application/json'
                    }
                });
                const sites = await response.json();
                if (!sites.length) continue;

                const priceResponse = await fetch(
                    `${process.env.AMBER_API_URL}/sites/${sites[0].id}/prices/current`,
                    {
                        headers: {
                            'Authorization': `Bearer ${user.api_token}`,
                            'Accept': 'application/json'
                        }
                    }
                );
                
                const prices = await priceResponse.json();
                const generalPrice = prices.find(p => p.channelType === 'general');
                if (!generalPrice) continue;

                const price = generalPrice.perKwh || generalPrice.spotPerKwh || 0;
                const renewables = generalPrice.renewables || 0;
                const now = new Date();
                const cooldown = parseInt(process.env.ALERT_COOLDOWN);

                // Check thresholds and send alerts
                if (user.high_price_enabled && 
                    price > user.high_price && 
                    (!user.last_high_alert || 
                     now - new Date(user.last_high_alert) > cooldown)) {
                    await sendAlert('high_price', user.email, price, user.high_price);
                    await db.run(
                        'UPDATE user_settings SET last_high_alert = ? WHERE api_token = ?',
                        [now.toISOString(), user.api_token]
                    );
                }

                if (user.low_price_enabled && 
                    price < user.low_price && 
                    (!user.last_low_alert || 
                     now - new Date(user.last_low_alert) > cooldown)) {
                    await sendAlert('low_price', user.email, price, user.low_price);
                    await db.run(
                        'UPDATE user_settings SET last_low_alert = ? WHERE api_token = ?',
                        [now.toISOString(), user.api_token]
                    );
                }

                if (user.renewables_enabled && 
                    renewables > user.renewables && 
                    (!user.last_renewables_alert || 
                     now - new Date(user.last_renewables_alert) > cooldown)) {
                    await sendAlert('renewables', user.email, renewables, user.renewables);
                    await db.run(
                        'UPDATE user_settings SET last_renewables_alert = ? WHERE api_token = ?',
                        [now.toISOString(), user.api_token]
                    );
                }
            } catch (error) {
                console.error(`❌ Error processing user ${user.api_token}:`, error);
            }
        }
    } catch (error) {
        console.error('❌ Error in price check:', error);
    }
}

// Update the normalizeTime function to be more timezone-aware
function normalizeTime(timeStr, timezone) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    // Use UTC internally for consistent calculations
    return DateTime.utc()
        .setZone(timezone)
        .set({ 
            hour: hours, 
            minute: minutes, 
            second: 0, 
            millisecond: 0 
        });
}

// Update the isInQuietHours function to be more precise
function isInQuietHours(quietHours, userTime, userTimezone) {
    if (!quietHours?.length) return false;
    
    // Convert user time to UTC for consistent comparison
    const now = DateTime.fromJSDate(userTime)
        .setZone(userTimezone)
        .toUTC();
    
    for (const period of quietHours) {
        const start = normalizeTime(period.start || '22:00', userTimezone);
        let end = normalizeTime(period.end || '07:00', userTimezone);
        
        // Convert both to UTC for comparison
        const startUTC = start.toUTC();
        let endUTC = end.toUTC();
        
        // If end is before start, it means it spans midnight
        if (endUTC < startUTC) {
            endUTC = endUTC.plus({ days: 1 });
        }
        
        // Check if current time falls within the quiet period
        if (now >= startUTC && now < endUTC) {
            return true;
        }
        
        // Handle case where quiet period spans across midnight
        if (startUTC > endUTC) {
            const yesterdayStartUTC = startUTC.minus({ days: 1 });
            if (now >= yesterdayStartUTC && now < endUTC) {
                return true;
            }
        }
    }
    
    return false;
}

// Update the cron schedule and add detailed flow logging
cron.schedule('*/30 * * * *', async () => {
    console.log('\n🔄 --------- PRICE CHECK FLOW START ---------');
    console.log(`⏰ Server UTC time: ${DateTime.utc().toISO()}`);
    
    try {
        // Step 1: Get users with notifications enabled
        console.log('\n📋 Step 1: Fetching users with notifications enabled...');
        const users = await db.all(`
            SELECT * FROM user_settings 
            WHERE email_notifications IS NULL 
            OR email_notifications = 1
        `);
        console.log(`✅ Found ${users.length} users with notifications enabled`);

        // Step 2: Process each user
        for (const user of users) {
            console.log(`\n👤 ---------- Processing User: ${user.email} ----------`);
            try {
                // Step 3: Check quiet hours
                console.log('🌙 Step 3: Checking quiet hours...');
                console.log(`   Timezone: ${user.timezone || 'UTC'}`);
                
                const quietHours = JSON.parse(user.quiet_hours || '[]');
                const userTimezone = user.timezone || 'UTC';
                const userTime = DateTime.now().setZone(userTimezone);
                
                console.log(`   User local time: ${userTime.toISO()}`);
                console.log(`   Quiet hours config: ${JSON.stringify(quietHours)}`);
                
                if (isInQuietHours(quietHours, userTime.toJSDate(), userTimezone)) {
                    console.log('⏸️  User in quiet hours - skipping notifications');
                    continue;
                }
                console.log('✅ User not in quiet hours - proceeding');

                // Step 4: Fetch price data
                console.log('\n💰 Step 4: Fetching current prices from Amber...');
                const priceResponse = await fetchWithRetry(
                    `${process.env.AMBER_API_URL}/sites/${user.site_id}/prices/current`,
                    {
                        headers: {
                            'Authorization': `Bearer ${user.api_token}`,
                            'Accept': 'application/json'
                        }
                    }
                );
                
                const prices = await priceResponse.json();
                console.log('✅ Price data received');

                // Step 5: Check thresholds
                console.log('\n🎯 Step 5: Checking price thresholds...');
                const priceTypes = {
                    high_price: prices.find(p => p.channelType === 'general'),
                    low_price: prices.find(p => p.channelType === 'general'),
                    renewables: prices.find(p => p.channelType === 'general')
                };

                const notifications = [];

                // Process each price type
                for (const [type, price] of Object.entries(priceTypes)) {
                    if (!price) continue;
                    
                    const currentPrice = type === 'renewables' 
                        ? (price.renewables || 0)
                        : (price.perKwh || price.spotPerKwh || 0);
                        
                    const threshold = user[type];
                    const isEnabled = user[`${type}_enabled`];
                    const lastAlert = user[`last_${type}_alert`];
                    
                    console.log(`   Checking ${type}:`);
                    console.log(`   - Current price/value: ${currentPrice}`);
                    console.log(`   - Threshold: ${threshold}`);
                    console.log(`   - Alerts enabled: ${isEnabled}`);
                    console.log(`   - Last alert: ${lastAlert || 'Never'}`);
                    
                    // Different comparison for high price vs low price vs renewables
                    const thresholdExceeded = type === 'high_price' ? currentPrice > threshold
                                           : type === 'low_price' ? currentPrice < threshold
                                           : currentPrice > threshold; // renewables
                    
                    if (isEnabled && threshold && thresholdExceeded) {
                        const cooldownPassed = !lastAlert || 
                            (DateTime.now().diff(DateTime.fromISO(lastAlert), 'milliseconds').milliseconds > 
                             parseInt(process.env.ALERT_COOLDOWN));
                        
                        if (cooldownPassed) {
                            console.log(`   ⚠️  Threshold exceeded for ${type}`);
                            notifications.push({
                                type,
                                currentPrice,
                                threshold
                            });
                        } else {
                            const timeLeft = DateTime.fromISO(lastAlert)
                                .plus({ milliseconds: parseInt(process.env.ALERT_COOLDOWN) })
                                .diff(DateTime.now())
                                .toFormat('hh:mm:ss');
                            console.log(`   ⏳ Cooldown period active for ${type} (${timeLeft} remaining)`);
                        }
                    }
                }

                // Step 6: Send notifications
                if (notifications.length > 0) {
                    console.log(`\n📧 Step 6: Sending ${notifications.length} notifications...`);
                    for (const notification of notifications) {
                        try {
                            await sendAlert(
                                notification.type,
                                user.email,
                                notification.currentPrice,
                                notification.threshold
                            );
                            
                            // Update last alert timestamp using correct column names
                            const alertColumn = notification.type === 'high_price' ? 'last_high_alert' :
                                                  notification.type === 'low_price' ? 'last_low_alert' :
                                                  'last_renewables_alert';
                            
                            await db.run(
                                `UPDATE user_settings 
                                 SET ${alertColumn} = ? 
                                 WHERE api_token = ?`,
                                [DateTime.now().toISO(), user.api_token]
                            );
                            
                            console.log(`✅ Sent ${notification.type} alert to ${user.email}`);
                        } catch (error) {
                            console.error(`❌ Failed to send ${notification.type} alert:`, error);
                        }
                    }
                } else {
                    console.log('\n📧 Step 6: No notifications needed');
                }

            } catch (userError) {
                console.error(`❌ Error processing user ${user.email}:`, userError);
                continue;
            }
            console.log('✅ Finished processing user\n');
        }
    } catch (error) {
        console.error('❌ Cron job error:', error);
    }
    console.log('\n🏁 --------- PRICE CHECK FLOW COMPLETE ---------\n');
});

// Helper function for email sending
async function sendEmailNotification(email, type, price, threshold) {
    // Add retry logic for email sending
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            await emailService.send({
                to: email,
                subject: `Price Alert: ${type} threshold exceeded`,
                text: `The current ${type} price (${price}) has exceeded your threshold of ${threshold}.`
            });
            return;
        } catch (error) {
            attempts++;
            if (attempts === maxAttempts) {
                throw error;
            }
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts)));
        }
    }
}

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, process.env.HOST, () => {
    console.log(`\n🚀 SERVER RUNNING ON ${process.env.HOST}:${PORT}`);
    console.log(`📁 DATABASE: ${dbPath}`);
});

// Add this function
async function getSiteId(apiToken) {
    try {
        const response = await fetch(`${process.env.AMBER_API_URL}/sites`, {
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Error('Failed to fetch sites');
        
        const sites = await response.json();
        if (!sites.length) throw new Error('No sites found');
        
        return sites[0].id;  // Return first site ID
    } catch (error) {
        console.error('❌ Error fetching site ID:', error);
        throw error;
    }
}

// Add this endpoint
app.get('/api/generate-site-id', async (req, res) => {
    const { apiToken } = req.query;
    if (!apiToken) return res.status(400).json({ error: 'API token required' });

    try {
        // Call Amber API with proper headers
        const response = await fetch(`${process.env.AMBER_API_URL}/sites`, {
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Accept': 'application/json'
            }
        });

        // Handle specific error codes
        if (response.status === 401) {
            throw new Error('Invalid API token');
        }
        if (response.status === 404) {
            throw new Error('No sites found for this token');
        }
        if (!response.ok) {
            throw new Error(`Amber API error: ${response.status}`);
        }
        
        const sites = await response.json();
        if (!sites.length) {
            throw new Error('No sites available for this account');
        }
        
        const siteId = sites[0].id;  // Get first site's ID
        console.log('✅ Found site ID:', siteId);

        // Update database
        await db.run(
            'UPDATE user_settings SET site_id = ? WHERE api_token = ?',
            [siteId, apiToken]
        );

        res.json({ siteId });
    } catch (error) {
        console.error('❌ Error generating site ID:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this endpoint to get settings by email
app.get('/api/settings-by-email/:email', async (req, res) => {
    try {
        const settings = await db.get(
            'SELECT * FROM user_settings WHERE email = ?', 
            [req.params.email]
        );
        res.json(settings || {});
    } catch (error) {
        console.error('❌ Error fetching settings:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this helper function to check server timezone
app.get('/api/server-timezone', (req, res) => {
    res.json({
        serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        serverTime: new Date().toISOString(),
        nodeEnvTZ: process.env.TZ || 'System default'
    });
});

// Add these debug endpoints
app.get('/api/timezone-debug', (req, res) => {
    const { timezone, time } = req.query;
    try {
        const serverTime = DateTime.now();
        const userTime = timezone ? DateTime.now().setZone(timezone) : serverTime;
        const specificTime = time ? DateTime.fromISO(time).setZone(timezone) : null;
        
        res.json({
            serverTimezone: process.env.TZ || 'System default',
            serverTime: serverTime.toISO(),
            serverOffset: serverTime.offset,
            userTimezone: timezone,
            userTime: userTime.toISO(),
            userOffset: userTime.offset,
            specificTime: specificTime?.toISO(),
            specificOffset: specificTime?.offset
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});