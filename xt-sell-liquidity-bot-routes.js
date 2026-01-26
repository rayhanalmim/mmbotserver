import { verifyXtToken, getXtUserCredentials } from './xt-user-routes.js';

// Store reference to sell liquidity bot monitor for logs access
let xtSellLiquidityBotMonitorRef = null;

export function setXtSellLiquidityBotMonitor(monitor) {
  xtSellLiquidityBotMonitorRef = monitor;
}

// Setup XT Sell-Side Liquidity Bot API routes
export function setupXtSellLiquidityBotRoutes(app, db) {

  // ============================================
  // XT Sell-Side Liquidity Bot Management Endpoints
  // All routes require authentication
  // ============================================

  // POST /api/xt-user/sell-liquidity-bot/create - Create sell-side liquidity bot
  app.post('/api/xt-user/sell-liquidity-bot/create', verifyXtToken, async (req, res) => {
    try {
      const {
        name,
        symbol,
        minDepth2Percent,   // Min depth within +2% of mid-price (default 500 USDT)
        minDepthTop20,      // Min cumulative depth for top 20 (default 1000 USDT)
        minOrderCount,      // Min order count for sell side (default 30)
        maxOrderGap,        // Max gap between orders % (default 1)
        checkIntervalSeconds, // How often to check (default 30)
        autoManage,         // Auto place orders to fix liquidity (default false)
        telegramEnabled
      } = req.body;

      if (!name) {
        return res.status(400).json({ code: '-1', msg: 'Bot name is required', data: null });
      }

      // Check if credentials exist
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null, needsCredentials: true });
      }

      const newBot = {
        mexcUserId: req.xtUser.id,
        name: name,
        symbol: symbol || 'gcb_usdt',
        botType: 'SELL_LIQUIDITY',
        
        // Sell-side liquidity config with defaults
        minDepth2Percent: parseFloat(minDepth2Percent) || 500,
        minDepthTop20: parseFloat(minDepthTop20) || 1000,
        minOrderCount: parseInt(minOrderCount) || 30,
        maxOrderGap: parseFloat(maxOrderGap) || 1,
        checkIntervalSeconds: parseInt(checkIntervalSeconds) || 30,
        autoManage: autoManage || false,
        telegramEnabled: telegramEnabled || false,

        // Status
        isActive: true,
        isRunning: false,
        liquidityOk: null,

        // Stats
        totalOrdersPlaced: 0,
        totalMaintenance: 0,

        // Last check data (sell-side only)
        lastMidPrice: null,
        lastSellDepth: null,
        lastSellOrderCount: null,
        mySellOrderCount: null,
        lastCheckedAt: null,
        lastMaintenanceAt: null,

        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await db.collection('xt_sell_liquidity_bots').insertOne(newBot);
      
      console.log(`✅ XT Sell Liquidity Bot created: ${name} for user ${req.xtUser.id}`);
      res.json({ 
        code: '0', 
        msg: 'Sell liquidity bot created successfully', 
        data: { ...newBot, _id: result.insertedId } 
      });
    } catch (error) {
      console.error('Error creating XT sell liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to create sell liquidity bot', data: null });
    }
  });

  // GET /api/xt-user/sell-liquidity-bot/list - Get user's sell liquidity bots
  app.get('/api/xt-user/sell-liquidity-bot/list', verifyXtToken, async (req, res) => {
    try {
      const bots = await db.collection('xt_sell_liquidity_bots')
        .find({ mexcUserId: req.xtUser.id })
        .sort({ createdAt: -1 })
        .toArray();
      
      // Fetch fresh balance for each bot to show real-time data
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (credentials && xtSellLiquidityBotMonitorRef) {
        try {
          const freshBalance = await xtSellLiquidityBotMonitorRef.getAccountBalance(credentials.apiKey, credentials.apiSecret);
          if (freshBalance) {
            bots.forEach(bot => {
              bot.availableBalance = {
                usdt: freshBalance.usdt?.availableAmount || 0,
                gcb: freshBalance.gcb?.availableAmount || 0
              };
            });
          }
        } catch (err) {
          console.error('Error fetching fresh balance for sell bot list:', err);
        }
      }
      
      res.json({ code: '0', msg: 'Success', data: bots });
    } catch (error) {
      console.error('Error fetching XT sell liquidity bots:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch sell liquidity bots', data: null });
    }
  });

  // =============================================
  // STATIC ROUTES - Must be defined BEFORE :id routes
  // =============================================

  // GET /api/xt-user/sell-liquidity-bot/monitor-logs - Get real-time monitor logs
  app.get('/api/xt-user/sell-liquidity-bot/monitor-logs', verifyXtToken, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      if (xtSellLiquidityBotMonitorRef) {
        const logs = xtSellLiquidityBotMonitorRef.getLogs(limit);
        res.json({ code: '0', msg: 'Success', data: logs });
      } else {
        res.json({ code: '0', msg: 'Success', data: [] });
      }
    } catch (error) {
      console.error('Error fetching XT sell liquidity monitor logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch monitor logs', data: null });
    }
  });

  // GET /api/xt-user/sell-liquidity-bot/status - Get sell liquidity bot monitor status
  app.get('/api/xt-user/sell-liquidity-bot/status', verifyXtToken, async (req, res) => {
    try {
      if (xtSellLiquidityBotMonitorRef) {
        const status = xtSellLiquidityBotMonitorRef.getStatus();
        res.json({ code: '0', msg: 'Success', data: status });
      } else {
        res.json({ code: '0', msg: 'Success', data: { isRunning: false, marketData: {} } });
      }
    } catch (error) {
      console.error('Error fetching XT sell liquidity bot status:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch status', data: null });
    }
  });

  // GET /api/xt-user/sell-liquidity-bot/analysis - Get current sell liquidity analysis for symbol
  app.get('/api/xt-user/sell-liquidity-bot/analysis', verifyXtToken, async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      if (xtSellLiquidityBotMonitorRef) {
        const status = xtSellLiquidityBotMonitorRef.getStatus();
        const analysis = status.marketData[symbol] || null;
        res.json({ code: '0', msg: 'Success', data: analysis });
      } else {
        res.json({ code: '0', msg: 'Success', data: null });
      }
    } catch (error) {
      console.error('Error fetching sell liquidity analysis:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch analysis', data: null });
    }
  });

  // GET /api/xt-user/sell-liquidity-bot/open-orders - Get all SELL open orders for symbol
  app.get('/api/xt-user/sell-liquidity-bot/open-orders', verifyXtToken, async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }
      if (xtSellLiquidityBotMonitorRef) {
        const orders = await xtSellLiquidityBotMonitorRef.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
        res.json({ code: '0', msg: 'Success', data: orders });
      } else {
        res.json({ code: '0', msg: 'Success', data: [] });
      }
    } catch (error) {
      console.error('Error fetching sell open orders:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch sell open orders', data: null });
    }
  });

  // DELETE /api/xt-user/sell-liquidity-bot/cancel-order/:orderId - Cancel single order
  app.delete('/api/xt-user/sell-liquidity-bot/cancel-order/:orderId', verifyXtToken, async (req, res) => {
    try {
      const orderId = req.params.orderId;
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }
      if (xtSellLiquidityBotMonitorRef) {
        const success = await xtSellLiquidityBotMonitorRef.cancelOrder(credentials.apiKey, credentials.apiSecret, orderId);
        if (success) {
          console.log(`🗑️ Cancelled sell order: ${orderId}`);
          res.json({ code: '0', msg: 'Order cancelled', data: { orderId } });
        } else {
          res.status(400).json({ code: '-1', msg: 'Failed to cancel order', data: null });
        }
      } else {
        res.status(500).json({ code: '-1', msg: 'Sell liquidity bot monitor not available', data: null });
      }
    } catch (error) {
      console.error('Error cancelling order:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel order', data: null });
    }
  });

  // POST /api/xt-user/sell-liquidity-bot/cancel-batch - Cancel multiple orders by IDs
  app.post('/api/xt-user/sell-liquidity-bot/cancel-batch', verifyXtToken, async (req, res) => {
    try {
      const { orderIds } = req.body;
      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ code: '-1', msg: 'orderIds array is required', data: null });
      }
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }
      if (xtSellLiquidityBotMonitorRef) {
        const result = await xtSellLiquidityBotMonitorRef.cancelBatchOrders(credentials.apiKey, credentials.apiSecret, orderIds);
        if (result.success) {
          console.log(`🗑️ Batch cancelled ${orderIds.length} sell orders`);
          res.json({ code: '0', msg: `Cancelled ${orderIds.length} orders`, data: result });
        } else {
          res.status(400).json({ code: '-1', msg: result.error || 'Failed to cancel orders', data: null });
        }
      } else {
        res.status(500).json({ code: '-1', msg: 'Sell liquidity bot monitor not available', data: null });
      }
    } catch (error) {
      console.error('Error batch cancelling orders:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel orders', data: null });
    }
  });

  // DELETE /api/xt-user/sell-liquidity-bot/cancel-all-orders - Cancel ALL SELL open orders for symbol
  app.delete('/api/xt-user/sell-liquidity-bot/cancel-all-orders', verifyXtToken, async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }
      if (xtSellLiquidityBotMonitorRef) {
        const result = await xtSellLiquidityBotMonitorRef.cancelAllSellOrders(credentials.apiKey, credentials.apiSecret, symbol);
        if (result.success) {
          console.log(`🗑️ Cancelled all SELL orders for ${symbol}`);
          res.json({ code: '0', msg: `Cancelled all SELL orders for ${symbol}`, data: result });
        } else {
          res.status(400).json({ code: '-1', msg: result.error || 'Failed to cancel orders', data: null });
        }
      } else {
        res.status(500).json({ code: '-1', msg: 'Sell liquidity bot monitor not available', data: null });
      }
    } catch (error) {
      console.error('Error cancelling all sell orders:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel orders', data: null });
    }
  });

  // POST /api/xt-user/sell-liquidity-bot/force-adjust - Force immediate sell liquidity adjustment
  app.post('/api/xt-user/sell-liquidity-bot/force-adjust', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.body.botId;
      if (!botId) {
        return res.status(400).json({ code: '-1', msg: 'botId is required', data: null });
      }
      const bot = await db.collection('xt_sell_liquidity_bots').findOne({
        _id: new ObjectId(botId),
        mexcUserId: req.xtUser.id
      });
      if (!bot) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }
      if (xtSellLiquidityBotMonitorRef) {
        await xtSellLiquidityBotMonitorRef.forceAdjustLiquidity(bot);
        res.json({ code: '0', msg: 'Sell liquidity adjustment triggered', data: null });
      } else {
        res.status(500).json({ code: '-1', msg: 'Sell liquidity bot monitor not available', data: null });
      }
    } catch (error) {
      console.error('Error forcing sell liquidity adjustment:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to adjust sell liquidity', data: null });
    }
  });

  // =============================================
  // DYNAMIC :id ROUTES - Must be defined AFTER static routes
  // =============================================

  // GET /api/xt-user/sell-liquidity-bot/:id - Get single sell liquidity bot
  app.get('/api/xt-user/sell-liquidity-bot/:id', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const bot = await db.collection('xt_sell_liquidity_bots').findOne({
        _id: new ObjectId(botId),
        mexcUserId: req.xtUser.id
      });

      if (!bot) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      res.json({ code: '0', msg: 'Success', data: bot });
    } catch (error) {
      console.error('Error fetching XT sell liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch sell liquidity bot', data: null });
    }
  });

  // PUT /api/xt-user/sell-liquidity-bot/:id/start - Start sell liquidity bot
  app.put('/api/xt-user/sell-liquidity-bot/:id/start', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const result = await db.collection('xt_sell_liquidity_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: { isRunning: true, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`▶️ XT Sell Liquidity Bot started: ${botId}`);
      res.json({ code: '0', msg: 'Sell liquidity bot started', data: null });
    } catch (error) {
      console.error('Error starting XT sell liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to start sell liquidity bot', data: null });
    }
  });

  // PUT /api/xt-user/sell-liquidity-bot/:id/stop - Stop sell liquidity bot
  app.put('/api/xt-user/sell-liquidity-bot/:id/stop', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const result = await db.collection('xt_sell_liquidity_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { 
          $set: { 
            isRunning: false, 
            updatedAt: new Date(),
            // Reset metrics when bot stops
            lastMidPrice: 0,
            lastSellDepth: 0,
            lastSellOrderCount: 0,
            liquidityOk: false,
            budgetRequired: { sell: 0, total: 0 },
            mySellOrderCount: 0
          } 
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`⏹️ XT Sell Liquidity Bot stopped: ${botId}`);
      res.json({ code: '0', msg: 'Sell liquidity bot stopped', data: null });
    } catch (error) {
      console.error('Error stopping XT sell liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to stop sell liquidity bot', data: null });
    }
  });

  // PUT /api/xt-user/sell-liquidity-bot/:id - Update sell liquidity bot config
  app.put('/api/xt-user/sell-liquidity-bot/:id', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const {
        name,
        symbol,
        scaleFactor,
        minDepth2Percent,
        minDepthTop20,
        minOrderCount,
        maxOrderGap,
        checkIntervalSeconds,
        autoManage,
        telegramEnabled
      } = req.body;

      const updateFields = { updatedAt: new Date() };
      
      if (name !== undefined) updateFields.name = name;
      if (symbol !== undefined) updateFields.symbol = symbol;
      if (scaleFactor !== undefined) updateFields.scaleFactor = parseFloat(scaleFactor);
      if (minDepth2Percent !== undefined) updateFields.minDepth2Percent = parseFloat(minDepth2Percent);
      if (minDepthTop20 !== undefined) updateFields.minDepthTop20 = parseFloat(minDepthTop20);
      if (minOrderCount !== undefined) updateFields.minOrderCount = parseInt(minOrderCount);
      if (maxOrderGap !== undefined) updateFields.maxOrderGap = parseFloat(maxOrderGap);
      if (checkIntervalSeconds !== undefined) updateFields.checkIntervalSeconds = parseInt(checkIntervalSeconds);
      if (autoManage !== undefined) updateFields.autoManage = autoManage;
      if (telegramEnabled !== undefined) updateFields.telegramEnabled = telegramEnabled;

      const result = await db.collection('xt_sell_liquidity_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      res.json({ code: '0', msg: 'Sell liquidity bot updated', data: null });
    } catch (error) {
      console.error('Error updating XT sell liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to update sell liquidity bot', data: null });
    }
  });

  // DELETE /api/xt-user/sell-liquidity-bot/:id - Delete sell liquidity bot
  app.delete('/api/xt-user/sell-liquidity-bot/:id', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const result = await db.collection('xt_sell_liquidity_bots').deleteOne({ 
        _id: new ObjectId(botId), 
        mexcUserId: req.xtUser.id 
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      // Also delete associated logs
      await db.collection('xt_sell_liquidity_bot_logs').deleteMany({ 
        botId: botId,
        mexcUserId: req.xtUser.id
      });

      console.log(`🗑️ XT Sell Liquidity Bot deleted: ${botId}`);
      res.json({ code: '0', msg: 'Sell liquidity bot deleted', data: null });
    } catch (error) {
      console.error('Error deleting XT sell liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to delete sell liquidity bot', data: null });
    }
  });

  // GET /api/xt-user/sell-liquidity-bot/logs - Get sell liquidity bot logs
  app.get('/api/xt-user/sell-liquidity-bot/logs', verifyXtToken, async (req, res) => {
    try {
      const botId = req.query.botId;
      const limit = parseInt(req.query.limit) || 100;
      
      const query = { mexcUserId: req.xtUser.id };
      if (botId) query.botId = botId;

      const logs = await db.collection('xt_sell_liquidity_bot_logs')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ code: '0', msg: 'Success', data: logs });
    } catch (error) {
      console.error('Error fetching XT sell liquidity bot logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
    }
  });

  console.log('✅ XT Sell Liquidity Bot routes initialized');
}

export default setupXtSellLiquidityBotRoutes;
