import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'crypto';
import BotMonitor from './bot-monitor.js';
import ScheduledBotMonitor from './scheduled-bot-monitor.js';
import MarketMakerBotMonitor from './market-maker-bot-monitor.js';
import StabilizerBotMonitor from './stabilizer-bot-monitor.js';
import BuyWallBotMonitor from './buywall-bot-monitor.js';
import PriceKeeperBotMonitor from './price-keeper-bot-monitor.js';
import telegramService from './telegram-service.js';
import { setupMexcRoutes, setupMexcMMBotRoutes } from './mexc-routes.js';
import MexcMMBotMonitor from './mexc-mm-bot-monitor.js';
import { setupMexcUserRoutes } from './mexc-user-routes.js';
import { setupMexcUserApiRoutes, setUserBotMonitor } from './mexc-user-api-routes.js';
import MexcUserBotMonitor from './mexc-user-bot-monitor.js';
import { setupXtRoutes } from './xt-routes.js';
import { setupXtUserRoutes } from './xt-user-routes.js';
import { setupXtUserApiRoutes, setXtUserBotMonitor } from './xt-user-api-routes.js';
import XtUserBotMonitor from './xt-user-bot-monitor.js';

const app = express();
const PORT = process.env.PORT || 3001;
const GCBEX_API_BASE = process.env.GCBEX_API_BASE || 'https://www.gcbex.com/fe-ex-api';

// GCBEX Open API (for API Key/Secret authentication)
const GCBEX_OPEN_API_BASE = process.env.API_BASE || 'https://openapi.gcbex.com';
const GCBEX_API_KEY = process.env.API_KEY;
const GCBEX_API_SECRET = process.env.API_SECRET;

// Debug: Log environment variables on startup
console.log('\n🔧 Environment Variables Check:');
console.log(`OPEN_API_BASE: ${GCBEX_OPEN_API_BASE}`);
console.log(`WEB_API_BASE: ${GCBEX_API_BASE}`);
console.log(`API_KEY: ${GCBEX_API_KEY ? GCBEX_API_KEY.substring(0, 10) + '...' : '❌ NOT FOUND'}`);
console.log(`API_SECRET: ${GCBEX_API_SECRET ? GCBEX_API_SECRET.substring(0, 10) + '...' : '❌ NOT FOUND'}`);
console.log('✅ Market Data: Using Open API (no rate limits)');
console.log(`\n📱 Telegram Configuration:`);
console.log(`BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.substring(0, 10) + '...' : '❌ NOT CONFIGURED'}`);
console.log(`CHAT_ID: ${process.env.TELEGRAM_CHAT_ID ? process.env.TELEGRAM_CHAT_ID : '❌ NOT CONFIGURED'}`);
console.log(`Status: ${telegramService.isConfigured() ? '✅ CONFIGURED' : '⚠️ NOT CONFIGURED'}`);
console.log('');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "mmbot";

let db;
let client;
let botMonitor;
let scheduledBotMonitor;
let marketMakerBotMonitor;
let stabilizerBotMonitor;
let buyWallBotMonitor;
let priceKeeperBotMonitor;
let mexcMMBotMonitor;
let mexcUserBotMonitor;
let xtUserBotMonitor;

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    client = await MongoClient.connect(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    db = client.db(DB_NAME);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}
// Middleware
app.use(cors({
  origin: ["https://bot.gcbtoken.io", "https://xt.gcbtoken.io", "http://localhost:3000", "http://localhost:3005"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.use(express.json());

// Setup MEXC routes
setupMexcRoutes(app);

// Rate limiting removed for better performance

// Helper: Get formatted time for GCBEX API
function getUaTime() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Helper: Get user's stored API credentials from database
async function getUserApiCredentials(token) {
  if (!db) {
    throw new Error('Database not connected');
  }
  
  const user = await db.collection('users').findOne({ token });
  if (!user || !user.apiKey || !user.apiSecret) {
    return null;
  }
  
  return {
    apiKey: user.apiKey,
    apiSecret: user.apiSecret,
    uid: user.uid
  };
}

// Helper: Generate Open API signature with user's credentials
function generateUserSignature(apiSecret, timestamp, method, requestPath, bodyJson = '') {
  const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(message)
    .digest('hex');
  return signature;
}

// ============================================
// HMAC Signature Helper for Open API
// ============================================
function generateSignature(timestamp, method, requestPath, bodyJson = '') {
  const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
  const signature = crypto
    .createHmac('sha256', GCBEX_API_SECRET)
    .update(message)
    .digest('hex');
  return signature;
}

// ============================================
// Test Open API Endpoints (API Key/Secret)
// ============================================

// GET /api/test/openapi/balance - Test API credentials by fetching balance
app.get('/api/test/openapi/balance', async (req, res) => {
  try {
    if (!GCBEX_API_KEY || !GCBEX_API_SECRET) {
      return res.status(400).json({
        success: false,
        error: 'API_KEY or API_SECRET not configured in .env file',
        message: 'Please add API_KEY and API_SECRET to your .env file'
      });
    }

    const timestamp = Date.now().toString();
    const method = 'GET';
    const requestPath = '/sapi/v1/account';
    const signature = generateSignature(timestamp, method, requestPath);

    console.log(`\n🧪 Testing Open API credentials...`);
    console.log(`Timestamp: ${timestamp}`);
    console.log(`API Key: ${GCBEX_API_KEY?.substring(0, 10)}...`);

    const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}`, {
      method: 'GET',
      headers: {
        'X-CH-APIKEY': GCBEX_API_KEY,
        'X-CH-TS': timestamp,
        'X-CH-SIGN': signature,
      },
    });

    const data = await response.json();

    console.log(`✅ Response received:`, data);

    if (data.balances) {
      console.log(`✅ API credentials are VALID!`);
      return res.json({
        success: true,
        message: 'API credentials are valid',
        data: data,
        testedAt: new Date().toISOString(),
      });
    } else {
      console.log(`❌ API credentials may be invalid:`, data);
      return res.json({
        success: false,
        error: data.msg || 'Unknown error',
        response: data,
        message: 'API credentials may be invalid or expired',
        testedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error('❌ Error testing API:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Error occurred while testing API credentials'
    });
  }
});

// GET /api/test/openapi/ticker - Test public endpoint (no auth needed)
app.get('/api/test/openapi/ticker', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'GCBUSDT';
    const url = `${GCBEX_OPEN_API_BASE}/sapi/v2/ticker?symbol=${symbol}`;
    

    const response = await fetch(url);
    const data = await response.json();


    return res.json({
      success: true,
      data: data,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Error fetching ticker:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// Health Check
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: db ? 'connected' : 'disconnected' });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'mmbot-api', database: db ? 'connected' : 'disconnected' });
});

// ============================================
// Telegram Notification Endpoints
// ============================================

// GET /api/telegram/test - Test Telegram notification
app.get('/api/telegram/test', async (req, res) => {
  try {
    if (!telegramService.isConfigured()) {
      return res.status(400).json({
        code: '-1',
        msg: 'Telegram not configured. Please add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your .env file',
        data: null
      });
    }

    const result = await telegramService.sendTestNotification();

    if (result.success) {
      return res.json({
        code: '0',
        msg: 'Test notification sent successfully',
        data: result.data
      });
    } else {
      return res.status(500).json({
        code: '-1',
        msg: 'Failed to send test notification',
        error: result.error,
        data: null
      });
    }
  } catch (error) {
    console.error('Error testing Telegram:', error);
    return res.status(500).json({
      code: '-1',
      msg: 'Error occurred while testing Telegram',
      error: error.message,
      data: null
    });
  }
});

// GET /api/telegram/status - Check Telegram configuration status
app.get('/api/telegram/status', (req, res) => {
  try {
    const isConfigured = telegramService.isConfigured();
    
    return res.json({
      code: '0',
      msg: 'Success',
      data: {
        configured: isConfigured,
        botToken: process.env.TELEGRAM_BOT_TOKEN ? 
          `${process.env.TELEGRAM_BOT_TOKEN.substring(0, 10)}...` : 
          null,
        chatId: process.env.TELEGRAM_CHAT_ID || null
      }
    });
  } catch (error) {
    console.error('Error checking Telegram status:', error);
    return res.status(500).json({
      code: '-1',
      msg: 'Error occurred while checking Telegram status',
      error: error.message,
      data: null
    });
  }
});

// POST /api/telegram/test-stabilizer - Test stabilizer bot notification with small order
app.post('/api/telegram/test-stabilizer', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check if user has API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials not configured. Please add your API credentials first.', 
        data: null 
      });
    }

    // Check Telegram configuration
    if (!telegramService.isConfigured()) {
      return res.status(400).json({
        code: '-1',
        msg: 'Telegram not configured. Please add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your .env file',
        data: null
      });
    }

    console.log('🧪 Testing Stabilizer Bot notification with $0.50 USDT order...');

    // Get current market price
    const marketPriceResponse = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/ticker?symbol=gcbusdt`);
    const marketPriceData = await marketPriceResponse.json();
    const marketPrice = parseFloat(marketPriceData.last);

    console.log(`📊 Current market price: $${marketPrice}`);

    // Place a small market buy order with $0.50 USDT
    const testAmount = 0.50; // $0.50 USDT
    const orderBody = {
      symbol: 'GCBUSDT',
      side: 'BUY',
      type: 'MARKET',
      volume: testAmount.toFixed(2)
    };

    // Get server time and create signature
    const timestamp = (await getServerTime()).toString();
    const method = 'POST';
    const requestPath = '/sapi/v2/order';
    const bodyJson = JSON.stringify(orderBody, null, 0).replace(/\s/g, '');
    const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
    const signature = crypto
      .createHmac('sha256', user.apiSecret)
      .update(message)
      .digest('hex');

    console.log(`💱 Placing test order: BUY $${testAmount} USDT worth of GCB`);

    // Execute test order
    const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}`, {
      method: 'POST',
      headers: {
        'X-CH-APIKEY': user.apiKey,
        'X-CH-TS': timestamp,
        'X-CH-SIGN': signature,
        'Content-Type': 'application/json'
      },
      body: bodyJson
    });

    const result = await response.json();

    if (result.orderId) {
      console.log(`✅ Test order placed successfully! Order ID: ${result.orderId}`);

      // Send Telegram notification using stabilizer bot format
      const notificationResult = await telegramService.notifyStabilizerBotOrder({
        botName: 'Stabilizer Bot (TEST)',
        symbol: 'GCBUSDT',
        orderNumber: 1,
        totalOrders: 1,
        usdtAmount: testAmount,
        orderId: result.orderId,
        marketPrice: marketPrice,
        targetPrice: marketPrice, // For test, use same price
        status: 'success',
        userId: user.uid
      });

      if (notificationResult.success) {
        console.log('✅ Telegram notification sent successfully!');
      } else {
        console.error('❌ Failed to send Telegram notification:', notificationResult.error);
      }

      return res.json({
        code: '0',
        msg: 'Test order placed and notification sent successfully',
        data: {
          orderId: result.orderId,
          usdtAmount: testAmount,
          marketPrice: marketPrice,
          telegramSent: notificationResult.success,
          orderResult: result
        }
      });
    } else {
      console.error('❌ Test order failed:', result.msg || 'Unknown error');
      
      // Send failed notification
      await telegramService.notifyStabilizerBotOrder({
        botName: 'Stabilizer Bot (TEST)',
        symbol: 'GCBUSDT',
        orderNumber: 1,
        totalOrders: 1,
        usdtAmount: testAmount,
        marketPrice: marketPrice,
        targetPrice: marketPrice,
        status: 'failed',
        error: result.msg || 'Unknown error',
        userId: user.uid
      });

      return res.status(400).json({
        code: '-1',
        msg: 'Test order failed',
        error: result.msg || 'Unknown error',
        data: result
      });
    }
  } catch (error) {
    console.error('❌ Error in test-stabilizer endpoint:', error);
    return res.status(500).json({
      code: '-1',
      msg: 'Error occurred while testing stabilizer bot',
      error: error.message,
      data: null
    });
  }
});

// ============================================
// Trading Endpoints - Place Orders
// ============================================

// POST /api/trade/order - Place a trade order (Market or Limit)
app.post('/api/trade/order', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const { side, type, symbol, volume, price, triggerPrice } = req.body;

    // Validate required fields
    if (!side || !type || !symbol || !volume) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields: side, type, symbol, volume', 
        data: null 
      });
    }

    // Type: 1 = LIMIT, 2 = MARKET
    // Side: BUY or SELL
    const orderPayload = {
      side: side.toUpperCase(),
      price: type === 1 ? price : null,
      volume: String(volume),
      symbol: symbol.toLowerCase(),
      type: Number(type),
      triggerPrice: triggerPrice || null,
      uaTime: getUaTime(),
    };

    const response = await fetch(`${GCBEX_API_BASE}/order/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'exchange-token': token,
      },
      body: JSON.stringify(orderPayload),
    });

    const data = await response.json();
    
    // Log trade for monitoring
    console.log(`📊 Trade Order: ${side} ${volume} ${symbol} at ${price || 'MARKET'} - Response: ${data.msg}`);
    
    res.json(data);
  } catch (error) {
    console.error('Error placing trade order:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to place trade order', data: null });
  }
});

