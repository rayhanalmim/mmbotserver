import { verifyXtToken, getXtUserCredentials } from './xt-user-routes.js';

// Store reference to liquidity bot monitor for logs access
let xtLiquidityBotMonitorRef = null;

export function setXtLiquidityBotMonitor(monitor) {
  xtLiquidityBotMonitorRef = monitor;
}

// Setup XT Liquidity Bot API routes
export function setupXtLiquidityBotRoutes(app, db) {

  // ============================================
  // XT Liquidity Bot Management Endpoints
  // All routes require authentication
  // ============================================

  // POST /api/xt-user/liquidity-bot/create - Create liquidity bot
  app.post('/api/xt-user/liquidity-bot/create', verifyXtToken, async (req, res) => {
    try {
      const {
        name,
        symbol,
        scaleFactor,        // e.g., 0.01 means 1000 USDT = 10 USDT
        minDepth2Percent,   // Min depth within ±2% of mid-price (default 500 USDT)
        minDepthTop20,      // Min cumulative depth for top 20 (default 1000 USDT)
        minOrderCount,      // Min order count each side (default 30)
        maxSpread,          // Max spread % (default 1)
        maxOrderGap,        // Max gap between orders % (default 1)
        orderSizeUsdt,      // Size of each order in USDT (default 20)
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
        botType: 'LIQUIDITY',
        
        // Liquidity config with defaults
        scaleFactor: parseFloat(scaleFactor) || 1,        // 1 = full scale, 0.01 = 1%
        minDepth2Percent: parseFloat(minDepth2Percent) || 500,
        minDepthTop20: parseFloat(minDepthTop20) || 1000,
        minOrderCount: parseInt(minOrderCount) || 30,
        maxSpread: parseFloat(maxSpread) || 1,
        maxOrderGap: parseFloat(maxOrderGap) || 1,
        orderSizeUsdt: parseFloat(orderSizeUsdt) || 20,
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

        // Last check data
        lastMidPrice: null,
        lastSpread: null,
        lastBuyDepth: null,
        lastSellDepth: null,
        lastBuyOrderCount: null,
        lastSellOrderCount: null,
        lastCheckedAt: null,
        lastMaintenanceAt: null,

        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await db.collection('xt_liquidity_bots').insertOne(newBot);
      
      console.log(`✅ XT Liquidity Bot created: ${name} for user ${req.xtUser.id}`);
      res.json({ 
        code: '0', 
        msg: 'Liquidity bot created successfully', 
        data: { ...newBot, _id: result.insertedId } 
      });
    } catch (error) {
      console.error('Error creating XT liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to create liquidity bot', data: null });
    }
  });

  // GET /api/xt-user/liquidity-bot/list - Get user's liquidity bots
  app.get('/api/xt-user/liquidity-bot/list', verifyXtToken, async (req, res) => {
    try {
      const bots = await db.collection('xt_liquidity_bots')
        .find({ mexcUserId: req.xtUser.id })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ code: '0', msg: 'Success', data: bots });
    } catch (error) {
      console.error('Error fetching XT liquidity bots:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch liquidity bots', data: null });
    }
  });

  // =============================================
  // STATIC ROUTES - Must be defined BEFORE :id routes
  // =============================================

  // GET /api/xt-user/liquidity-bot/monitor-logs - Get real-time monitor logs
  app.get('/api/xt-user/liquidity-bot/monitor-logs', verifyXtToken, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      if (xtLiquidityBotMonitorRef) {
        const logs = xtLiquidityBotMonitorRef.getLogs(limit);
        res.json({ code: '0', msg: 'Success', data: logs });
      } else {
        res.json({ code: '0', msg: 'Success', data: [] });
      }
    } catch (error) {
      console.error('Error fetching XT liquidity monitor logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch monitor logs', data: null });
    }
  });

  // GET /api/xt-user/liquidity-bot/status - Get liquidity bot monitor status
  app.get('/api/xt-user/liquidity-bot/status', verifyXtToken, async (req, res) => {
    try {
      if (xtLiquidityBotMonitorRef) {
        const status = xtLiquidityBotMonitorRef.getStatus();
        res.json({ code: '0', msg: 'Success', data: status });
      } else {
        res.json({ code: '0', msg: 'Success', data: { isRunning: false, marketData: {} } });
      }
    } catch (error) {
      console.error('Error fetching XT liquidity bot status:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch status', data: null });
    }
  });

  // GET /api/xt-user/liquidity-bot/analysis - Get current liquidity analysis for symbol
  app.get('/api/xt-user/liquidity-bot/analysis', verifyXtToken, async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      if (xtLiquidityBotMonitorRef) {
        const status = xtLiquidityBotMonitorRef.getStatus();
        const analysis = status.marketData[symbol] || null;
        res.json({ code: '0', msg: 'Success', data: analysis });
      } else {
        res.json({ code: '0', msg: 'Success', data: null });
      }
    } catch (error) {
      console.error('Error fetching liquidity analysis:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch analysis', data: null });
    }
  });

  // DELETE /api/xt-user/liquidity-bot/cancel-all-orders - Cancel ALL open orders for symbol
  app.delete('/api/xt-user/liquidity-bot/cancel-all-orders', verifyXtToken, async (req, res) => {
    try {
      const symbol = req.query.symbol || 'gcb_usdt';
      const side = req.query.side;
      const credentials = await getXtUserCredentials(db, req.xtUser.id);
      if (!credentials) {
        return res.status(401).json({ code: '-1', msg: 'XT credentials not found', data: null });
      }
      if (xtLiquidityBotMonitorRef) {
        const result = await xtLiquidityBotMonitorRef.cancelAllOpenOrders(credentials.apiKey, credentials.apiSecret, symbol, side);
        if (result.success) {
          console.log(`🗑️ Cancelled all ${side || 'ALL'} orders for ${symbol}`);
          res.json({ code: '0', msg: `Cancelled all ${side || ''} orders for ${symbol}`, data: result });
        } else {
          res.status(400).json({ code: '-1', msg: result.error || 'Failed to cancel orders', data: null });
        }
      } else {
        res.status(500).json({ code: '-1', msg: 'Liquidity bot monitor not available', data: null });
      }
    } catch (error) {
      console.error('Error cancelling all orders:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to cancel orders', data: null });
    }
  });

  // POST /api/xt-user/liquidity-bot/force-adjust - Force immediate liquidity adjustment
  app.post('/api/xt-user/liquidity-bot/force-adjust', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.body.botId;
      if (!botId) {
        return res.status(400).json({ code: '-1', msg: 'botId is required', data: null });
      }
      const bot = await db.collection('xt_liquidity_bots').findOne({
        _id: new ObjectId(botId),
        mexcUserId: req.xtUser.id
      });
      if (!bot) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }
      if (xtLiquidityBotMonitorRef) {
        await xtLiquidityBotMonitorRef.forceAdjustLiquidity(bot);
        res.json({ code: '0', msg: 'Liquidity adjustment triggered', data: null });
      } else {
        res.status(500).json({ code: '-1', msg: 'Liquidity bot monitor not available', data: null });
      }
    } catch (error) {
      console.error('Error forcing liquidity adjustment:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to adjust liquidity', data: null });
    }
  });

  // =============================================
  // DYNAMIC :id ROUTES - Must be defined AFTER static routes
  // =============================================

  // GET /api/xt-user/liquidity-bot/:id - Get single liquidity bot
  app.get('/api/xt-user/liquidity-bot/:id', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      // Validate ObjectId format
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const bot = await db.collection('xt_liquidity_bots').findOne({
        _id: new ObjectId(botId),
        mexcUserId: req.xtUser.id
      });

      if (!bot) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      res.json({ code: '0', msg: 'Success', data: bot });
    } catch (error) {
      console.error('Error fetching XT liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch liquidity bot', data: null });
    }
  });

  // PUT /api/xt-user/liquidity-bot/:id/start - Start liquidity bot
  app.put('/api/xt-user/liquidity-bot/:id/start', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const result = await db.collection('xt_liquidity_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: { isRunning: true, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`▶️ XT Liquidity Bot started: ${botId}`);
      res.json({ code: '0', msg: 'Liquidity bot started', data: null });
    } catch (error) {
      console.error('Error starting XT liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to start liquidity bot', data: null });
    }
  });

  // PUT /api/xt-user/liquidity-bot/:id/stop - Stop liquidity bot
  app.put('/api/xt-user/liquidity-bot/:id/stop', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const result = await db.collection('xt_liquidity_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: { isRunning: false, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      console.log(`⏹️ XT Liquidity Bot stopped: ${botId}`);
      res.json({ code: '0', msg: 'Liquidity bot stopped', data: null });
    } catch (error) {
      console.error('Error stopping XT liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to stop liquidity bot', data: null });
    }
  });

  // PUT /api/xt-user/liquidity-bot/:id - Update liquidity bot config
  app.put('/api/xt-user/liquidity-bot/:id', verifyXtToken, async (req, res) => {
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
        maxSpread,
        maxOrderGap,
        orderSizeUsdt,
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
      if (maxSpread !== undefined) updateFields.maxSpread = parseFloat(maxSpread);
      if (maxOrderGap !== undefined) updateFields.maxOrderGap = parseFloat(maxOrderGap);
      if (orderSizeUsdt !== undefined) updateFields.orderSizeUsdt = parseFloat(orderSizeUsdt);
      if (checkIntervalSeconds !== undefined) updateFields.checkIntervalSeconds = parseInt(checkIntervalSeconds);
      if (autoManage !== undefined) updateFields.autoManage = autoManage;
      if (telegramEnabled !== undefined) updateFields.telegramEnabled = telegramEnabled;

      const result = await db.collection('xt_liquidity_bots').updateOne(
        { _id: new ObjectId(botId), mexcUserId: req.xtUser.id },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      res.json({ code: '0', msg: 'Liquidity bot updated', data: null });
    } catch (error) {
      console.error('Error updating XT liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to update liquidity bot', data: null });
    }
  });

  // DELETE /api/xt-user/liquidity-bot/:id - Delete liquidity bot
  app.delete('/api/xt-user/liquidity-bot/:id', verifyXtToken, async (req, res) => {
    try {
      const { ObjectId } = await import('mongodb');
      const botId = req.params.id;
      
      if (!ObjectId.isValid(botId)) {
        return res.status(400).json({ code: '-1', msg: 'Invalid bot ID format', data: null });
      }
      
      const result = await db.collection('xt_liquidity_bots').deleteOne({ 
        _id: new ObjectId(botId), 
        mexcUserId: req.xtUser.id 
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ code: '-1', msg: 'Bot not found', data: null });
      }

      // Also delete associated logs
      await db.collection('xt_liquidity_bot_logs').deleteMany({ 
        botId: botId,
        mexcUserId: req.xtUser.id
      });

      console.log(`🗑️ XT Liquidity Bot deleted: ${botId}`);
      res.json({ code: '0', msg: 'Liquidity bot deleted', data: null });
    } catch (error) {
      console.error('Error deleting XT liquidity bot:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to delete liquidity bot', data: null });
    }
  });

  // GET /api/xt-user/liquidity-bot/logs - Get liquidity bot logs
  app.get('/api/xt-user/liquidity-bot/logs', verifyXtToken, async (req, res) => {
    try {
      const botId = req.query.botId;
      const limit = parseInt(req.query.limit) || 100;
      
      const query = { mexcUserId: req.xtUser.id };
      if (botId) query.botId = botId;

      const logs = await db.collection('xt_liquidity_bot_logs')
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      res.json({ code: '0', msg: 'Success', data: logs });
    } catch (error) {
      console.error('Error fetching XT liquidity bot logs:', error);
      res.status(500).json({ code: '-1', msg: 'Failed to fetch logs', data: null });
    }
  });

  console.log('✅ XT Liquidity Bot routes initialized');
}

export default setupXtLiquidityBotRoutes;
