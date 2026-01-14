import crypto from 'crypto';
import { verifyXtToken, getXtUserCredentials, generateXtSignature, buildSignatureMessage, getXtTimestamp, syncXtServerTime } from './xt-user-routes.js';

const XT_BASE_URL = process.env.XT_BASE_URL || 'https://sapi.xt.com';

// Store reference to bot monitor for logs access
let xtUserBotMonitorRef = null;

export function setXtUserBotMonitor(monitor) {
  xtUserBotMonitorRef = monitor;
}

// Helper to make authenticated XT API requests with retry logic
async function makeXtRequest(apiKey, apiSecret, method, path, queryParams = '', body = null, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timestamp = await getXtTimestamp();
      
      const headers = {
        'validate-algorithms': 'HmacSHA256',
        'validate-appkey': apiKey,
        'validate-recvwindow': '5000',
        'validate-timestamp': timestamp
      };

      const bodyJson = body ? JSON.stringify(body) : '';
      const original = buildSignatureMessage(method, path, queryParams, bodyJson, headers);
      const signature = generateXtSignature(apiSecret, original);

      const url = queryParams ? `${XT_BASE_URL}${path}?${queryParams}` : `${XT_BASE_URL}${path}`;

      const fetchOptions = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'validate-algorithms': 'HmacSHA256',
          'validate-appkey': apiKey,
          'validate-recvwindow': '5000',
          'validate-timestamp': timestamp,
          'validate-signature': signature
        }
      };

      if (body && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
        fetchOptions.body = bodyJson;
      }

      const response = await fetch(url, fetchOptions);
      const data = await response.json();
      
      // Retry on time-related auth errors
      if ((data.mc === 'AUTH_104' || data.mc === 'AUTH_105') && attempt < maxRetries) {
        console.log(`⏳ XT API error ${data.mc}, resyncing time and retrying (attempt ${attempt}/${maxRetries})`);
        await syncXtServerTime();
        continue;
      }
      
      return data;
    } catch (error) {
      if (attempt < maxRetries) {
        console.log(`⏳ XT API request error, retrying (attempt ${attempt}/${maxRetries}):`, error.message);
        await syncXtServerTime();
        continue;
      }
      throw error;
    }
  }
}