// POST /api/trade/cancel - Cancel an order
app.post('/api/trade/cancel', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const { orderId, symbol } = req.body;

    if (!orderId || !symbol) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields: orderId, symbol', 
        data: null 
      });
    }

    const response = await fetch(`${GCBEX_API_BASE}/order/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'exchange-token': token,
      },
      body: JSON.stringify({
        orderId,
        symbol: symbol.toLowerCase(),
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error canceling order:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to cancel order', data: null });
  }
});

// GET /api/trade/orders - Get open orders
app.get('/api/trade/orders', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const symbol = req.query.symbol || 'gcbusdt';

    const response = await fetch(`${GCBEX_API_BASE}/order/openOrders?symbol=${symbol}&uaTime=${getUaTime()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'exchange-token': token,
      },
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching open orders:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch open orders', data: null });
  }
});

// ============================================
// Auth Routes - QR Code Login
// ============================================

// GET /api/auth/qrcode - Generate new QR code for login
app.get('/api/auth/qrcode', async (req, res) => {
  try {
    const response = await fetch(`${GCBEX_API_BASE}/get_login_qrcode_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching QR code:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch QR code', data: null });
  }
});

// POST /api/auth/qrcode/status - Check QR code scan status
app.post('/api/auth/qrcode/status', async (req, res) => {
  try {
    const { qrcodeId } = req.body;

    if (!qrcodeId) {
      return res.status(400).json({ code: '-1', msg: 'qrcodeId is required', data: null });
    }

    const response = await fetch(`${GCBEX_API_BASE}/get_login_qrcode_status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        qrcodeId,
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    
    // If login confirmed (status === '2'), save user to database
    if (data.code === '0' && data.data?.status === '2' && data.data?.token) {
      try {
        const userData = {
          uid: data.data.uid,
          token: data.data.token,
          last_login: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        // Upsert user
        await db.collection('users').updateOne(
          { uid: data.data.uid },
          { 
            $set: userData,
            $setOnInsert: { created_at: new Date().toISOString() }
          },
          { upsert: true }
        );
        console.log('✅ User logged in:', data.data.uid);
      } catch (dbError) {
        console.error('Error saving user:', dbError);
        // Don't fail the login if DB save fails
      }
    }

    res.json(data);
  } catch (error) {
    console.error('Error checking QR status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to check QR status', data: null });
  }
});

// ============================================
// Market Data Routes
// ============================================

// GET /api/market/rates - Get exchange rates for all coins using Open API
app.post('/api/market/rates', async (req, res) => {
  try {
    const { fiat = 'USD' } = req.body;

    // Fetch ticker data from Open API (public endpoint, no auth needed)
    // Note: Only fetch symbols that actually exist on the exchange
    const symbols = ['gcbusdt']; // gcbfxusdt doesn't exist on GCBEX
    const rates = {};

    for (const symbol of symbols) {
      try {
        const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/ticker?symbol=${symbol}`);
        const tickerData = await response.json();
        
        if (tickerData && tickerData.last) {
          // Extract coin name from symbol (e.g., 'gcbusdt' -> 'GCB')
          const coinName = symbol.replace('usdt', '').toUpperCase();
          rates[coinName] = tickerData.last; // 'last' is the current price
        } else if (tickerData.code !== '0') {
          // Only log if it's the first time we see this error
          if (!global[`${symbol}_error_logged`]) {
            console.warn(`⚠️ Symbol ${symbol} not available:`, tickerData.msg);
            global[`${symbol}_error_logged`] = true;
          }
        }
      } catch (err) {
        console.warn(`⚠️ Failed to fetch ${symbol}:`, err.message);
      }
    }

    // Add USDT rate (always 1.0)
    rates['USDT'] = '1.0';

    res.json({
      code: '0',
      msg: 'Success',
      data: {
        rate: {
          [fiat]: rates
        }
      }
    });
  } catch (error) {
    // Only log first occurrence to reduce noise
    if (!global.marketRateErrorLogged) {
      console.warn('⚠️ Market rates temporarily unavailable (Open API issue)');
      global.marketRateErrorLogged = true;
      setTimeout(() => { global.marketRateErrorLogged = false; }, 60000);
    }
    // Return empty rates instead of crashing
    res.status(200).json({ 
      code: '-1', 
      msg: 'Market rates temporarily unavailable', 
      data: { rate: { [req.body.fiat || 'USD']: {} } } 
    });
  }
});

// GET /api/market/public-info - Get public contract and market info
app.post('/api/market/public-info', async (req, res) => {
  try {
    const response = await fetch('https://www.gcbex.com/fe-co-api/common/public_info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching public info:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch public info', data: null });
  }
});

// POST /api/market/ticker - Get market ticker/info for trading pairs
app.post('/api/market/ticker', async (req, res) => {
  try {
    const { symbols = [] } = req.body; // Array of symbols like ['BTC-USDT', 'ETH-USDT']

    const response = await fetch('https://www.gcbex.com/fe-co-api/market/market_info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        symbols,
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching market ticker:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch market ticker', data: null });
  }
});

// POST /api/market/otc-public-info - Get OTC public info
app.post('/api/market/otc-public-info', async (req, res) => {
  try {
    const response = await fetch('https://www.gcbex.com/fe-otc-api/otc/public_info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching OTC public info:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch OTC public info', data: null });
  }
});

// GET /api/market/depth - Get order book depth data
app.get('/api/market/depth', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'GCBUSDT';
    const limit = req.query.limit || 100;

    const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v2/depth?symbol=${symbol}&limit=${limit}`);
    const data = await response.json();

    res.json({
      code: '0',
      msg: 'Success',
      data: data
    });
  } catch (error) {
    console.error('Error fetching order book depth:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch order book depth', data: null });
  }
});

// ============================================
// User Routes
// ============================================

// GET /api/users/me - Get current user by token
app.get('/api/users/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });

    if (!user) {
      return res.status(404).json({ code: '-1', msg: 'User not found', data: null });
    }

    res.json({
      code: '0',
      msg: 'success',
      data: {
        uid: user.uid,
        token: user.token,
        last_login: user.last_login,
        created_at: user.created_at,
      }
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch user', data: null });
  }
});

// POST /api/users/info - Get detailed user info from GCBEX
app.post('/api/users/info', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];

    const response = await fetch(`${GCBEX_API_BASE}/common/user_info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'exchange-token': token,
      },
      body: JSON.stringify({
        uaTime: getUaTime(),
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching user info:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch user info', data: null });
  }
});

// POST /api/users/balance - Get account balance using Open API (no token expiry)
app.post('/api/users/balance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    
    // Get user's stored API credentials
    const credentials = await getUserApiCredentials(token);
    if (!credentials) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials not found. Please add your API credentials in settings.', 
        data: null,
        needsCredentials: true
      });
    }

    // Use Open API to get balance (no expiry)
    const timestamp = Date.now().toString();
    const method = 'GET';
    const requestPath = '/sapi/v1/account';
    const signature = generateUserSignature(credentials.apiSecret, timestamp, method, requestPath);

    const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}`, {
      method: 'GET',
      headers: {
        'X-CH-APIKEY': credentials.apiKey,
        'X-CH-TS': timestamp,
        'X-CH-SIGN': signature,
      },
    });

    const data = await response.json();
    
    // Transform Open API response to match old format
    if (data.balances) {
      const allCoinMap = {};
      data.balances.forEach(balance => {
        allCoinMap[balance.asset] = {
          coinName: balance.asset,
          free: balance.free,
          locked: balance.locked,
          total: (parseFloat(balance.free) + parseFloat(balance.locked)).toString()
        };
      });
      
      res.json({
        code: '0',
        msg: 'success',
        data: { allCoinMap }
      });
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Error fetching balance:', error.message);
    res.status(200).json({ 
      code: '-1', 
      msg: 'Balance temporarily unavailable', 
      data: { allCoinMap: {} } 
    });
  }
});

// ============================================
// API Credentials Management (for Bot Trading)
// ============================================

// POST /api/users/api-credentials - Save user's API Key and Secret
app.post('/api/users/api-credentials', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const { apiKey, apiSecret } = req.body;

    if (!apiKey || !apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API Key and Secret are required', 
        data: null 
      });
    }

    // Find user by token
    const user = await db.collection('users').findOne({ token });
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Validate credentials by testing them
    const timestamp = Date.now().toString();
    const method = 'GET';
    const requestPath = '/sapi/v1/account';
    const message = `${timestamp}${method.toUpperCase()}${requestPath}`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(message)
      .digest('hex');

    const testResponse = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}`, {
      method: 'GET',
      headers: {
        'X-CH-APIKEY': apiKey,
        'X-CH-TS': timestamp,
        'X-CH-SIGN': signature,
      },
    });

    const testData = await testResponse.json();

    if (!testData.balances) {
      return res.status(400).json({
        code: '-1',
        msg: 'Invalid API credentials',
        error: testData.msg || 'Credentials validation failed',
        data: null
      });
    }

    // Save credentials to user document
    await db.collection('users').updateOne(
      { uid: user.uid },
      {
        $set: {
          apiKey: apiKey,
          apiSecret: apiSecret,
          apiCredentialsUpdatedAt: new Date().toISOString(),
          apiCredentialsValid: true
        }
      }
    );

    console.log(`✅ API credentials saved for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'API credentials saved successfully',
      data: {
        apiKey: apiKey.substring(0, 10) + '...',
        valid: true,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error saving API credentials:', error);
    res.status(500).json({ 
      code: '-1', 
      msg: 'Failed to save API credentials', 
      data: null 
    });
  }
});

