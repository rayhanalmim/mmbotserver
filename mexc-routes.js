import crypto from 'crypto';
import 'dotenv/config';

const MEXC_BASE_URL = process.env.MEXC_BASE_URL || 'https://api.mexc.com';
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;

// Generate MEXC signature
function generateMexcSignature(queryString) {
  return crypto
    .createHmac('sha256', MEXC_API_SECRET)
    .update(queryString)
    .digest('hex');
}

// Setup MEXC routes
export function setupMexcRoutes(app) {
  
  // ============================================
  // MEXC Exchange Endpoints
  // ============================================

  // GET /api/mexc/ping - Test MEXC connectivity
  app.get('/api/mexc/ping', async (req, res) => {
    try {
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/ping`);
      const data = await response.json();
      res.json({ code: '0', msg: 'MEXC connection successful', data });
    } catch (error) {
      console.error('MEXC ping error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to connect to MEXC', data: null });
    }
  });

  // GET /api/mexc/time - Get MEXC server time
  app.get('/api/mexc/time', async (req, res) => {
    try {
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/time`);
      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC time error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get MEXC server time', data: null });
    }
  });

  // GET /api/mexc/ticker - Get ticker price for GCBUSDT
  app.get('/api/mexc/ticker', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'GCBUSDT';
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/ticker/price?symbol=${symbol}`);
      const data = await response.json();
      
      if (data.price) {
        res.json({ code: '0', msg: 'Success', data });
      } else {
        res.json({ code: '-1', msg: data.msg || 'Failed to get ticker', data });
      }
    } catch (error) {
      console.error('MEXC ticker error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get ticker', data: null });
    }
  });

  // GET /api/mexc/ticker/24hr - Get 24hr ticker stats
  app.get('/api/mexc/ticker/24hr', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'GCBUSDT';
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/ticker/24hr?symbol=${symbol}`);
      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC 24hr ticker error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get 24hr ticker', data: null });
    }
  });

  // GET /api/mexc/depth - Get order book
  app.get('/api/mexc/depth', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'GCBUSDT';
      const limit = req.query.limit || 20;
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/depth?symbol=${symbol}&limit=${limit}`);
      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC depth error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get order book', data: null });
    }
  });

  // GET /api/mexc/trades - Get recent trades
  app.get('/api/mexc/trades', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'GCBUSDT';
      const limit = req.query.limit || 50;
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/trades?symbol=${symbol}&limit=${limit}`);
      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC trades error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get trades', data: null });
    }
  });

  // GET /api/mexc/account - Get account balance
  app.get('/api/mexc/account', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (data.balances) {
        // Filter to show only GCB and USDT balances
        const filteredBalances = data.balances.filter(
          b => b.asset === 'GCB' || b.asset === 'USDT'
        );
        
        res.json({ 
          code: '0', 
          msg: 'Success', 
          data: {
            ...data,
            balances: filteredBalances,
            allBalances: data.balances
          }
        });
      } else {
        res.json({ code: '-1', msg: data.msg || 'Failed to get account', data });
      }
    } catch (error) {
      console.error('MEXC account error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get account balance', data: null });
    }
  });

  // GET /api/mexc/openOrders - Get open orders
  app.get('/api/mexc/openOrders', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const symbol = req.query.symbol || 'GCBUSDT';
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/openOrders?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC openOrders error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get open orders', data: null });
    }
  });

  // GET /api/mexc/allOrders - Get all orders history
  app.get('/api/mexc/allOrders', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const symbol = req.query.symbol || 'GCBUSDT';
      const limit = req.query.limit || 100;
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/allOrders?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC allOrders error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get order history', data: null });
    }
  });

  // POST /api/mexc/order - Place a new order (LIMIT or MARKET)
  app.post('/api/mexc/order', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const { symbol, side, type, quantity, price, quoteOrderQty } = req.body;

      if (!symbol || !side || !type) {
        return res.status(400).json({ code: '-1', msg: 'Missing required parameters: symbol, side, type', data: null });
      }

      const timestamp = Date.now();
      let queryParams = `symbol=${symbol}&side=${side}&type=${type}&timestamp=${timestamp}`;

      // For LIMIT orders, quantity and price are required
      if (type === 'LIMIT') {
        if (!quantity || !price) {
          return res.status(400).json({ code: '-1', msg: 'LIMIT orders require quantity and price', data: null });
        }
        queryParams += `&quantity=${quantity}&price=${price}`;
      }

      // For MARKET orders, either quantity or quoteOrderQty is required
      if (type === 'MARKET') {
        if (quantity) {
          queryParams += `&quantity=${quantity}`;
        } else if (quoteOrderQty) {
          queryParams += `&quoteOrderQty=${quoteOrderQty}`;
        } else {
          return res.status(400).json({ code: '-1', msg: 'MARKET orders require quantity or quoteOrderQty', data: null });
        }
      }

      const signature = generateMexcSignature(queryParams);

      console.log(`📤 MEXC Order: ${side} ${type} ${symbol} - qty: ${quantity || quoteOrderQty}, price: ${price || 'MARKET'}`);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${queryParams}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.orderId) {
        console.log(`✅ MEXC Order placed: ${data.orderId}`);
        res.json({ code: '0', msg: 'Order placed successfully', data });
      } else {
        console.log(`❌ MEXC Order failed:`, data);
        res.json({ code: '-1', msg: data.msg || 'Failed to place order', data });
      }
    } catch (error) {
      console.error('MEXC order error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to place order', data: null });
    }
  });

  // DELETE /api/mexc/order - Cancel an order
  app.delete('/api/mexc/order', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const { symbol, orderId } = req.body;

      if (!symbol || !orderId) {
        return res.status(400).json({ code: '-1', msg: 'Missing required parameters: symbol, orderId', data: null });
      }

      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString);

      console.log(`🚫 MEXC Cancel Order: ${orderId}`);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${queryString}&signature=${signature}`, {
        method: 'DELETE',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.orderId || data.status === 'CANCELED') {
        console.log(`✅ MEXC Order cancelled: ${orderId}`);
        res.json({ code: '0', msg: 'Order cancelled successfully', data });
      } else {
        console.log(`❌ MEXC Cancel failed:`, data);
        res.json({ code: '-1', msg: data.msg || 'Failed to cancel order', data });
      }
    } catch (error) {
      console.error('MEXC cancel order error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel order', data: null });
    }
  });

  // DELETE /api/mexc/openOrders - Cancel all open orders for a symbol
  app.delete('/api/mexc/openOrders', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const { symbol } = req.body;

      if (!symbol) {
        return res.status(400).json({ code: '-1', msg: 'Missing required parameter: symbol', data: null });
      }

      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString);

      console.log(`🚫 MEXC Cancel All Orders: ${symbol}`);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/openOrders?${queryString}&signature=${signature}`, {
        method: 'DELETE',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      console.log(`✅ MEXC All orders cancelled for ${symbol}`);
      res.json({ code: '0', msg: 'All orders cancelled', data });
    } catch (error) {
      console.error('MEXC cancel all orders error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel all orders', data: null });
    }
  });

  // GET /api/mexc/myTrades - Get trade history
  app.get('/api/mexc/myTrades', async (req, res) => {
    try {
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return res.status(400).json({ code: '-1', msg: 'MEXC API credentials not configured', data: null });
      }

      const symbol = req.query.symbol || 'GCBUSDT';
      const limit = req.query.limit || 50;
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/myTrades?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': MEXC_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC myTrades error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get trade history', data: null });
    }
  });

  // GET /api/mexc/exchangeInfo - Get exchange info for symbol
  app.get('/api/mexc/exchangeInfo', async (req, res) => {
    try {
      const symbol = req.query.symbol || 'GCBUSDT';
      const response = await fetch(`${MEXC_BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC exchangeInfo error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get exchange info', data: null });
    }
  });

  console.log('✅ MEXC routes initialized');
}

// Setup MEXC MM Bot routes (requires db instance)
export function setupMexcMMBotRoutes(app, db, mexcMMBotMonitor) {
  
  // ============================================
  // MEXC MM Bot Endpoints
  // ============================================

  // POST /api/mexc/bot/create - Create a new MEXC MM Bot
  app.post('/api/mexc/bot/create', async (req, res) => {
    try {
      const { name, symbol, orderAmount, gapThreshold, cooldownSeconds, telegramEnabled } = req.body;

      if (!name) {
        return res.status(400).json({ code: '-1', msg: 'Bot name is required', data: null });
      }

      const newBot = {
        name: name,
        symbol: symbol || 'GCBUSDT',
        orderAmount: parseFloat(orderAmount) || 1,
        gapThreshold: parseFloat(gapThreshold) || 3,
        cooldownSeconds: parseInt(cooldownSeconds) || 10,
        telegramEnabled: telegramEnabled || false,
        isActive: true,
        isRunning: false,
        executionCount: 0,
        totalUsdtSpent: 0,
        lastMarketPrice: null,
        lastBestAskPrice: null,
        lastPriceGap: null,
        lastCheckedAt: null,
        lastExecutedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await db.collection('mexc_mm_bots').insertOne(newBot);
      
      console.log(`✅ MEXC MM Bot created: ${name}`);
      res.json({ 
        code: '0', 
        msg: 'MEXC MM Bot created successfully', 
        data: { ...newBot, _id: result.insertedId } 
      });
    } catch (error) {
      console.error('Error creating MEXC MM Bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to create bot', data: null });
    }
  });

  // GET /api/mexc/bot/list - Get all MEXC MM Bots
  app.get('/api/mexc/bot/list', async (req, res) => {
    try {
      const bots = await db.collection('mexc_mm_bots').find({}).sort({ createdAt: -1 }).toArray();
      res.json({ code: '0', msg: 'Success', data: bots });
    } catch (error) {
      console.error('Error fetching MEXC MM Bots:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch bots', data: null });
    }
  });

  // PUT /api/mexc/bot/:id/start - Start a bot
  app.put('/api/mexc/bot/:id/start', async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('mexc_mm_bots').updateOne(
        { _id: new ObjectId(botId) },
        { $set: { isRunning: true, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`▶️ MEXC MM Bot started: ${botId}`);
      res.json({ code: '0', msg: 'Bot started', data: null });
    } catch (error) {
      console.error('Error starting bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to start bot', data: null });
    }
  });

  // PUT /api/mexc/bot/:id/stop - Stop a bot
  app.put('/api/mexc/bot/:id/stop', async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('mexc_mm_bots').updateOne(
        { _id: new ObjectId(botId) },
        { $set: { isRunning: false, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`⏹️ MEXC MM Bot stopped: ${botId}`);
      res.json({ code: '0', msg: 'Bot stopped', data: null });
    } catch (error) {
      console.error('Error stopping bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to stop bot', data: null });
    }
  });

  // PUT /api/mexc/bot/:id - Update a bot
  app.put('/api/mexc/bot/:id', async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      const { name, symbol, orderAmount, gapThreshold, cooldownSeconds, telegramEnabled } = req.body;

      const updateFields = { updatedAt: new Date() };
      if (name !== undefined) updateFields.name = name;
      if (symbol !== undefined) updateFields.symbol = symbol;
      if (orderAmount !== undefined) updateFields.orderAmount = parseFloat(orderAmount);
      if (gapThreshold !== undefined) updateFields.gapThreshold = parseFloat(gapThreshold);
      if (cooldownSeconds !== undefined) updateFields.cooldownSeconds = parseInt(cooldownSeconds);
      if (telegramEnabled !== undefined) updateFields.telegramEnabled = telegramEnabled;

      const result = await db.collection('mexc_mm_bots').updateOne(
        { _id: new ObjectId(botId) },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`📝 MEXC MM Bot updated: ${botId}`);
      res.json({ code: '0', msg: 'Bot updated', data: null });
    } catch (error) {
      console.error('Error updating bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to update bot', data: null });
    }
  });

  // DELETE /api/mexc/bot/:id - Delete a bot
  app.delete('/api/mexc/bot/:id', async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('mexc_mm_bots').deleteOne({ _id: new ObjectId(botId) });

      if (result.deletedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      // Also delete associated logs
      await db.collection('mexc_mm_bot_logs').deleteMany({ botId: botId });

      console.log(`🗑️ MEXC MM Bot deleted: ${botId}`);
      res.json({ code: '0', msg: 'Bot deleted', data: null });
    } catch (error) {
      console.error('Error deleting bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to delete bot', data: null });
    }
  });

  // GET /api/mexc/bot/logs - Get bot logs
  app.get('/api/mexc/bot/logs', async (req, res) => {
    try {
      const botId = req.query.botId;
      const limit = parseInt(req.query.limit) || 100;
      
      const query = botId ? { botId: botId } : {};
      const logs = await db.collection('mexc_mm_bot_logs')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ code: '0', msg: 'Success', data: logs });
    } catch (error) {
      console.error('Error fetching bot logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
    }
  });

  // GET /api/mexc/bot/monitor/status - Get monitor status
  app.get('/api/mexc/bot/monitor/status', async (req, res) => {
    try {
      const status = mexcMMBotMonitor.getStatus();
      res.json({ code: '0', msg: 'Success', data: status });
    } catch (error) {
      console.error('Error getting monitor status:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get status', data: null });
    }
  });

  // GET /api/mexc/bot/monitor/logs - Get in-memory monitor logs
  app.get('/api/mexc/bot/monitor/logs', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const logs = mexcMMBotMonitor.getLogs(limit);
      res.json({ code: '0', msg: 'Success', data: logs });
    } catch (error) {
      console.error('Error getting monitor logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get logs', data: null });
    }
  });

  console.log('✅ MEXC MM Bot routes initialized');
}

export default setupMexcRoutes;