// Setup User-specific XT API routes
export function setupXtUserApiRoutes(app, db) {

  // ============================================
  // User-specific XT API Endpoints
  // All routes require authentication
  // ============================================

  // GET /api/xt-user/account - Get user's XT account balance
  app.get('/api/xt-user/account', verifyXtToken, async (req, res) => {
    try {
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null, needsCredentials: true });
      }

      const data = await makeXtRequest(
        credentials.apiKey,
        credentials.apiSecret,
        'GET',
        '/v4/balances',
        'currencies=usdt,gcb'
      );
      
      if (data.rc === 0 && data.result?.assets) {
        const balances = data.result.assets.map(asset => ({
          asset: asset.currency.toUpperCase(),
          free: asset.availableAmount,
          locked: asset.frozenAmount,
          total: asset.totalAmount
        }));
        
        res.json({ 
          code: '0', 
          msg: 'Success', 
          data: {
            balances: balances,
            allBalances: data.result.assets
          }
        });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get account', data });
      }
    } catch (error) {
      console.error('XT user account error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get account balance', data: null });
    }
  });

  // GET /api/xt-user/openOrders - Get user's open orders
  app.get('/api/xt-user/openOrders', verifyXtToken, async (req, res) => {
    try {
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }

      const symbol = req.query.symbol || 'gcb_usdt';
      const data = await makeXtRequest(
        credentials.apiKey,
        credentials.apiSecret,
        'GET',
        '/v4/open-order',
        `symbol=${symbol}&bizType=SPOT`
      );

      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result || [] });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get open orders', data });
      }
    } catch (error) {
      console.error('XT user openOrders error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get open orders', data: null });
    }
  });

  // GET /api/xt-user/myTrades - Get user's trade history
  app.get('/api/xt-user/myTrades', verifyXtToken, async (req, res) => {
    try {
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }

      const symbol = req.query.symbol || 'gcb_usdt';
      const limit = req.query.limit || 50;
      const data = await makeXtRequest(
        credentials.apiKey,
        credentials.apiSecret,
        'GET',
        '/v4/trade',
        `symbol=${symbol}&bizType=SPOT&limit=${limit}`
      );

      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Success', data: data.result?.items || [] });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to get trade history', data });
      }
    } catch (error) {
      console.error('XT user myTrades error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to get trade history', data: null });
    }
  });

  // POST /api/xt-user/order - Place order with user credentials
  app.post('/api/xt-user/order', verifyXtToken, async (req, res) => {
    try {
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }

      const { symbol, side, type, quantity, price, quoteQty, timeInForce } = req.body;

      if (!symbol || !side || !type) {
        return res.status(400).json({ code: '-1', msg: 'Missing required parameters', data: null });
      }

      const orderBody = {
        symbol: symbol.toLowerCase(),
        side: side.toUpperCase(),
        type: type.toUpperCase(),
        timeInForce: timeInForce || 'GTC',
        bizType: 'SPOT'
      };

      if (type.toUpperCase() === 'LIMIT') {
        if (!quantity || !price) {
          return res.status(400).json({ code: '-1', msg: 'LIMIT orders require quantity and price', data: null });
        }
        orderBody.quantity = quantity;
        orderBody.price = price;
      }

      if (type.toUpperCase() === 'MARKET') {
        if (side.toUpperCase() === 'BUY') {
          if (!quoteQty) {
            return res.status(400).json({ code: '-1', msg: 'MARKET BUY orders require quoteQty', data: null });
          }
          orderBody.quoteQty = quoteQty;
          orderBody.timeInForce = 'IOC';
        } else {
          if (!quantity) {
            return res.status(400).json({ code: '-1', msg: 'MARKET SELL orders require quantity', data: null });
          }
          orderBody.quantity = quantity;
          orderBody.timeInForce = 'IOC';
        }
      }

      console.log(`📤 XT User Order: ${side} ${type} ${symbol} - User: ${req.xtUser.id}`);

      const data = await makeXtRequest(
        credentials.apiKey,
        credentials.apiSecret,
        'POST',
        '/v4/order',
        '',
        orderBody
      );

      if (data.rc === 0 && data.result?.orderId) {
        console.log(`✅ XT User Order placed: ${data.result.orderId}`);
        res.json({ code: '0', msg: 'Order placed successfully', data: data.result });
      } else {
        console.log(`❌ XT User Order failed:`, data);
        res.json({ code: '-1', msg: data.mc || 'Failed to place order', data });
      }
    } catch (error) {
      console.error('XT user order error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to place order', data: null });
    }
  });

  // DELETE /api/xt-user/order - Cancel order with user credentials
  app.delete('/api/xt-user/order', verifyXtToken, async (req, res) => {
    try {
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }

      const { orderId } = req.body;

      if (!orderId) {
        return res.status(400).json({ code: '-1', msg: 'Missing orderId', data: null });
      }

      const data = await makeXtRequest(
        credentials.apiKey,
        credentials.apiSecret,
        'DELETE',
        `/v4/order/${orderId}`
      );

      if (data.rc === 0) {
        res.json({ code: '0', msg: 'Order cancelled successfully', data: data.result });
      } else {
        res.json({ code: '-1', msg: data.mc || 'Failed to cancel order', data });
      }
    } catch (error) {
      console.error('XT user cancel order error:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel order', data: null });
    }
  });

  // ============================================
  // User-specific Bot Management Endpoints
  // ============================================

  // POST /api/xt-user/bot/create - Create bot for user
  app.post('/api/xt-user/bot/create', verifyXtToken, async (req, res) => {
    try {
      const { name, symbol, orderAmount, gapThreshold, cooldownSeconds, telegramEnabled } = req.body;

      if (!name) {
        return res.status(400).json({ code: '-1', msg: 'Bot name is required', data: null });
      }

      const newBot = {
        mexcUserId: req.xtUser.id,
        name: name,
        symbol: symbol || 'gcb_usdt',
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

      const result = await db.collection('xt_user_bots').insertOne(newBot);
      
      console.log(`✅ XT User Bot created: ${name} for user ${req.xtUser.id}`);
      res.json({ 
        code: '0', 
        msg: 'Bot created successfully', 
        data: { ...newBot, _id: result.insertedId } 
      });
    } catch (error) {
      console.error('Error creating XT user bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to create bot', data: null });
    }
  });

  // GET /api/xt-user/bot/list - Get user's bots
  app.get('/api/xt-user/bot/list', verifyXtToken, async (req, res) => {
    try {
      const bots = await db.collection('xt_user_bots')
        .find({ mexcUserId: req.xtUser.id })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ code: '0', msg: 'Success', data: bots });
    } catch (error) {
      console.error('Error fetching XT user bots:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch bots', data: null });
    }
  });

  // PUT /api/xt-user/bot/:id/start - Start user's bot
  app.put('/api/xt-user/bot/:id/start', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('xt_user_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: { isRunning: true, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`▶️ XT User Bot started: ${botId}`);
      res.json({ code: '0', msg: 'Bot started', data: null });
    } catch (error) {
      console.error('Error starting XT bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to start bot', data: null });
    }
  });

  // PUT /api/xt-user/bot/:id/stop - Stop user's bot
  app.put('/api/xt-user/bot/:id/stop', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('xt_user_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: { isRunning: false, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`⏹️ XT User Bot stopped: ${botId}`);
      res.json({ code: '0', msg: 'Bot stopped', data: null });
    } catch (error) {
      console.error('Error stopping XT bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to stop bot', data: null });
    }
  });

  // PUT /api/xt-user/bot/:id - Update user's bot
  app.put('/api/xt-user/bot/:id', verifyXtToken, async (req, res) => {
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

      const result = await db.collection('xt_user_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      res.json({ code: '0', msg: 'Bot updated', data: null });
    } catch (error) {
      console.error('Error updating XT bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to update bot', data: null });
    }
  });

  // DELETE /api/xt-user/bot/:id - Delete user's bot
  app.delete('/api/xt-user/bot/:id', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      const result = await db.collection('xt_user_bots').deleteOne({ 
        _id: new ObjectId(botId), 
        mexcUserId: req.xtUser.id 
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      // Also delete associated logs
      await db.collection('xt_user_bot_logs').deleteMany({ 
        botId: botId,
        mexcUserId: req.xtUser.id
      });

      console.log(`🗑️ XT User Bot deleted: ${botId}`);
      res.json({ code: '0', msg: 'Bot deleted', data: null });
    } catch (error) {
      console.error('Error deleting XT bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to delete bot', data: null });
    }
  });

  // GET /api/xt-user/bot/logs - Get user's bot trade logs
  app.get('/api/xt-user/bot/logs', verifyXtToken, async (req, res) => {
    try {
      const botId = req.query.botId;
      const limit = parseInt(req.query.limit) || 100;
      
      const query = { mexcUserId: req.xtUser.id };
      if (botId) query.botId = botId;

      const logs = await db.collection('xt_user_bot_logs')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ code: '0', msg: 'Success', data: logs });
    } catch (error) {
      console.error('Error fetching XT bot logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
    }
  });

  // GET /api/xt-user/bot/monitor-logs - Get real-time monitor logs
  app.get('/api/xt-user/bot/monitor-logs', verifyXtToken, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      
      if (xtUserBotMonitorRef) {
        const logs = xtUserBotMonitorRef.getLogs(limit);
        res.json({ code: '0', msg: 'Success', data: logs });
      } else {
        res.json({ code: '0', msg: 'Success', data: [] });
      }
    } catch (error) {
      console.error('Error fetching XT monitor logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch monitor logs', data: null });
    }
  });

  // GET /api/xt-user/bot/status - Get bot monitor status
  app.get('/api/xt-user/bot/status', verifyXtToken, async (req, res) => {
    try {
      if (xtUserBotMonitorRef) {
        const status = xtUserBotMonitorRef.getStatus();
        res.json({ code: '0', msg: 'Success', data: status });
      } else {
        res.json({ code: '0', msg: 'Success', data: { isRunning: false, marketData: {} } });
      }
    } catch (error) {
      console.error('Error fetching XT bot status:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch status', data: null });
    }
  });

  console.log('✅ XT User API routes initialized');
}

export default setupXtUserApiRoutes;