// GET /api/users/api-credentials - Check if user has valid API credentials
app.get('/api/users/api-credentials', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });

    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const hasCredentials = !!(user.apiKey && user.apiSecret);

    res.json({
      code: '0',
      msg: 'Success',
      data: {
        hasCredentials: hasCredentials,
        apiKey: hasCredentials ? user.apiKey.substring(0, 10) + '...' : null,
        valid: user.apiCredentialsValid || false,
        updatedAt: user.apiCredentialsUpdatedAt || null
      }
    });
  } catch (error) {
    console.error('Error checking API credentials:', error);
    res.status(500).json({ 
      code: '-1', 
      msg: 'Failed to check API credentials', 
      data: null 
    });
  }
});

// DELETE /api/users/api-credentials - Remove user's API credentials
app.delete('/api/users/api-credentials', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });

    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Remove credentials and deactivate all bot conditions
    await db.collection('users').updateOne(
      { uid: user.uid },
      {
        $unset: { apiKey: '', apiSecret: '', apiCredentialsUpdatedAt: '' },
        $set: { apiCredentialsValid: false }
      }
    );

    await db.collection('bot_conditions').updateMany(
      { userId: user.uid },
      { $set: { isActive: false } }
    );

    console.log(`✅ API credentials removed for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'API credentials removed successfully',
      data: null
    });
  } catch (error) {
    console.error('Error removing API credentials:', error);
    res.status(500).json({ 
      code: '-1', 
      msg: 'Failed to remove API credentials', 
      data: null 
    });
  }
});

// ============================================
// Trading with API Credentials
// ============================================

// Helper function to get GCBEX server time
async function getServerTime() {
  try {
    const response = await fetch(`${GCBEX_OPEN_API_BASE}/sapi/v1/time`);
    const data = await response.json();
    return data.serverTime;
  } catch (error) {
    console.log('⚠️ Failed to fetch server time, using local time');
    return Date.now();
  }
}

// GET /api/trade/open-orders - Get open orders using stored API credentials
app.get('/api/trade/open-orders', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });

    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check if user has API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials not configured. Please add your API credentials first.', 
        data: null 
      });
    }

    const symbol = req.query.symbol || 'GCBUSDT';

    // Generate signature for Open API with server-synced timestamp
    const timestamp = (await getServerTime()).toString();
    const method = 'GET';
    const requestPath = '/sapi/v2/openOrders';
    const queryString = `symbol=${symbol}`;
    const message = `${timestamp}${method.toUpperCase()}${requestPath}?${queryString}`;
    const signature = crypto.createHmac('sha256', user.apiSecret).update(message).digest('hex');

    // Call GCBEX Open API
    const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}?${queryString}`, {
      method: 'GET',
      headers: {
        'X-CH-APIKEY': user.apiKey,
        'X-CH-TS': timestamp,
        'X-CH-SIGN': signature,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    // Handle different response formats
    if (Array.isArray(data)) {
      // Direct array format - add symbol to each order
      const ordersWithSymbol = data.map(order => ({ ...order, symbol: symbol }));
      res.json({ code: '0', msg: 'Success', data: ordersWithSymbol });
    } else if (data.list && Array.isArray(data.list)) {
      // Wrapped in 'list' property - add symbol to each order
      const ordersWithSymbol = data.list.map(order => ({ ...order, symbol: symbol }));
      res.json({ code: '0', msg: 'Success', data: ordersWithSymbol });
    } else if (data.code) {
      // Error response with code
      res.json(data);
    } else {
      // Unknown format
      res.json({ code: '-1', msg: 'Unexpected response format', data: null });
    }
  } catch (error) {
    console.error('Error fetching open orders:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch open orders', data: null });
  }
});

// POST /api/trade/cancel-order - Cancel order using stored API credentials
app.post('/api/trade/cancel-order', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });

    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check if user has API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials not configured. Please add your API credentials first.', 
        data: null 
      });
    }

    const { orderId, symbol } = req.body;

    if (!orderId || !symbol) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields: orderId, symbol', 
        data: null 
      });
    }

    const cancelBody = {
      orderId: orderId.toString(),
      symbol: symbol.toUpperCase()
    };

    // Generate signature with server-synced timestamp
    const timestamp = (await getServerTime()).toString();
    const method = 'POST';
    const requestPath = '/sapi/v2/cancel';
    const bodyJson = JSON.stringify(cancelBody, null, 0).replace(/\s/g, '');
    const signature = generateUserSignature(user.apiSecret, timestamp, method, requestPath, bodyJson);

    // Call GCBEX Open API
    const response = await fetch(`${GCBEX_OPEN_API_BASE}${requestPath}`, {
      method: 'POST',
      headers: {
        'X-CH-APIKEY': user.apiKey,
        'X-CH-TS': timestamp,
        'X-CH-SIGN': signature,
        'Content-Type': 'application/json'
      },
      body: bodyJson
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error canceling order:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to cancel order', data: null });
  }
});

// POST /api/trade/place-order - Place order using stored API credentials
app.post('/api/trade/place-order', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });

    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check if user has API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials not configured. Please add your API credentials first.', 
        data: null 
      });
    }

    const { side, type, symbol, volume, price } = req.body;

    // Validate required fields
    if (!side || !type || !symbol || !volume) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields: side, type, symbol, volume', 
        data: null 
      });
    }

    // Build order body
    const orderBody = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type === 1 ? 'LIMIT' : 'MARKET',
      volume: volume.toString()
    };

    // Add price and timeInForce for LIMIT orders
    if (type === 1) {
      if (!price) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'Price is required for LIMIT orders', 
          data: null 
        });
      }
      orderBody.price = price.toString();
      orderBody.timeInForce = 'GTC';
    }

    // Generate signature
    const timestamp = Date.now().toString();
    const method = 'POST';
    const requestPath = '/sapi/v2/order';
    const bodyJson = JSON.stringify(orderBody, null, 0).replace(/\s/g, '');
    const signature = generateUserSignature(user.apiSecret, timestamp, method, requestPath, bodyJson);

    // Prepare headers
    const headers = {
      'X-CH-APIKEY': user.apiKey,
      'X-CH-TS': timestamp,
      'X-CH-SIGN': signature,
      'Content-Type': 'application/json'
    };

    // Call GCBEX Open API (for API Key/Secret authentication)
    const gcbexUrl = `${GCBEX_OPEN_API_BASE}${requestPath}`;
    console.log(`📤 Placing ${orderBody.side} ${orderBody.type} order for ${symbol}`);
    console.log(`🌐 API URL: ${gcbexUrl}`);

    const response = await fetch(gcbexUrl, {
      method: 'POST',
      headers: headers,
      body: bodyJson
    });

    const data = await response.json();

    if (data.orderId) {
      console.log(`✅ Order placed successfully: ${data.orderId}`);
    } else {
      console.log(`⚠️ Order failed:`, data);
    }

    // Return GCBEX response
    res.json(data);

  } catch (error) {
    console.error('Error placing order:', error);
    res.status(500).json({ 
      code: '-1', 
      msg: 'Failed to place order', 
      data: null,
      error: error.message
    });
  }
});

// ============================================
// Bot Conditions Routes
// ============================================

// GET /api/bot/conditions - Get all bot conditions for the user
app.get('/api/bot/conditions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    
    // Get user ID from database using token
    const db = client.db(DB_NAME);
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botConditionsCollection = db.collection('bot_conditions');
    const conditions = await botConditionsCollection
      .find({ userId: user.uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ code: '0', msg: 'Success', data: conditions });
  } catch (error) {
    console.error('Error fetching bot conditions:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch bot conditions', data: null });
  }
});

// POST /api/bot/conditions - Create a new bot condition
app.post('/api/bot/conditions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    
    // Get user ID from database using token
    const db = client.db(DB_NAME);
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const condition = {
      ...req.body,
      userId: user.uid,
      triggerCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const botConditionsCollection = db.collection('bot_conditions');
    const result = await botConditionsCollection.insertOne(condition);

    const createdCondition = await botConditionsCollection.findOne({ _id: result.insertedId });

    res.json({ code: '0', msg: 'Condition created successfully', data: createdCondition });
  } catch (error) {
    console.error('Error creating bot condition:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to create bot condition', data: null });
  }
});

// PUT /api/bot/conditions/:id - Update a bot condition
app.put('/api/bot/conditions/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const conditionId = req.params.id;
    
    // Get user ID from database using token
    const db = client.db(DB_NAME);
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botConditionsCollection = db.collection('bot_conditions');
    
    const updates = {
      ...req.body,
      updatedAt: new Date(),
    };
    
    // Don't allow updating userId
    delete updates.userId;
    delete updates._id;

    const result = await botConditionsCollection.findOneAndUpdate(
      { _id: new ObjectId(conditionId), userId: user.uid },
      { $set: updates },
      { returnDocument: 'after' }
    );

    if (!result) {
      return res.status(404).json({ code: '-1', msg: 'Condition not found', data: null });
    }

    res.json({ code: '0', msg: 'Condition updated successfully', data: result });
  } catch (error) {
    console.error('Error updating bot condition:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to update bot condition', data: null });
  }
});

// DELETE /api/bot/conditions/:id - Delete a bot condition
app.delete('/api/bot/conditions/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const conditionId = req.params.id;
    
    // Get user ID from database using token
    const db = client.db(DB_NAME);
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botConditionsCollection = db.collection('bot_conditions');
    
    const result = await botConditionsCollection.deleteOne({
      _id: new ObjectId(conditionId),
      userId: user.uid
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Condition not found' });
    }

    res.json({ code: '0', msg: 'Condition deleted successfully' });
  } catch (error) {
    console.error('Error deleting bot condition:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to delete bot condition' });
  }
});

// ============================================
// Bot Control Endpoints
// ============================================

// POST /api/bot/start - Start the bot monitoring service and enable bot for current user
app.post('/api/bot/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    if (!botMonitor) {
      return res.status(500).json({ code: '-1', msg: 'Bot service not initialized', data: null });
    }

    // Check if user has API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({
        code: '-1',
        msg: 'Please configure your API credentials first before enabling the bot',
        data: null
      });
    }

    // Enable bot for current user
    await db.collection('users').updateOne(
      { uid: user.uid },
      { 
        $set: { 
          botEnabled: true,
          botEnabledAt: new Date().toISOString()
        } 
      }
    );

    // Start conditional bot monitor
    if (!botMonitor.isRunning) {
      await botMonitor.start();
      console.log('🤖 Started conditional bot monitor');
    }

    // Start stabilizer bot monitor if user has active stabilizer bots
    const userStabilizerBots = await db.collection('stabilizer_bots').countDocuments({
      userId: user.uid,
      isActive: true,
      isRunning: true
    });

    if (userStabilizerBots > 0 && !stabilizerBotMonitor.isRunning) {
      await stabilizerBotMonitor.start();
      console.log('🎯 Started stabilizer bot monitor');
    }

    // Log activity
    await db.collection('bot_admin_logs').insertOne({
      userId: user.uid,
      action: 'BOT_STARTED',
      timestamp: new Date(),
      details: { message: 'User started bot via global start endpoint' }
    });
    
    console.log(`✅ Bot enabled and started for user ${user.uid}`);
    
    res.json({
      code: '0',
      msg: 'Bot monitoring service started successfully',
      data: {
        botEnabled: true,
        conditionalBotRunning: botMonitor.isRunning,
        stabilizerBotRunning: stabilizerBotMonitor.isRunning,
        hasStabilizerBots: userStabilizerBots > 0
      }
    });
  } catch (error) {
    console.error('Error starting bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to start bot', data: null });
  }
});

