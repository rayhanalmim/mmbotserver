import crypto from 'crypto';
import { verifyMexcToken, getMexcUserCredentials } from './mexc-user-routes.js';

const MEXC_BASE_URL = process.env.MEXC_BASE_URL || 'https://api.mexc.com';

// Generate MEXC signature for user
function generateMexcSignature(queryString, apiSecret) {
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

// Store reference to bot monitor for logs access
let userBotMonitorRef = null;

export function setUserBotMonitor(monitor) {
  userBotMonitorRef = monitor;
}

// Setup User-specific MEXC API routes
export function setupMexcUserApiRoutes(app, db) {

  // ============================================
  // User-specific MEXC API Endpoints
  // All routes require authentication
  // ============================================

  // GET /api/mexc-user/account - Get user's MEXC account balance
  app.get('/api/mexc-user/account', verifyMexcToken, async (req, res) => {
    try {
      const credentials = await getMexcUserCredentials(db, req.mexcUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'User credentials not found', data: null });
      }

      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString, credentials.apiSecret);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': credentials.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (data.balances) {
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
      console.error('MEXC user account error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get account balance', data: null });
    }
  });

  // GET /api/mexc-user/openOrders - Get user's open orders
  app.get('/api/mexc-user/openOrders', verifyMexcToken, async (req, res) => {
    try {
      const credentials = await getMexcUserCredentials(db, req.mexcUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'User credentials not found', data: null });
      }

      const symbol = req.query.symbol || 'GCBUSDT';
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString, credentials.apiSecret);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/openOrders?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': credentials.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC user openOrders error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get open orders', data: null });
    }
  });

  // GET /api/mexc-user/allOrders - Get user's order history
  app.get('/api/mexc-user/allOrders', verifyMexcToken, async (req, res) => {
    try {
      const credentials = await getMexcUserCredentials(db, req.mexcUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'User credentials not found', data: null });
      }

      const symbol = req.query.symbol || 'GCBUSDT';
      const limit = req.query.limit || 100;
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString, credentials.apiSecret);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/allOrders?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': credentials.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC user allOrders error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get order history', data: null });
    }
  });

  // POST /api/mexc-user/order - Place order with user credentials
  app.post('/api/mexc-user/order', verifyMexcToken, async (req, res) => {
    try {
      const credentials = await getMexcUserCredentials(db, req.mexcUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'User credentials not found', data: null });
      }

      const { symbol, side, type, quantity, price, quoteOrderQty } = req.body;

      if (!symbol || !side || !type) {
        return res.status(400).json({ code: '-1', msg: 'Missing required parameters', data: null });
      }

      const timestamp = Date.now();
      let queryParams = `symbol=${symbol}&side=${side}&type=${type}&timestamp=${timestamp}`;

      if (type === 'LIMIT') {
        if (!quantity || !price) {
          return res.status(400).json({ code: '-1', msg: 'LIMIT orders require quantity and price', data: null });
        }
        queryParams += `&quantity=${quantity}&price=${price}`;
      }

      if (type === 'MARKET') {
        if (quantity) {
          queryParams += `&quantity=${quantity}`;
        } else if (quoteOrderQty) {
          queryParams += `&quoteOrderQty=${quoteOrderQty}`;
        } else {
          return res.status(400).json({ code: '-1', msg: 'MARKET orders require quantity or quoteOrderQty', data: null });
        }
      }

      const signature = generateMexcSignature(queryParams, credentials.apiSecret);

      console.log(`📤 MEXC User Order: ${side} ${type} ${symbol} - User: ${req.mexcUser.id}`);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${queryParams}&signature=${signature}`, {
        method: 'POST',
        headers: {
          'X-MEXC-APIKEY': credentials.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.orderId) {
        console.log(`✅ MEXC User Order placed: ${data.orderId}`);
        res.json({ code: '0', msg: 'Order placed successfully', data });
      } else {
        console.log(`❌ MEXC User Order failed:`, data);
        res.json({ code: '-1', msg: data.msg || 'Failed to place order', data });
      }
    } catch (error) {
      console.error('MEXC user order error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to place order', data: null });
    }
  });

  // DELETE /api/mexc-user/order - Cancel order with user credentials
  app.delete('/api/mexc-user/order', verifyMexcToken, async (req, res) => {
    try {
      const credentials = await getMexcUserCredentials(db, req.mexcUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'User credentials not found', data: null });
      }

      const { symbol, orderId } = req.body;

      if (!symbol || !orderId) {
        return res.status(400).json({ code: '-1', msg: 'Missing required parameters', data: null });
      }

      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString, credentials.apiSecret);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/order?${queryString}&signature=${signature}`, {
        method: 'DELETE',
        headers: {
          'X-MEXC-APIKEY': credentials.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.orderId || data.status === 'CANCELED') {
        res.json({ code: '0', msg: 'Order cancelled successfully', data });
      } else {
        res.json({ code: '-1', msg: data.msg || 'Failed to cancel order', data });
      }
    } catch (error) {
      console.error('MEXC user cancel order error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel order', data: null });
    }
  });

  // GET /api/mexc-user/myTrades - Get user's trade history
  app.get('/api/mexc-user/myTrades', verifyMexcToken, async (req, res) => {
    try {
      const credentials = await getMexcUserCredentials(db, req.mexcUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'User credentials not found', data: null });
      }

      const symbol = req.query.symbol || 'GCBUSDT';
      const limit = req.query.limit || 50;
      const timestamp = Date.now();
      const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}`;
      const signature = generateMexcSignature(queryString, credentials.apiSecret);

      const response = await fetch(`${MEXC_BASE_URL}/api/v3/myTrades?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: {
          'X-MEXC-APIKEY': credentials.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      res.json({ code: '0', msg: 'Success', data });
    } catch (error) {
      console.error('MEXC user myTrades error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get trade history', data: null });
    }
  });

  // ============================================
  // User-specific Bot Management Endpoints
  // ============================================

  // POST /api/mexc-user/bot/create - Create bot for user
  app.post('/api/mexc-user/bot/create', verifyMexcToken, async (req, res) => {
    try {
      const { name, symbol, orderAmount, gapThreshold, cooldownSeconds, telegramEnabled } = req.body;

      if (!name) {
        return res.status(400).json({ code: '-1', msg: 'Bot name is required', data: null });
      }

      const newBot = {
        userId: req.mexcUser.id,
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

      const result = await db.collection('mexc_user_bots').insertOne(newBot);
      
      console.log(`✅ MEXC User Bot created: ${name} for user ${req.mexcUser.id}`);
      res.json({ 
        code: '0', 
        msg: 'Bot created successfully', 
        data: { ...newBot, _id: result.insertedId } 
      });
    } catch (error) {
      console.error('Error creating user bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to create bot', data: null });
    }
  });

  // GET /api/mexc-user/bot/list - Get user's bots
  app.get('/api/mexc-user/bot/list', verifyMexcToken, async (req, res) => {
    try {
      const bots = await db.collection('mexc_user_bots')
        .find({ userId: req.mexcUser.id })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ code: '0', msg: 'Success', data: bots });
    } catch (error) {
      console.error('Error fetching user bots:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch bots', data: null });
    }
  });

  // PUT /api/mexc-user/bot/:id/start - Start user's bot
  app.put('/api/mexc-user/bot/:id/start', verifyMexcToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('mexc_user_bots').updateOne(
        { _id: new ObjectId(botId), userId: req.mexcUser.id },
        { $set: { isRunning: true, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`▶️ MEXC User Bot started: ${botId}`);
      res.json({ code: '0', msg: 'Bot started', data: null });
    } catch (error) {
      console.error('Error starting bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to start bot', data: null });
    }
  });

  // PUT /api/mexc-user/bot/:id/stop - Stop user's bot
  app.put('/api/mexc-user/bot/:id/stop', verifyMexcToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('mexc_user_bots').updateOne(
        { _id: new ObjectId(botId), userId: req.mexcUser.id },
        { $set: { isRunning: false, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`⏹️ MEXC User Bot stopped: ${botId}`);
      res.json({ code: '0', msg: 'Bot stopped', data: null });
    } catch (error) {
      console.error('Error stopping bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to stop bot', data: null });
    }
  });

  // PUT /api/mexc-user/bot/:id - Update user's bot
  app.put('/api/mexc-user/bot/:id', verifyMexcToken, async (req, res) => {
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

      const result = await db.collection('mexc_user_bots').updateOne(
        { _id: new ObjectId(botId), userId: req.mexcUser.id },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      res.json({ code: '0', msg: 'Bot updated', data: null });
    } catch (error) {
      console.error('Error updating bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to update bot', data: null });
    }
  });

  // DELETE /api/mexc-user/bot/:id - Delete user's bot
  app.delete('/api/mexc-user/bot/:id', verifyMexcToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('mexc_user_bots').deleteOne({ 
        _id: new ObjectId(botId), 
        userId: req.mexcUser.id 
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      // Also delete associated logs
      await db.collection('mexc_user_bot_logs').deleteMany({ 
        botId: botId,
        userId: req.mexcUser.id
      });

      console.log(`🗑️ MEXC User Bot deleted: ${botId}`);
      res.json({ code: '0', msg: 'Bot deleted', data: null });
    } catch (error) {
      console.error('Error deleting bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to delete bot', data: null });
    }
  });

  // GET /api/mexc-user/bot/logs - Get user's bot trade logs
  app.get('/api/mexc-user/bot/logs', verifyMexcToken, async (req, res) => {
    try {
      const botId = req.query.botId;
      const limit = parseInt(req.query.limit) || 100;
      
      const query = { userId: req.mexcUser.id };
      if (botId) query.botId = botId;

      const logs = await db.collection('mexc_user_bot_logs')
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

  // GET /api/mexc-user/bot/monitor-logs - Get real-time monitor logs
  app.get('/api/mexc-user/bot/monitor-logs', verifyMexcToken, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      
      if (userBotMonitorRef) {
        const logs = userBotMonitorRef.getLogs(limit);
        res.json({ code: '0', msg: 'Success', data: logs });
      } else {
        res.json({ code: '0', msg: 'Success', data: [] });
      }
    } catch (error) {
      console.error('Error fetching monitor logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch monitor logs', data: null });
    }
  });

  // GET /api/mexc-user/bot/status - Get bot monitor status
  app.get('/api/mexc-user/bot/status', verifyMexcToken, async (req, res) => {
    try {
      if (userBotMonitorRef) {
        const status = userBotMonitorRef.getStatus();
        res.json({ code: '0', msg: 'Success', data: status });
      } else {
        res.json({ code: '0', msg: 'Success', data: { isRunning: false, marketData: {} } });
      }
    } catch (error) {
      console.error('Error fetching bot status:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch status', data: null });
    }
  });

  console.log('✅ MEXC User API routes initialized');
}

export default setupMexcUserApiRoutes;