// POST /api/bot/stop - Stop the bot monitoring service and disable bot for current user
app.post('/api/bot/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    if (!botMonitor) {
      return res.status(500).json({ code: '-1', msg: 'Bot service not initialized', data: null });
    }

    // Disable bot for current user
    await db.collection('users').updateOne(
      { uid: user.uid },
      { 
        $set: { 
          botEnabled: false,
          botDisabledAt: new Date().toISOString()
        } 
      }
    );

    // Check if any other users still have bot enabled
    const remainingEnabledUsers = await db.collection('users').countDocuments({
      botEnabled: true,
      apiKey: { $exists: true },
      apiSecret: { $exists: true }
    });

    // Stop conditional bot monitor if no users have bot enabled
    if (remainingEnabledUsers === 0 && botMonitor.isRunning) {
      await botMonitor.stop();
      console.log('⏸️ Stopped conditional bot monitor - no users with botEnabled: true');
    }

    // Check if any enabled users have active stabilizer bots
    if (stabilizerBotMonitor.isRunning) {
      const enabledUsersWithStabilizers = await db.collection('stabilizer_bots').countDocuments({
        isActive: true,
        isRunning: true,
        userId: { 
          $in: (await db.collection('users').find({ 
            botEnabled: true,
            apiKey: { $exists: true },
            apiSecret: { $exists: true }
          }).toArray()).map(u => u.uid)
        }
      });

      if (enabledUsersWithStabilizers === 0) {
        await stabilizerBotMonitor.stop();
        console.log('⏸️ Stopped stabilizer bot monitor - no enabled users with active stabilizers');
      }
    }

    // Log activity
    await db.collection('bot_admin_logs').insertOne({
      userId: user.uid,
      action: 'BOT_STOPPED',
      timestamp: new Date(),
      details: { message: 'User stopped bot via global stop endpoint' }
    });
    
    console.log(`⏸️ Bot disabled and stopped for user ${user.uid}`);
    
    res.json({
      code: '0',
      msg: 'Bot monitoring service stopped successfully',
      data: {
        botEnabled: false,
        conditionalBotRunning: botMonitor.isRunning,
        stabilizerBotRunning: stabilizerBotMonitor.isRunning,
        remainingEnabledUsers
      }
    });
  } catch (error) {
    console.error('Error stopping bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to stop bot', data: null });
  }
});

// GET /api/bot/status - Get bot status
app.get('/api/bot/status', async (req, res) => {
  try {
    if (!botMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: {
          isRunning: false,
          marketData: {},
          activeConditionsCount: 0,
          message: 'Bot service not initialized'
        }
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: botMonitor.getStatus()
    });
  } catch (error) {
    console.error('Error getting bot status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get bot status', data: null });
  }
});

// GET /api/bot/logs - Get bot logs
app.get('/api/bot/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const limit = parseInt(req.query.limit) || 100;

    if (!botMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: []
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: botMonitor.getLogs(limit)
    });
  } catch (error) {
    console.error('Error getting bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get bot logs', data: null });
  }
});

// GET /api/bot/market-data - Get current market data
app.get('/api/bot/market-data', async (req, res) => {
  try {
    if (!botMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: {}
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: botMonitor.getMarketData()
    });
  } catch (error) {
    console.error('Error getting market data:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get market data', data: null });
  }
});

// GET /api/bot/trades - Get bot trade history
app.get('/api/bot/trades', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const limit = parseInt(req.query.limit) || 50;
    const trades = await db.collection('bot_trades')
      .find({ userId: user.uid })
      .sort({ executedAt: -1 })
      .limit(limit)
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: trades
    });
  } catch (error) {
    console.error('Error fetching bot trades:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch bot trades', data: null });
  }
});

// POST /api/bot/user/enable - Enable bot for current user
app.post('/api/bot/user/enable', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check if user has API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({
        code: '-1',
        msg: 'Please configure your API credentials first before enabling the bot',
        data: null
      });
    }

    // Update user's botEnabled flag
    await db.collection('users').updateOne(
      { uid: user.uid },
      { 
        $set: { 
          botEnabled: true,
          botEnabledAt: new Date().toISOString()
        } 
      }
    );

    // Auto-start bot monitor if not already running
    if (!botMonitor.isRunning) {
      await botMonitor.start();
      console.log('🤖 Auto-started conditional bot monitor');
    }

    // Auto-start stabilizer bot monitor if user has active stabilizer bots
    const userStabilizerBots = await db.collection('stabilizer_bots').countDocuments({
      userId: user.uid,
      isActive: true,
      isRunning: true
    });

    if (userStabilizerBots > 0 && !stabilizerBotMonitor.isRunning) {
      await stabilizerBotMonitor.start();
      console.log('🎯 Auto-started stabilizer bot monitor');
    }

    // Log admin activity
    await db.collection('bot_admin_logs').insertOne({
      userId: user.uid,
      action: 'BOT_ENABLED',
      timestamp: new Date(),
      details: { message: 'User enabled their bot trading' }
    });

    console.log(`✅ Bot enabled for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'Bot enabled successfully',
      data: { 
        botEnabled: true,
        botMonitorRunning: botMonitor.isRunning,
        stabilizerMonitorRunning: stabilizerBotMonitor.isRunning
      }
    });
  } catch (error) {
    console.error('Error enabling bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to enable bot', data: null });
  }
});

// POST /api/bot/user/disable - Disable bot for current user
app.post('/api/bot/user/disable', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Update user's botEnabled flag
    await db.collection('users').updateOne(
      { uid: user.uid },
      { 
        $set: { 
          botEnabled: false,
          botDisabledAt: new Date().toISOString()
        } 
      }
    );

    // Check if any other users still have bot enabled
    const remainingEnabledUsers = await db.collection('users').countDocuments({
      botEnabled: true,
      apiKey: { $exists: true },
      apiSecret: { $exists: true }
    });

    // Stop bot monitor if no users have bot enabled
    if (remainingEnabledUsers === 0 && botMonitor.isRunning) {
      await botMonitor.stop();
      console.log('⏸️ Stopped conditional bot monitor - no users with botEnabled: true');
    }

    // Check if any enabled users have stabilizer bots
    if (stabilizerBotMonitor.isRunning) {
      const enabledUsersWithStabilizers = await db.collection('stabilizer_bots').countDocuments({
        isActive: true,
        isRunning: true,
        userId: { 
          $in: (await db.collection('users').find({ 
            botEnabled: true,
            apiKey: { $exists: true },
            apiSecret: { $exists: true }
          }).toArray()).map(u => u.uid)
        }
      });

      if (enabledUsersWithStabilizers === 0) {
        await stabilizerBotMonitor.stop();
        console.log('⏸️ Stopped stabilizer bot monitor - no enabled users with active stabilizers');
      }
    }

    // Log admin activity
    await db.collection('bot_admin_logs').insertOne({
      userId: user.uid,
      action: 'BOT_DISABLED',
      timestamp: new Date(),
      details: { message: 'User disabled their bot trading' }
    });

    console.log(`⏸️ Bot disabled for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'Bot disabled successfully',
      data: { 
        botEnabled: false,
        botMonitorRunning: botMonitor.isRunning,
        stabilizerMonitorRunning: stabilizerBotMonitor.isRunning,
        remainingEnabledUsers
      }
    });
  } catch (error) {
    console.error('Error disabling bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to disable bot', data: null });
  }
});

// GET /api/bot/user/status - Get user's bot enabled status
app.get('/api/bot/user/status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: { 
        botEnabled: user.botEnabled || false,
        botEnabledAt: user.botEnabledAt || null,
        botDisabledAt: user.botDisabledAt || null,
        hasApiCredentials: !!(user.apiKey && user.apiSecret)
      }
    });
  } catch (error) {
    console.error('Error fetching bot status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch bot status', data: null });
  }
});

// POST /api/bot/user/toggle - Toggle bot enabled status for current user
app.post('/api/bot/user/toggle', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Get current status
    const currentStatus = user.botEnabled || false;
    const newStatus = !currentStatus;

    if (newStatus) {
      // Enabling bot - check API credentials
      if (!user.apiKey || !user.apiSecret) {
        return res.status(400).json({
          code: '-1',
          msg: 'Please configure your API credentials first before enabling the bot',
          data: { botEnabled: false }
        });
      }

      // Update to enabled
      await db.collection('users').updateOne(
        { uid: user.uid },
        { 
          $set: { 
            botEnabled: true,
            botEnabledAt: new Date().toISOString()
          } 
        }
      );

      // Auto-start monitors
      if (!botMonitor.isRunning) {
        await botMonitor.start();
        console.log('🤖 Auto-started conditional bot monitor');
      }

      const userStabilizerBots = await db.collection('stabilizer_bots').countDocuments({
        userId: user.uid,
        isActive: true,
        isRunning: true
      });

      if (userStabilizerBots > 0 && !stabilizerBotMonitor.isRunning) {
        await stabilizerBotMonitor.start();
        console.log('🎯 Auto-started stabilizer bot monitor');
      }

      await db.collection('bot_admin_logs').insertOne({
        userId: user.uid,
        action: 'BOT_ENABLED',
        timestamp: new Date(),
        details: { message: 'User enabled their bot trading via toggle' }
      });

      console.log(`✅ Bot enabled for user ${user.uid}`);

      res.json({
        code: '0',
        msg: 'Bot enabled successfully',
        data: { 
          botEnabled: true,
          botMonitorRunning: botMonitor.isRunning,
          stabilizerMonitorRunning: stabilizerBotMonitor.isRunning
        }
      });
    } else {
      // Disabling bot
      await db.collection('users').updateOne(
        { uid: user.uid },
        { 
          $set: { 
            botEnabled: false,
            botDisabledAt: new Date().toISOString()
          } 
        }
      );

      // Check if any other users still have bot enabled
      const remainingEnabledUsers = await db.collection('users').countDocuments({
        botEnabled: true,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      });

      // Stop monitors if no users have bot enabled
      if (remainingEnabledUsers === 0 && botMonitor.isRunning) {
        await botMonitor.stop();
        console.log('⏸️ Stopped conditional bot monitor - no users with botEnabled: true');
      }

      if (stabilizerBotMonitor.isRunning) {
        const enabledUsersWithStabilizers = await db.collection('stabilizer_bots').countDocuments({
          isActive: true,
          isRunning: true,
          userId: { 
            $in: (await db.collection('users').find({ 
              botEnabled: true,
              apiKey: { $exists: true },
              apiSecret: { $exists: true }
            }).toArray()).map(u => u.uid)
          }
        });

        if (enabledUsersWithStabilizers === 0) {
          await stabilizerBotMonitor.stop();
          console.log('⏸️ Stopped stabilizer bot monitor - no enabled users');
        }
      }

      await db.collection('bot_admin_logs').insertOne({
        userId: user.uid,
        action: 'BOT_DISABLED',
        timestamp: new Date(),
        details: { message: 'User disabled their bot trading via toggle' }
      });

      console.log(`⏸️ Bot disabled for user ${user.uid}`);

      res.json({
        code: '0',
        msg: 'Bot disabled successfully',
        data: { 
          botEnabled: false,
          botMonitorRunning: botMonitor.isRunning,
          stabilizerMonitorRunning: stabilizerBotMonitor.isRunning,
          remainingEnabledUsers
        }
      });
    }
  } catch (error) {
    console.error('Error toggling bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to toggle bot', data: null });
  }
});

// GET /api/bot/admin-logs - Get admin activity logs
app.get('/api/bot/admin-logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const limit = parseInt(req.query.limit) || 100;
    const logs = await db.collection('bot_admin_logs')
      .find({ userId: user.uid })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: logs
    });
  } catch (error) {
    console.error('Error fetching admin logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch admin logs', data: null });
  }
});

// ============================================
// Scheduled Bot Endpoints (Market Making)
// ============================================

// POST /api/bot/scheduled/create - Create a scheduled market-making bot
app.post('/api/bot/scheduled/create', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials required. Please add your API credentials first.', 
        data: null 
      });
    }

    const { name, totalUsdtBudget, durationHours, bidOffsetPercent } = req.body;

    // Validate inputs
    if (!totalUsdtBudget || !durationHours || !bidOffsetPercent) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields: totalUsdtBudget, durationHours, bidOffsetPercent', 
        data: null 
      });
    }

    // Calculate USDT per hour
    const usdtPerHour = totalUsdtBudget / durationHours;
    const intervalMs = 3600000; // 1 hour in milliseconds

    const scheduledBot = {
      userId: user.uid,
      name: name || `Accumulation Bot - ${new Date().toISOString()}`,
      totalUsdtBudget: parseFloat(totalUsdtBudget),
      durationHours: parseInt(durationHours),
      bidOffsetPercent: parseFloat(bidOffsetPercent),
      usdtPerHour: usdtPerHour,
      intervalMs: intervalMs,
      symbol: 'GCBUSDT',
      isActive: false,
      isRunning: false,
      spentUsdt: 0,
      accumulatedGcb: 0,
      executedBuys: 0,
      totalBuys: durationHours,
      nextBuyAt: null,
      startedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'created'
    };

    const result = await db.collection('scheduled_bots').insertOne(scheduledBot);
    const createdBot = await db.collection('scheduled_bots').findOne({ _id: result.insertedId });

    console.log(`✅ Scheduled bot created: ${createdBot._id} for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'Scheduled bot created successfully',
      data: createdBot
    });
  } catch (error) {
    console.error('Error creating scheduled bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to create scheduled bot', data: null });
  }
});

// GET /api/bot/scheduled/list - Get all scheduled bots for user
app.get('/api/bot/scheduled/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const bots = await db.collection('scheduled_bots')
      .find({ userId: user.uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: bots
    });
  } catch (error) {
    console.error('Error fetching scheduled bots:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch scheduled bots', data: null });
  }
});

// POST /api/bot/scheduled/:id/start - Start a scheduled bot
app.post('/api/bot/scheduled/:id/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('scheduled_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Scheduled bot not found', data: null });
    }

    // Update bot status
    const nextBuyAt = new Date(Date.now() + 60000); // First buy in 1 minute
    await db.collection('scheduled_bots').updateOne(
      { _id: new ObjectId(botId) },
      { 
        $set: { 
          isActive: true,
          isRunning: true,
          startedAt: new Date(),
          nextBuyAt: nextBuyAt,
          status: 'running',
          updatedAt: new Date()
        } 
      }
    );

    console.log(`🚀 Scheduled bot started: ${botId}`);

    res.json({
      code: '0',
      msg: 'Scheduled bot started successfully',
      data: { botId, nextBuyAt }
    });
  } catch (error) {
    console.error('Error starting scheduled bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to start scheduled bot', data: null });
  }
});

// POST /api/bot/scheduled/:id/stop - Stop a scheduled bot
app.post('/api/bot/scheduled/:id/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    
    await db.collection('scheduled_bots').updateOne(
      { _id: new ObjectId(botId), userId: user.uid },
      { 
        $set: { 
          isActive: false,
          isRunning: false,
          status: 'stopped',
          stoppedAt: new Date(),
          updatedAt: new Date()
        } 
      }
    );

    console.log(`⏸️ Scheduled bot stopped: ${botId}`);

    res.json({
      code: '0',
      msg: 'Scheduled bot stopped successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error stopping scheduled bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to stop scheduled bot', data: null });
  }
});

// DELETE /api/bot/scheduled/:id - Delete a scheduled bot
app.delete('/api/bot/scheduled/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const result = await db.collection('scheduled_bots').deleteOne({
      _id: new ObjectId(botId),
      userId: user.uid
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Scheduled bot not found' });
    }

    res.json({
      code: '0',
      msg: 'Scheduled bot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting scheduled bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to delete scheduled bot' });
  }
});

// GET /api/bot/scheduled/:id/trades - Get trade history for a scheduled bot
app.get('/api/bot/scheduled/:id/trades', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const trades = await db.collection('scheduled_bot_trades')
      .find({ scheduledBotId: new ObjectId(botId), userId: user.uid })
      .sort({ executedAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: trades
    });
  } catch (error) {
    console.error('Error fetching scheduled bot trades:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch scheduled bot trades', data: null });
  }
});

// ============================================
// Stabilizer Bot Endpoints
// ============================================

// POST /api/bot/stabilizer/create - Create a stabilizer bot
app.post('/api/bot/stabilizer/create', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials required. Please add your API credentials first.', 
        data: null 
      });
    }

    const { name, targetPrice } = req.body;

    if (!targetPrice) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required field: targetPrice', 
        data: null 
      });
    }

    const stabilizerBot = {
      userId: user.uid,
      name: name || `Stabilizer Bot - ${new Date().toISOString()}`,
      symbol: 'GCBUSDT',
      targetPrice: parseFloat(targetPrice),
      isActive: false,
      isRunning: false,
      executionCount: 0,
      totalUsdtSpent: 0,
      lastExecutedAt: null,
      lastCheckedAt: null,
      lastMarketPrice: null,
      lastFinalPrice: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'created'
    };

    const result = await db.collection('stabilizer_bots').insertOne(stabilizerBot);
    const createdBot = await db.collection('stabilizer_bots').findOne({ _id: result.insertedId });

    console.log(`✅ Stabilizer bot created: ${createdBot._id} for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'Stabilizer bot created successfully',
      data: createdBot
    });
  } catch (error) {
    console.error('Error creating stabilizer bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to create stabilizer bot', data: null });
  }
});

// GET /api/bot/stabilizer/list - Get all stabilizer bots for user
app.get('/api/bot/stabilizer/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const bots = await db.collection('stabilizer_bots')
      .find({ userId: user.uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: bots
    });
  } catch (error) {
    console.error('Error fetching stabilizer bots:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch stabilizer bots', data: null });
  }
});

// POST /api/bot/stabilizer/:id/start - Start a stabilizer bot
app.post('/api/bot/stabilizer/:id/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('stabilizer_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Stabilizer bot not found', data: null });
    }

    await db.collection('stabilizer_bots').updateOne(
      { _id: new ObjectId(botId) },
      { 
        $set: { 
          isActive: true,
          isRunning: true,
          status: 'running',
          updatedAt: new Date()
        } 
      }
    );

    // Start the monitor if not already running
    if (!stabilizerBotMonitor.isRunning) {
      await stabilizerBotMonitor.start();
    }

    console.log(`🚀 Stabilizer bot started: ${botId}`);

    res.json({
      code: '0',
      msg: 'Stabilizer bot started successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error starting stabilizer bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to start stabilizer bot', data: null });
  }
});

// POST /api/bot/stabilizer/:id/stop - Stop a stabilizer bot
app.post('/api/bot/stabilizer/:id/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    
    await db.collection('stabilizer_bots').updateOne(
      { _id: new ObjectId(botId), userId: user.uid },
      { 
        $set: { 
          isActive: false,
          isRunning: false,
          status: 'stopped',
          stoppedAt: new Date(),
          updatedAt: new Date()
        } 
      }
    );

    console.log(`⏸️ Stabilizer bot stopped: ${botId}`);

    res.json({
      code: '0',
      msg: 'Stabilizer bot stopped successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error stopping stabilizer bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to stop stabilizer bot', data: null });
  }
});

// DELETE /api/bot/stabilizer/:id - Delete a stabilizer bot
app.delete('/api/bot/stabilizer/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const result = await db.collection('stabilizer_bots').deleteOne({
      _id: new ObjectId(botId),
      userId: user.uid
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Stabilizer bot not found' });
    }

    res.json({
      code: '0',
      msg: 'Stabilizer bot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting stabilizer bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to delete stabilizer bot' });
  }
});

// PUT /api/bot/stabilizer/:id/max-buy - Update max buy amount for a stabilizer bot
app.put('/api/bot/stabilizer/:id/max-buy', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const { id } = req.params;
    const { maxBuyAmount } = req.body;

    // Validate maxBuyAmount
    const parsedMaxBuy = parseFloat(maxBuyAmount) || 0;
    if (parsedMaxBuy < 0) {
      return res.status(400).json({ code: '-1', msg: 'Max buy amount cannot be negative', data: null });
    }

    const result = await db.collection('stabilizer_bots').updateOne(
      { _id: new ObjectId(id), userId: user.uid },
      { 
        $set: { 
          maxBuyAmount: parsedMaxBuy,
          thresholdExceeded: false, // Reset threshold exceeded flag when updating
          updatedAt: new Date() 
        } 
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Stabilizer bot not found', data: null });
    }

    res.json({
      code: '0',
      msg: 'Max buy amount updated successfully',
      data: { maxBuyAmount: parsedMaxBuy }
    });
  } catch (error) {
    console.error('Error updating max buy amount:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to update max buy amount' });
  }
});

// GET /api/bot/stabilizer/:id/logs - Get logs for a stabilizer bot
app.get('/api/bot/stabilizer/:id/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const limit = parseInt(req.query.limit) || 100;

    // Get logs from both in-memory and database
    const memoryLogs = stabilizerBotMonitor.getLogs(limit, botId);
    const dbLogs = await db.collection('stabilizer_bot_logs')
      .find({ botId: botId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    // Combine and deduplicate
    const allLogs = [...memoryLogs];
    const timestamps = new Set(memoryLogs.map(l => l.timestamp));
    
    for (const log of dbLogs) {
      if (!timestamps.has(log.timestamp)) {
        allLogs.push(log);
      }
    }

    // Sort by timestamp
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      code: '0',
      msg: 'Success',
      data: allLogs.slice(0, limit)
    });
  } catch (error) {
    console.error('Error fetching stabilizer bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
  }
});

// GET /api/bot/stabilizer/:id/trades - Get trade history for a stabilizer bot
app.get('/api/bot/stabilizer/:id/trades', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const trades = await db.collection('stabilizer_bot_trades')
      .find({ stabilizerBotId: new ObjectId(botId), userId: user.uid })
      .sort({ executedAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: trades
    });
  } catch (error) {
    console.error('Error fetching stabilizer bot trades:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch trades', data: null });
  }
});

// GET /api/bot/stabilizer/logs - Get all stabilizer bot activity logs
app.get('/api/bot/stabilizer/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = stabilizerBotMonitor.getLogs(limit);
    
    res.json({
      code: '0',
      msg: 'Success',
      data: logs
    });
  } catch (error) {
    console.error('Error fetching stabilizer bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
  }
});

// GET /api/bot/stabilizer/status - Get stabilizer bot monitor status
app.get('/api/bot/stabilizer/status', async (req, res) => {
  try {
    const status = stabilizerBotMonitor.getStatus();
    res.json({
      code: '0',
      msg: 'Success',
      data: status
    });
  } catch (error) {
    console.error('Error getting stabilizer bot status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get stabilizer bot status', data: null });
  }
});

// ============================================
// Market Maker Bot Endpoints
// ============================================

// POST /api/bot/market-maker/create - Create a market maker bot
app.post('/api/bot/market-maker/create', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    // Check API credentials
    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials required. Please add your API credentials first.', 
        data: null 
      });
    }

    const { 
      name, 
      symbol, 
      targetPrice, 
      spreadPercent, 
      orderSize, 
      priceFloor, 
      priceCeil, 
      incrementStep,
      telegramEnabled,
      telegramUserId
    } = req.body;

    // Validate required fields
    if (!name || !symbol || !targetPrice || !spreadPercent || !orderSize || !incrementStep) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields', 
        data: null 
      });
    }

    const marketMakerBot = {
      userId: user.uid,
      name,
      symbol: symbol.toUpperCase(),
      targetPrice: parseFloat(targetPrice),
      spreadPercent: parseFloat(spreadPercent),
      orderSize: parseFloat(orderSize),
      priceFloor: priceFloor ? parseFloat(priceFloor) : null,
      priceCeil: priceCeil ? parseFloat(priceCeil) : null,
      incrementStep: parseFloat(incrementStep),
      currentOrderSize: parseFloat(orderSize), // Current order size
      initialOrderSize: parseFloat(orderSize), // Store initial size for oscillation logic
      isDecreasing: true, // Start by decreasing (100% -> 40%)
      executionCount: 0,
      isActive: false,
      isRunning: false,
      targetReached: false,
      telegramEnabled: telegramEnabled || false,
      telegramUserId: telegramUserId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'created'
    };

    const result = await db.collection('market_maker_bots').insertOne(marketMakerBot);
    const createdBot = await db.collection('market_maker_bots').findOne({ _id: result.insertedId });

    res.json({
      code: '0',
      msg: 'Market maker bot created successfully',
      data: createdBot
    });
  } catch (error) {
    console.error('Error creating market maker bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to create market maker bot', data: null });
  }
});

// GET /api/bot/market-maker/list - Get all market maker bots for user
app.get('/api/bot/market-maker/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const bots = await db.collection('market_maker_bots')
      .find({ userId: user.uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: bots
    });
  } catch (error) {
    console.error('Error fetching market maker bots:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch market maker bots', data: null });
  }
});

// POST /api/bot/market-maker/:id/start - Start a market maker bot
app.post('/api/bot/market-maker/:id/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('market_maker_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Market maker bot not found', data: null });
    }

    // Update bot status
    await db.collection('market_maker_bots').updateOne(
      { _id: new ObjectId(botId) },
      { 
        $set: { 
          isActive: true,
          isRunning: true,
          targetReached: false, // Reset target reached flag
          status: 'running',
          updatedAt: new Date()
        } 
      }
    );

    console.log(`🚀 Market maker bot started: ${botId}`);

    // Start the monitor if not already running
    if (!marketMakerBotMonitor.isRunning) {
      await marketMakerBotMonitor.start();
    }

    res.json({
      code: '0',
      msg: 'Market maker bot started successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error starting market maker bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to start market maker bot', data: null });
  }
});

// POST /api/bot/market-maker/:id/stop - Stop a market maker bot
app.post('/api/bot/market-maker/:id/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('market_maker_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Market maker bot not found', data: null });
    }

    // Update bot status
    await db.collection('market_maker_bots').updateOne(
      { _id: new ObjectId(botId) },
      { 
        $set: { 
          isActive: false,
          isRunning: false,
          status: 'stopped',
          updatedAt: new Date()
        } 
      }
    );

    console.log(`⏸️ Market maker bot stopped: ${botId}`);

    res.json({
      code: '0',
      msg: 'Market maker bot stopped successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error stopping market maker bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to stop market maker bot', data: null });
  }
});

// DELETE /api/bot/market-maker/:id - Delete a market maker bot
app.delete('/api/bot/market-maker/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const result = await db.collection('market_maker_bots').deleteOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Market maker bot not found', data: null });
    }

    console.log(`🗑️ Market maker bot deleted: ${botId}`);

    res.json({
      code: '0',
      msg: 'Market maker bot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting market maker bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to delete market maker bot', data: null });
  }
});

// GET /api/bot/market-maker/logs - Get market maker bot activity logs
app.get('/api/bot/market-maker/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const limit = parseInt(req.query.limit) || 100;

    if (!marketMakerBotMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: []
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: marketMakerBotMonitor.getLogs(limit)
    });
  } catch (error) {
    console.error('Error getting market maker bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get market maker bot logs', data: null });
  }
});

// GET /api/bot/market-maker/status - Get market maker bot monitor status
app.get('/api/bot/market-maker/status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    if (!marketMakerBotMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: { isRunning: false, uptime: 'Not initialized' }
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: marketMakerBotMonitor.getStatus()
    });
  } catch (error) {
    console.error('Error getting market maker bot status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get market maker bot status', data: null });
  }
});

// ============================================
// Buy Wall Bot Endpoints
// ============================================

// POST /api/bot/buywall/create - Create a buy wall bot
app.post('/api/bot/buywall/create', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials required. Please add your API credentials first.', 
        data: null 
      });
    }

    const { name, targetPrice, buyOrders } = req.body;

    if (!targetPrice || !buyOrders || !Array.isArray(buyOrders) || buyOrders.length === 0) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'Missing required fields: targetPrice and buyOrders array', 
        data: null 
      });
    }

    // Validate buyOrders format
    for (const order of buyOrders) {
      if (!order.price || !order.usdtAmount || order.price <= 0 || order.usdtAmount <= 0) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'Each buy order must have valid price and usdtAmount (> 0)', 
          data: null 
        });
      }
    }

    // Sort buyOrders by price descending
    const sortedOrders = buyOrders
      .map(o => ({ price: parseFloat(o.price), usdtAmount: parseFloat(o.usdtAmount) }))
      .sort((a, b) => b.price - a.price);

    const totalUsdt = sortedOrders.reduce((sum, o) => sum + o.usdtAmount, 0);

    const buyWallBot = {
      userId: user.uid,
      name: name || `Buy Wall Bot - ${new Date().toISOString()}`,
      symbol: 'GCBUSDT',
      targetPrice: parseFloat(targetPrice),
      buyOrders: sortedOrders,
      totalUsdt: totalUsdt,
      ordersPlaced: false,
      placedOrders: [],
      failedOrders: [],
      totalRefills: 0,
      isActive: false,
      isRunning: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'created'
    };

    const result = await db.collection('buywall_bots').insertOne(buyWallBot);
    const createdBot = await db.collection('buywall_bots').findOne({ _id: result.insertedId });

    console.log(`✅ Buy Wall bot created: ${createdBot._id} for user ${user.uid} with ${sortedOrders.length} orders totaling $${totalUsdt.toFixed(2)}`);

    res.json({
      code: '0',
      msg: 'Buy Wall bot created successfully',
      data: createdBot
    });
  } catch (error) {
    console.error('Error creating buy wall bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to create buy wall bot', data: null });
  }
});

// GET /api/bot/buywall/list - Get all buy wall bots for user
app.get('/api/bot/buywall/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const bots = await db.collection('buywall_bots')
      .find({ userId: user.uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: bots
    });
  } catch (error) {
    console.error('Error fetching buy wall bots:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch buy wall bots', data: null });
  }
});

// POST /api/bot/buywall/:id/start - Start a buy wall bot
app.post('/api/bot/buywall/:id/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('buywall_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Buy Wall bot not found', data: null });
    }

    await db.collection('buywall_bots').updateOne(
      { _id: new ObjectId(botId) },
      { 
        $set: { 
          isActive: true,
          isRunning: true,
          status: 'running',
          updatedAt: new Date()
        } 
      }
    );

    // Start the monitor if not already running
    if (!buyWallBotMonitor.isRunning) {
      await buyWallBotMonitor.start();
    }

    console.log(`🚀 Buy Wall bot started: ${botId}`);

    res.json({
      code: '0',
      msg: 'Buy Wall bot started successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error starting buy wall bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to start buy wall bot', data: null });
  }
});

// POST /api/bot/buywall/:id/stop - Stop a buy wall bot
app.post('/api/bot/buywall/:id/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    
    await db.collection('buywall_bots').updateOne(
      { _id: new ObjectId(botId), userId: user.uid },
      { 
        $set: { 
          isActive: false,
          isRunning: false,
          status: 'stopped',
          stoppedAt: new Date(),
          updatedAt: new Date()
        } 
      }
    );

    console.log(`⏸️ Buy Wall bot stopped: ${botId}`);

    res.json({
      code: '0',
      msg: 'Buy Wall bot stopped successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error stopping buy wall bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to stop buy wall bot', data: null });
  }
});

// DELETE /api/bot/buywall/:id - Delete a buy wall bot
app.delete('/api/bot/buywall/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const result = await db.collection('buywall_bots').deleteOne({
      _id: new ObjectId(botId),
      userId: user.uid
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Buy Wall bot not found' });
    }

    // Also delete related trades and logs
    await db.collection('buywall_bot_trades').deleteMany({ botId: new ObjectId(botId) });
    await db.collection('buywall_bot_logs').deleteMany({ botId: new ObjectId(botId) });

    res.json({
      code: '0',
      msg: 'Buy Wall bot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting buy wall bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to delete buy wall bot' });
  }
});

// PUT /api/bot/buywall/:id - Update a buy wall bot (add/modify orders)
app.put('/api/bot/buywall/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('buywall_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Buy Wall bot not found', data: null });
    }

    const { name, targetPrice, buyOrders } = req.body;
    const updates = { updatedAt: new Date() };

    if (name) updates.name = name;
    if (targetPrice) updates.targetPrice = parseFloat(targetPrice);
    
    if (buyOrders && Array.isArray(buyOrders)) {
      const sortedOrders = buyOrders
        .map(o => ({ price: parseFloat(o.price), usdtAmount: parseFloat(o.usdtAmount) }))
        .sort((a, b) => b.price - a.price);
      updates.buyOrders = sortedOrders;
      updates.totalUsdt = sortedOrders.reduce((sum, o) => sum + o.usdtAmount, 0);
    }

    await db.collection('buywall_bots').updateOne(
      { _id: new ObjectId(botId) },
      { $set: updates }
    );

    const updatedBot = await db.collection('buywall_bots').findOne({ _id: new ObjectId(botId) });

    res.json({
      code: '0',
      msg: 'Buy Wall bot updated successfully',
      data: updatedBot
    });
  } catch (error) {
    console.error('Error updating buy wall bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to update buy wall bot', data: null });
  }
});

// GET /api/bot/buywall/:id/logs - Get logs for a buy wall bot
app.get('/api/bot/buywall/:id/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const limit = parseInt(req.query.limit) || 100;

    const logs = await db.collection('buywall_bot_logs')
      .find({ botId: new ObjectId(botId) })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: logs
    });
  } catch (error) {
    console.error('Error fetching buy wall bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
  }
});

// GET /api/bot/buywall/:id/trades - Get trade history for a buy wall bot
app.get('/api/bot/buywall/:id/trades', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const trades = await db.collection('buywall_bot_trades')
      .find({ botId: new ObjectId(botId), userId: user.uid })
      .sort({ executedAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: trades
    });
  } catch (error) {
    console.error('Error fetching buy wall bot trades:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch trades', data: null });
  }
});

// GET /api/bot/buywall/logs - Get all buy wall bot activity logs
app.get('/api/bot/buywall/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const limit = parseInt(req.query.limit) || 100;

    if (!buyWallBotMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: []
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: buyWallBotMonitor.getLogs(limit)
    });
  } catch (error) {
    console.error('Error fetching buy wall bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
  }
});

// GET /api/bot/buywall/status - Get buy wall bot monitor status
app.get('/api/bot/buywall/status', async (req, res) => {
  try {
    if (!buyWallBotMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: { isRunning: false }
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: buyWallBotMonitor.getStatus()
    });
  } catch (error) {
    console.error('Error getting buy wall bot status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get buy wall bot status', data: null });
  }
});

// POST /api/bot/buywall/:id/reset - Reset a buy wall bot (clear placed orders, start fresh)
app.post('/api/bot/buywall/:id/reset', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    
    await db.collection('buywall_bots').updateOne(
      { _id: new ObjectId(botId), userId: user.uid },
      { 
        $set: { 
          ordersPlaced: false,
          placedOrders: [],
          failedOrders: [],
          totalRefills: 0,
          updatedAt: new Date()
        } 
      }
    );

    console.log(`🔄 Buy Wall bot reset: ${botId}`);

    res.json({
      code: '0',
      msg: 'Buy Wall bot reset successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error resetting buy wall bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to reset buy wall bot', data: null });
  }
});

// ============================================
// Price Keeper Bot Endpoints
// ============================================

// POST /api/bot/price-keeper/create - Create a price keeper bot
app.post('/api/bot/price-keeper/create', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    if (!user.apiKey || !user.apiSecret) {
      return res.status(400).json({ 
        code: '-1', 
        msg: 'API credentials required. Please add your API credentials first.', 
        data: null 
      });
    }

    const { name, orderAmount, cooldownSeconds, telegramEnabled } = req.body;

    const priceKeeperBot = {
      userId: user.uid,
      name: name || `Price Keeper Bot - ${new Date().toISOString()}`,
      symbol: 'GCBUSDT',
      orderAmount: parseFloat(orderAmount) || 0.1, // Default 0.1 USDT
      cooldownSeconds: parseInt(cooldownSeconds) || 5, // Default 5 seconds cooldown
      telegramEnabled: telegramEnabled || false,
      isActive: false,
      isRunning: false,
      executionCount: 0,
      totalUsdtSpent: 0,
      lastExecutedAt: null,
      lastCheckedAt: null,
      lastMarketPrice: null,
      lastBestAskPrice: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'created'
    };

    const result = await db.collection('price_keeper_bots').insertOne(priceKeeperBot);
    const createdBot = await db.collection('price_keeper_bots').findOne({ _id: result.insertedId });

    console.log(`✅ Price Keeper bot created: ${createdBot._id} for user ${user.uid}`);

    res.json({
      code: '0',
      msg: 'Price Keeper bot created successfully',
      data: createdBot
    });
  } catch (error) {
    console.error('Error creating price keeper bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to create price keeper bot', data: null });
  }
});

// GET /api/bot/price-keeper/list - Get all price keeper bots for user
app.get('/api/bot/price-keeper/list', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const bots = await db.collection('price_keeper_bots')
      .find({ userId: user.uid })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: bots
    });
  } catch (error) {
    console.error('Error fetching price keeper bots:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch price keeper bots', data: null });
  }
});

// POST /api/bot/price-keeper/:id/start - Start a price keeper bot
app.post('/api/bot/price-keeper/:id/start', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const bot = await db.collection('price_keeper_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    if (!bot) {
      return res.status(404).json({ code: '-1', msg: 'Price Keeper bot not found', data: null });
    }

    await db.collection('price_keeper_bots').updateOne(
      { _id: new ObjectId(botId) },
      { 
        $set: { 
          isActive: true,
          isRunning: true,
          status: 'running',
          updatedAt: new Date()
        } 
      }
    );

    // Start the monitor if not already running
    if (priceKeeperBotMonitor && !priceKeeperBotMonitor.isRunning) {
      await priceKeeperBotMonitor.start();
    }

    console.log(`🚀 Price Keeper bot started: ${botId}`);

    res.json({
      code: '0',
      msg: 'Price Keeper bot started successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error starting price keeper bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to start price keeper bot', data: null });
  }
});

// POST /api/bot/price-keeper/:id/stop - Stop a price keeper bot
app.post('/api/bot/price-keeper/:id/stop', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;

    await db.collection('price_keeper_bots').updateOne(
      { _id: new ObjectId(botId), userId: user.uid },
      { 
        $set: { 
          isActive: false,
          isRunning: false,
          status: 'stopped',
          updatedAt: new Date()
        } 
      }
    );

    console.log(`⏹️ Price Keeper bot stopped: ${botId}`);

    res.json({
      code: '0',
      msg: 'Price Keeper bot stopped successfully',
      data: { botId }
    });
  } catch (error) {
    console.error('Error stopping price keeper bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to stop price keeper bot', data: null });
  }
});

// DELETE /api/bot/price-keeper/:id - Delete a price keeper bot
app.delete('/api/bot/price-keeper/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const result = await db.collection('price_keeper_bots').deleteOne({
      _id: new ObjectId(botId),
      userId: user.uid
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ code: '-1', msg: 'Price Keeper bot not found', data: null });
    }

    // Also delete logs for this bot
    await db.collection('price_keeper_bot_logs').deleteMany({ botId: botId });

    console.log(`🗑️ Price Keeper bot deleted: ${botId}`);

    res.json({
      code: '0',
      msg: 'Price Keeper bot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting price keeper bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to delete price keeper bot', data: null });
  }
});

// GET /api/bot/price-keeper/:id/logs - Get logs for a specific price keeper bot
app.get('/api/bot/price-keeper/:id/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const limit = parseInt(req.query.limit) || 100;

    const logs = await db.collection('price_keeper_bot_logs')
      .find({ botId: botId, userId: user.uid })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    res.json({
      code: '0',
      msg: 'Success',
      data: logs
    });
  } catch (error) {
    console.error('Error fetching price keeper bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
  }
});

// GET /api/bot/price-keeper/logs - Get all price keeper bot logs (monitor logs)
app.get('/api/bot/price-keeper/logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const limit = parseInt(req.query.limit) || 100;

    if (!priceKeeperBotMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: []
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: priceKeeperBotMonitor.getLogs(limit)
    });
  } catch (error) {
    console.error('Error fetching price keeper bot logs:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
  }
});

// GET /api/bot/price-keeper/status - Get price keeper bot monitor status
app.get('/api/bot/price-keeper/status', async (req, res) => {
  try {
    if (!priceKeeperBotMonitor) {
      return res.json({
        code: '0',
        msg: 'Success',
        data: { isRunning: false }
      });
    }

    res.json({
      code: '0',
      msg: 'Success',
      data: priceKeeperBotMonitor.getStatus()
    });
  } catch (error) {
    console.error('Error getting price keeper bot status:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to get price keeper bot status', data: null });
  }
});

// PUT /api/bot/price-keeper/:id - Update a price keeper bot
app.put('/api/bot/price-keeper/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: '-1', msg: 'Unauthorized', data: null });
    }

    const token = authHeader.split(' ')[1];
    const user = await db.collection('users').findOne({ token });
    
    if (!user) {
      return res.status(401).json({ code: '-1', msg: 'Invalid token', data: null });
    }

    const botId = req.params.id;
    const { orderAmount, cooldownSeconds } = req.body;

    const updateFields = { updatedAt: new Date() };
    if (orderAmount !== undefined) updateFields.orderAmount = parseFloat(orderAmount);
    if (cooldownSeconds !== undefined) updateFields.cooldownSeconds = parseInt(cooldownSeconds);

    await db.collection('price_keeper_bots').updateOne(
      { _id: new ObjectId(botId), userId: user.uid },
      { $set: updateFields }
    );

    const updatedBot = await db.collection('price_keeper_bots').findOne({ 
      _id: new ObjectId(botId), 
      userId: user.uid 
    });

    console.log(`✏️ Price Keeper bot updated: ${botId}`);

    res.json({
      code: '0',
      msg: 'Price Keeper bot updated successfully',
      data: updatedBot
    });
  } catch (error) {
    console.error('Error updating price keeper bot:', error);
    res.status(500).json({ code: '-1', msg: 'Failed to update price keeper bot', data: null });
  }
});

// ============================================
// Start Server
// ============================================
connectToMongoDB().then(async () => {
  // Initialize Bot Monitor
  botMonitor = new BotMonitor(db, {
    openApiBase: GCBEX_OPEN_API_BASE,
    marketPollInterval: 10000, // 10 seconds
    balancePollInterval: 30000, // 30 seconds
    conditionCooldown: 60000 // 1 minute
  });
  console.log('✅ Bot Monitor initialized');

  // Initialize Scheduled Bot Monitor
  scheduledBotMonitor = new ScheduledBotMonitor(db, {
    openApiBase: GCBEX_OPEN_API_BASE,
    checkInterval: 60000 // Check every 1 minute
  });
  console.log('✅ Scheduled Bot Monitor initialized');

  // Initialize Market Maker Bot Monitor
  marketMakerBotMonitor = new MarketMakerBotMonitor(db, {
    openApiBase: GCBEX_OPEN_API_BASE,
    checkInterval: 30000 // Check every 30 seconds
  });
  console.log('✅ Market Maker Bot Monitor initialized');

  // Initialize Stabilizer Bot Monitor
  stabilizerBotMonitor = new StabilizerBotMonitor(db, {
    openApiBase: GCBEX_OPEN_API_BASE,
    checkInterval: 5000 // Check every 5 seconds
  });
  console.log('✅ Stabilizer Bot Monitor initialized');

  // Initialize Buy Wall Bot Monitor
  buyWallBotMonitor = new BuyWallBotMonitor(db);
  console.log('✅ Buy Wall Bot Monitor initialized');

  // Initialize Price Keeper Bot Monitor
  priceKeeperBotMonitor = new PriceKeeperBotMonitor(db);
  console.log('✅ Price Keeper Bot Monitor initialized');

  // Initialize MEXC MM Bot Monitor
  mexcMMBotMonitor = new MexcMMBotMonitor(db);
  setupMexcMMBotRoutes(app, db, mexcMMBotMonitor);
  console.log('✅ MEXC MM Bot Monitor initialized');

  // Always start MEXC MM Bot Monitor (it will check for running bots)
  try {
    await mexcMMBotMonitor.start();
    console.log('✅ MEXC MM Bot Monitor started');
  } catch (error) {
    console.error('⚠️ Error starting MEXC MM Bot Monitor:', error.message);
  }

  // Initialize MEXC User Routes (for separate MEXC client)
  setupMexcUserRoutes(app, db);
  setupMexcUserApiRoutes(app, db);
  console.log('✅ MEXC User Auth & API routes initialized');

  // Initialize and start MEXC User Bot Monitor
  mexcUserBotMonitor = new MexcUserBotMonitor(db);
  setUserBotMonitor(mexcUserBotMonitor);
  try {
    await mexcUserBotMonitor.start();
    console.log('✅ MEXC User Bot Monitor started');
  } catch (error) {
    console.error('⚠️ Error starting MEXC User Bot Monitor:', error.message);
  }

  // Initialize XT Routes (public endpoints)
  setupXtRoutes(app);
  console.log('✅ XT public routes initialized');

  // Initialize XT Server Time Sync (CRITICAL for AUTH_104 fix)
  const { syncXtServerTime } = await import('./xt-user-routes.js');
  try {
    await syncXtServerTime();
    console.log('✅ XT server time synchronized');
  } catch (error) {
    console.error('⚠️ Failed to sync XT server time:', error.message);
  }

  // Initialize XT User Routes (for XT credential management)
  setupXtUserRoutes(app, db);
  setupXtUserApiRoutes(app, db);
  console.log('✅ XT User Auth & API routes initialized');

  // Initialize and start XT User Bot Monitor
  xtUserBotMonitor = new XtUserBotMonitor(db);
  setXtUserBotMonitor(xtUserBotMonitor);
  try {
    await xtUserBotMonitor.start();
    console.log('✅ XT User Bot Monitor started');
  } catch (error) {
    console.error('⚠️ Error starting XT User Bot Monitor:', error.message);
  }

  // Auto-start conditional bot if any user has botEnabled: true
  try {
    // Check for users with botEnabled: true
    const activeUsersCount = await db.collection('users').countDocuments({ 
      botEnabled: true,
      apiKey: { $exists: true },
      apiSecret: { $exists: true }
    });

    if (activeUsersCount > 0) {
      console.log(`🔄 Found ${activeUsersCount} user(s) with bot enabled`);
      console.log('🤖 Auto-starting conditional bot monitoring service...');
      await botMonitor.start();
      console.log('✅ Conditional bot auto-started successfully');
    } else {
      console.log('⏸️ Conditional bot not started - no users with botEnabled: true');
    }
  } catch (error) {
    console.error('⚠️ Error checking conditional bot state:', error.message);
    console.log('⏸️ Conditional bot stopped by default');
  }

  // Auto-start scheduled bot monitor if there are active scheduled bots
  try {
    const activeScheduledBots = await db.collection('scheduled_bots').countDocuments({ 
      isActive: true,
      isRunning: true
    });

    if (activeScheduledBots > 0) {
      console.log(`🔄 Found ${activeScheduledBots} active scheduled bot(s)`);
      console.log('📅 Auto-starting scheduled bot monitor...');
      await scheduledBotMonitor.start();
      console.log('✅ Scheduled bot monitor started successfully');
    } else {
      console.log('⏸️ Scheduled bot monitor not started - no active scheduled bots');
    }
  } catch (error) {
    console.error('⚠️ Error checking scheduled bot state:', error.message);
  }

  // Auto-start market maker bot monitor if there are active market maker bots
  try {
    const activeMarketMakerBots = await db.collection('market_maker_bots').countDocuments({ 
      isActive: true,
      isRunning: true
    });

    if (activeMarketMakerBots > 0) {
      console.log(`🔄 Found ${activeMarketMakerBots} active market maker bot(s)`);
      console.log('📊 Auto-starting market maker bot monitor...');
      await marketMakerBotMonitor.start();
      console.log('✅ Market maker bot monitor started successfully');
    } else {
      console.log('⏸️ Market maker bot monitor not started - no active market maker bots');
    }
  } catch (error) {
    console.error('⚠️ Error checking market maker bot state:', error.message);
  }

  // Auto-start stabilizer bot monitor if there are active stabilizer bots with enabled users
  try {
    const activeStabilizerBots = await db.collection('stabilizer_bots').find({ 
      isActive: true,
      isRunning: true
    }).toArray();

    if (activeStabilizerBots.length > 0) {
      // Get unique user IDs
      const userIds = [...new Set(activeStabilizerBots.map(bot => bot.userId))];
      
      // Check how many of these users have botEnabled: true
      const enabledUsersCount = await db.collection('users').countDocuments({
        uid: { $in: userIds },
        botEnabled: true,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      });

      if (enabledUsersCount > 0) {
        console.log(`🔄 Found ${activeStabilizerBots.length} active stabilizer bot(s) for ${enabledUsersCount} enabled user(s)`);
        console.log('🎯 Auto-starting stabilizer bot monitor...');
        await stabilizerBotMonitor.start();
        console.log('✅ Stabilizer bot monitor started successfully');
      } else {
        console.log('⏸️ Stabilizer bot monitor not started - no users with botEnabled: true');
      }
    } else {
      console.log('⏸️ Stabilizer bot monitor not started - no active stabilizer bots');
    }
  } catch (error) {
    console.error('⚠️ Error checking stabilizer bot state:', error.message);
  }

  // Auto-start buy wall bot monitor if there are active buy wall bots with enabled users
  try {
    const activeBuyWallBots = await db.collection('buywall_bots').find({ 
      isActive: true,
      isRunning: true
    }).toArray();

    if (activeBuyWallBots.length > 0) {
      const userIds = [...new Set(activeBuyWallBots.map(bot => bot.userId))];
      
      const enabledUsersCount = await db.collection('users').countDocuments({
        uid: { $in: userIds },
        botEnabled: true,
        apiKey: { $exists: true },
        apiSecret: { $exists: true }
      });

      if (enabledUsersCount > 0) {
        console.log(`🔄 Found ${activeBuyWallBots.length} active buy wall bot(s) for ${enabledUsersCount} enabled user(s)`);
        console.log('🧱 Auto-starting buy wall bot monitor...');
        await buyWallBotMonitor.start();
        console.log('✅ Buy wall bot monitor started successfully');
      } else {
        console.log('⏸️ Buy wall bot monitor not started - no users with botEnabled: true');
      }
    } else {
      console.log('⏸️ Buy wall bot monitor not started - no active buy wall bots');
    }
  } catch (error) {
    console.error('⚠️ Error checking buy wall bot state:', error.message);
  }

  app.listen(PORT, () => {
    console.log(`🚀 MMBot Server running on http://localhost:${PORT}`);
    console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
    console.log(`\n🔐 Auth endpoints:`);
    console.log(`   GET  /api/auth/qrcode        - Generate QR code`);
    console.log(`   POST /api/auth/qrcode/status - Check QR scan status`);
    console.log(`\n🧪 Test endpoints (Open API with API Key/Secret):`);
    console.log(`   GET  /api/test/openapi/balance - Test API credentials`);
    console.log(`   GET  /api/test/openapi/ticker  - Get ticker (no auth)`);
    console.log(`\n📱 Telegram endpoints:`);
    console.log(`   GET  /api/telegram/test        - Send test notification`);
    console.log(`   GET  /api/telegram/status      - Check Telegram configuration`);
    console.log(`   POST /api/telegram/test-stabilizer - Test stabilizer bot with $0.50 order`);
    console.log(`\n� Trade endpoints:`);
    console.log(`   POST /api/trade/order   - Place a trade order`);
    console.log(`   POST /api/trade/cancel  - Cancel an order`);
    console.log(`   GET  /api/trade/orders  - Get open orders`);
    console.log(`\n�📈 Market Data endpoints:`);
    console.log(`   POST /api/market/rates          - Get exchange rates`);
    console.log(`   POST /api/market/public-info    - Get contract/market info`);
    console.log(`   POST /api/market/ticker         - Get market ticker`);
    console.log(`   POST /api/market/otc-public-info - Get OTC info`);
    console.log(`\n👤 User endpoints:`);
    console.log(`   GET  /api/users/me      - Get current user`);
    console.log(`   POST /api/users/info    - Get detailed user info`);
    console.log(`   POST /api/users/balance - Get account balance`);
    console.log(`\n🔑 API Credentials endpoints:`);
    console.log(`   GET    /api/users/api-credentials - Check API credentials`);
    console.log(`   POST   /api/users/api-credentials - Save API credentials`);
    console.log(`   DELETE /api/users/api-credentials - Remove API credentials`);
    console.log(`\n💱 Trading with API Credentials:`);
    console.log(`   POST /api/trade/place-order - Place order using stored credentials`);
    console.log(`\n🤖 Bot endpoints:`);
    console.log(`   GET    /api/bot/conditions     - Get all bot conditions`);
    console.log(`   POST   /api/bot/conditions     - Create bot condition`);
    console.log(`   PUT    /api/bot/conditions/:id - Update bot condition`);
    console.log(`   DELETE /api/bot/conditions/:id - Delete bot condition`);
    console.log(`\n🔄 Bot Control endpoints:`);
    console.log(`   POST /api/bot/start       - Start bot monitoring (admin)`);
    console.log(`   POST /api/bot/stop        - Stop bot monitoring (admin)`);
    console.log(`   GET  /api/bot/status      - Get bot status`);
    console.log(`   GET  /api/bot/logs        - Get bot activity logs`);
    console.log(`   GET  /api/bot/market-data - Get current market data`);
    console.log(`   GET  /api/bot/trades      - Get bot trade history`);
    console.log(`\n👤 User Bot Control:`);
    console.log(`   POST /api/bot/user/enable  - Enable bot for current user`);
    console.log(`   POST /api/bot/user/disable - Disable bot for current user`);
    console.log(`   POST /api/bot/user/toggle  - Toggle bot on/off`);
    console.log(`   GET  /api/bot/user/status  - Get user's bot status`);
    console.log(`\n📊 Market Maker Bot endpoints:`);
    console.log(`   POST   /api/bot/market-maker/create      - Create market maker bot`);
    console.log(`   GET    /api/bot/market-maker/list        - Get all market maker bots`);
    console.log(`   POST   /api/bot/market-maker/:id/start   - Start market maker bot`);
    console.log(`   POST   /api/bot/market-maker/:id/stop    - Stop market maker bot`);
    console.log(`   DELETE /api/bot/market-maker/:id         - Delete market maker bot`);
    console.log(`   GET    /api/bot/market-maker/logs        - Get market maker bot activity logs`);
    console.log(`   GET    /api/bot/market-maker/status      - Get market maker bot monitor status`);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (botMonitor && botMonitor.isRunning) {
    await botMonitor.stop();
    console.log('✅ Bot monitor stopped');
  }
  if (scheduledBotMonitor && scheduledBotMonitor.isRunning) {
    await scheduledBotMonitor.stop();
    console.log('✅ Scheduled bot monitor stopped');
  }
  if (marketMakerBotMonitor && marketMakerBotMonitor.isRunning) {
    await marketMakerBotMonitor.stop();
    console.log('✅ Market maker bot monitor stopped');
  }
  if (stabilizerBotMonitor && stabilizerBotMonitor.isRunning) {
    await stabilizerBotMonitor.stop();
    console.log('✅ Stabilizer bot monitor stopped');
  }
  if (buyWallBotMonitor && buyWallBotMonitor.isRunning) {
    await buyWallBotMonitor.stop();
    console.log('✅ Buy wall bot monitor stopped');
  }
  if (priceKeeperBotMonitor && priceKeeperBotMonitor.isRunning) {
    await priceKeeperBotMonitor.stop();
    console.log('✅ Price keeper bot monitor stopped');
  }
  if (xtUserBotMonitor && xtUserBotMonitor.isRunning) {
    await xtUserBotMonitor.stop();
    console.log('✅ XT User bot monitor stopped');
  }
  if (client) {
    await client.close();
  }
  process.exit(0);
});

