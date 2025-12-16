import crypto from 'crypto';

class BotMonitor {
  constructor(db, config = {}) {
    this.db = db;
    this.isRunning = false;
    this.marketData = {};
    this.userBalances = {};
    this.config = {
      marketPollInterval: config.marketPollInterval || 100000, // 100 seconds
      balancePollInterval: config.balancePollInterval || 30000, // 30 seconds
      conditionCooldown: config.conditionCooldown || 60000, // 1 minute between same condition triggers
      maxRetries: config.maxRetries || 3,
      ...config
    };
    this.openApiBase = config.openApiBase || 'https://openapi.gcbex.com';
    this.logs = [];
    this.maxLogs = 1000;
    this.lastTriggers = new Map(); // Track last trigger time for each condition
    this.marketPollTimer = null;
    this.conditionCheckTimer = null;
  }

  log(level, message, data = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };
    this.logs.unshift(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }
    
    const emoji = {
      info: 'ℹ️',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      trade: '💱'
    };
    console.log(`${emoji[level] || '📝'} [BOT] ${message}`, data ? data : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'Bot is already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'Bot monitoring service started');

    // Start market data polling
    this.pollMarketData();
    this.marketPollTimer = setInterval(() => this.pollMarketData(), this.config.marketPollInterval);

    // Start condition checking
    this.checkConditions();
    this.conditionCheckTimer = setInterval(() => this.checkConditions(), this.config.marketPollInterval);
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'Bot is not running');
      return;
    }

    this.isRunning = false;
    if (this.marketPollTimer) clearInterval(this.marketPollTimer);
    if (this.conditionCheckTimer) clearInterval(this.conditionCheckTimer);
    this.log('info', 'Bot monitoring service stopped');
  }

  async pollMarketData() {
    try {
      const symbols = ['gcbusdt']; // Add more symbols as needed
      
      for (const symbol of symbols) {
        const url = `${this.openApiBase}/sapi/v2/ticker?symbol=${symbol}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.last) {
          this.marketData[symbol.toUpperCase()] = {
            symbol: symbol.toUpperCase(),
            price: parseFloat(data.last),
            high24h: parseFloat(data.high || 0),
            low24h: parseFloat(data.low || 0),
            volume24h: parseFloat(data.vol || 0),
            change24h: parseFloat(data.rose || 0),
            timestamp: new Date()
          };
          this.log('info', `📊 Market data updated: ${symbol.toUpperCase()} = $${data.last}`);
        } else {
          this.log('warning', `No price data received for ${symbol}`, data);
        }
      }
    } catch (error) {
      this.log('error', 'Error polling market data', error.message);
    }
  }

  async fetchUserBalance(user) {
    try {
      if (!user || !user.apiKey || !user.apiSecret) {
        this.log('error', 'User API credentials missing');
        return null;
      }

      // Use server time for accurate timestamp
      const timestamp = (await this.getServerTime()).toString();
      const method = 'GET';
      const requestPath = '/sapi/v1/account';
      const message = `${timestamp}${method.toUpperCase()}${requestPath}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      this.log('info', `Fetching balance for user ${user.uid} with timestamp: ${timestamp}`);

      const response = await fetch(`${this.openApiBase}${requestPath}`, {
        method: 'GET',
        headers: {
          'X-CH-APIKEY': user.apiKey,
          'X-CH-TS': timestamp,
          'X-CH-SIGN': signature,
        },
      });

      const data = await response.json();

      if (data.balances) {
        this.log('info', `✅ Balance fetched successfully for user ${user.uid}: ${data.balances.length} assets`);
        return data.balances;
      }

      this.log('error', `Balance fetch failed for user ${user.uid}`, JSON.stringify(data));
      return null;
    } catch (error) {
      this.log('error', `Error fetching balance for user ${user.uid}`, error.message);
      return null;
    }
  }

  async checkConditions() {
    if (!this.isRunning) return;

    try {
      // Fetch all active bot conditions
      const conditions = await this.db.collection('bot_conditions').find({ isActive: true }).toArray();

      this.log('info', `🔍 Checking conditions: ${conditions.length} active condition(s) found`);
      
      // Log condition details for debugging
      if (conditions.length > 0) {
        conditions.forEach(c => {
          this.log('info', `  ✓ Active: "${c.name}" (ID: ${c._id.toString()}, isActive: ${c.isActive})`);
        });
      }

      if (conditions.length === 0) {
        this.log('info', 'No active conditions found. Bot is running in idle mode.');
        return;
      }

      // Get unique user IDs
      const userIds = [...new Set(conditions.map(c => c.userId))];

      // Fetch users with API credentials AND botEnabled: true
      const users = await this.db.collection('users').find({
        uid: { $in: userIds },
        apiKey: { $exists: true },
        apiSecret: { $exists: true },
        botEnabled: true
      }).toArray();

      this.log('info', `👥 Found ${users.length} user(s) with bot enabled and API credentials out of ${userIds.length} user(s)`);

      const userMap = {};
      users.forEach(u => userMap[u.uid] = u);

      // Evaluate each condition
      for (const condition of conditions) {
        const user = userMap[condition.userId];
        if (!user) {
          this.log('warning', `Skipping condition "${condition.name}" - User ${condition.userId} has no API credentials`);
          continue; // Skip if user not found or no API credentials
        }

        // Check cooldown
        const lastTrigger = this.lastTriggers.get(condition._id.toString());
        if (lastTrigger && (Date.now() - lastTrigger) < this.config.conditionCooldown) {
          const remainingCooldown = Math.ceil((this.config.conditionCooldown - (Date.now() - lastTrigger)) / 1000);
          this.log('info', `⏳ Condition "${condition.name}" in cooldown (${remainingCooldown}s remaining)`);
          continue; // Still in cooldown period
        }

        this.log('info', `🎯 Evaluating condition: "${condition.name}" (${condition.conditionField} ${condition.conditionOperator} ${condition.conditionValue})`);

        // Evaluate condition
        const shouldTrigger = await this.evaluateCondition(condition, user);
        
        if (shouldTrigger) {
          await this.executeAction(condition, user);
        }
      }
    } catch (error) {
      this.log('error', 'Error checking conditions', error.message);
    }
  }

  async evaluateCondition(condition, user) {
    try {
      const { conditionField, conditionOperator, conditionValue } = condition;
      let currentValue = null;

      // Get current value based on condition field
      if (conditionField === 'GCB_PRICE') {
        const marketData = this.marketData['GCBUSDT'];
        if (!marketData) return false;
        currentValue = marketData.price;
        
        this.log('info', `Evaluating GCB_PRICE: current=${currentValue}, target=${conditionValue}, operator=${conditionOperator}`);
      } 
      // DISABLED: Balance-based conditions (GCB_QUANTITY, USDT_QUANTITY)
      // Uncomment below when ready to enable balance monitoring
      /*
      else if (conditionField === 'GCB_QUANTITY') {
        // Fetch user balance if not cached
        if (!this.userBalances[user.uid] || (Date.now() - this.userBalances[user.uid].timestamp) > this.config.balancePollInterval) {
          const balance = await this.fetchUserBalance(user);
          if (balance) {
            this.userBalances[user.uid] = {
              balances: balance,
              timestamp: Date.now()
            };
          }
        }
        
        const userBalance = this.userBalances[user.uid];
        if (!userBalance || !userBalance.balances.GCB) return false;
        currentValue = userBalance.balances.GCB.available;
      }
      else if (conditionField === 'USDT_QUANTITY') {
        // Fetch user balance if not cached
        if (!this.userBalances[user.uid] || (Date.now() - this.userBalances[user.uid].timestamp) > this.config.balancePollInterval) {
          const balance = await this.fetchUserBalance(user);
          if (balance) {
            this.userBalances[user.uid] = {
              balances: balance,
              timestamp: Date.now()
            };
          }
        }
        
        const userBalance = this.userBalances[user.uid];
        if (!userBalance || !userBalance.balances.USDT) return false;
        currentValue = userBalance.balances.USDT.available;
      }
      */
      else {
        this.log('warning', `Unsupported condition field: ${conditionField} (only GCB_PRICE is enabled)`);
        return false;
      }

      if (currentValue === null) return false;

      // Evaluate operator
      let conditionMet = false;
      switch (conditionOperator) {
        case 'ABOVE':
          conditionMet = currentValue > conditionValue;
          break;
        case 'BELOW':
          conditionMet = currentValue < conditionValue;
          break;
        case 'EQUAL':
          // More lenient float comparison for EQUAL - within 0.1% tolerance
          const tolerance = conditionValue * 0.001;
          conditionMet = Math.abs(currentValue - conditionValue) <= tolerance;
          this.log('info', `EQUAL check: diff=${Math.abs(currentValue - conditionValue)}, tolerance=${tolerance}, met=${conditionMet}`);
          break;
        case 'NOT_EQUAL':
          conditionMet = Math.abs(currentValue - conditionValue) > 0.0001;
          break;
        default:
          return false;
      }

      if (conditionMet) {
        this.log('success', `Condition met! ${conditionField} ${conditionOperator} ${conditionValue}`, { currentValue, conditionValue });
      }

      return conditionMet;
    } catch (error) {
      this.log('error', `Error evaluating condition ${condition._id}`, error.message);
      return false;
    }
  }

  async getServerTime() {
    try {
      const response = await fetch(`${this.openApiBase}/sapi/v1/time`);
      const data = await response.json();
      return data.serverTime;
    } catch (error) {
      this.log('warning', 'Failed to fetch server time, using local time', error.message);
      return Date.now();
    }
  }

  async executeAction(condition, user) {
    try {
      const { actionType, actionField, actionValue, limitPrice, _id, name } = condition;

      this.log('trade', `Condition triggered: ${name}`, {
        conditionId: _id.toString(),
        userId: user.uid,
        actionType
      });

      // Get market data for calculations
      const marketData = this.marketData['GCBUSDT'];
      if (!marketData) {
        this.log('error', 'No market data available for trade execution');
        return;
      }

      // Calculate volume based on actionField and order side
      // API Doc: "For MARKET BUY orders, vol=amount (USDT value)"
      // For MARKET SELL orders, vol=quantity (GCB quantity)
      const side = actionType.includes('BUY') ? 'BUY' : 'SELL';
      let volume = 0;
      
      if (side === 'BUY' && actionType.includes('MARKET')) {
        // MARKET BUY: volume = USDT amount
        if (actionField === 'GCB_QUANTITY') {
          // Convert GCB quantity to USDT amount
          volume = actionValue * marketData.price;
          this.log('info', `📐 BUY ${actionValue} GCB = ${volume.toFixed(6)} USDT (price: ${marketData.price})`);
        } else if (actionField === 'USDT_VALUE') {
          volume = actionValue;
          this.log('info', `📐 BUY with ${volume.toFixed(6)} USDT`);
        }
      } else {
        // MARKET SELL or LIMIT orders: volume = GCB quantity
        if (actionField === 'GCB_QUANTITY') {
          volume = actionValue;
        } else if (actionField === 'USDT_VALUE') {
          // Convert USDT value to GCB quantity
          volume = actionValue / marketData.price;
        }
      }

      // Fetch user balance before trade
      const balance = await this.fetchUserBalance(user);
      
      if (balance) {
        const gcbBalance = balance.find(b => b.asset === 'GCB');
        const usdtBalance = balance.find(b => b.asset === 'USDT');
        
        this.log('info', '💰 Current Balance:', {
          GCB: gcbBalance ? `${gcbBalance.free} (locked: ${gcbBalance.locked})` : '0',
          USDT: usdtBalance ? `${usdtBalance.free} (locked: ${usdtBalance.locked})` : '0'
        });

        // Calculate required amount
        const side = actionType.includes('BUY') ? 'BUY' : 'SELL';
        const marketData = this.marketData['GCBUSDT'];
        
        if (side === 'BUY' && marketData) {
          const requiredUsdt = actionValue * marketData.price;
          const availableUsdt = usdtBalance ? parseFloat(usdtBalance.free) : 0;
          this.log('info', `💵 Required: ${requiredUsdt.toFixed(6)} USDT | Available: ${availableUsdt.toFixed(6)} USDT`);
          
          if (availableUsdt < requiredUsdt) {
            this.log('warning', `⚠️ Insufficient USDT balance. Need ${requiredUsdt.toFixed(6)} but only have ${availableUsdt.toFixed(6)}`);
          }
        } else if (side === 'SELL') {
          const requiredGcb = actionValue;
          const availableGcb = gcbBalance ? parseFloat(gcbBalance.free) : 0;
          this.log('info', `💎 Required: ${requiredGcb} GCB | Available: ${availableGcb} GCB`);
          
          if (availableGcb < requiredGcb) {
            this.log('warning', `⚠️ Insufficient GCB balance. Need ${requiredGcb} but only have ${availableGcb}`);
          }
        }
      } else {
        this.log('warning', 'Could not fetch balance before trade');
      }

      // Build order
      const orderBody = {
        symbol: 'GCBUSDT',
        side: actionType.includes('BUY') ? 'BUY' : 'SELL',
        type: actionType.includes('LIMIT') ? 'LIMIT' : 'MARKET',
        volume: volume.toFixed(8)
      };

      // Add price for limit orders
      if (actionType.includes('LIMIT')) {
        if (!limitPrice) {
          this.log('error', 'Limit price required for limit order');
          return;
        }
        orderBody.price = limitPrice.toString();
        orderBody.timeInForce = 'GTC';
      }

      // Get server time for accurate timestamp
      const timestamp = (await this.getServerTime()).toString();
      const method = 'POST';
      const requestPath = '/sapi/v2/order';
      const bodyJson = JSON.stringify(orderBody, null, 0).replace(/\s/g, '');
      const message = `${timestamp}${method.toUpperCase()}${requestPath}${bodyJson}`;
      const signature = crypto
        .createHmac('sha256', user.apiSecret)
        .update(message)
        .digest('hex');

      this.log('info', `Executing trade with server-synced timestamp: ${timestamp}`);

      // Execute trade
      const response = await fetch(`${this.openApiBase}${requestPath}`, {
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

      // Check if order was successful
      if (result.orderId) {
        this.log('success', `Trade executed successfully: ${actionType}`, {
          orderId: result.orderId,
          symbol: result.symbol,
          volume: volume,
          price: result.price || 'MARKET'
        });

        // Update condition in database
        await this.db.collection('bot_conditions').updateOne(
          { _id: condition._id },
          {
            $set: {
              lastTriggered: new Date(),
              updatedAt: new Date()
            },
            $inc: { triggerCount: 1 }
          }
        );

        // Save trade to history
        await this.db.collection('bot_trades').insertOne({
          conditionId: condition._id,
          conditionName: name,
          userId: user.uid,
          orderId: result.orderId,
          symbol: result.symbol,
          side: orderBody.side,
          type: orderBody.type,
          volume: volume,
          price: result.price || null,
          status: 'success',
          executedAt: new Date(),
          apiResponse: result
        });

        // Set cooldown
        this.lastTriggers.set(_id.toString(), Date.now());

        // Clear cached balance for this user
        delete this.userBalances[user.uid];
      } else {
        this.log('error', `Trade execution failed: ${result.msg || 'Unknown error'}`, result);

        // Save failed trade to history
        await this.db.collection('bot_trades').insertOne({
          conditionId: condition._id,
          conditionName: name,
          userId: user.uid,
          symbol: 'GCBUSDT',
          side: orderBody.side,
          type: orderBody.type,
          volume: volume,
          price: limitPrice || null,
          status: 'failed',
          error: result.msg || 'Unknown error',
          executedAt: new Date(),
          apiResponse: result
        });
      }
    } catch (error) {
      this.log('error', `Error executing action for condition ${condition._id}`, error.message);

      // Save error to database
      await this.db.collection('bot_trades').insertOne({
        conditionId: condition._id,
        conditionName: condition.name,
        userId: user.uid,
        symbol: 'GCBUSDT',
        status: 'error',
        error: error.message,
        executedAt: new Date()
      });
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      marketData: this.marketData,
      activeConditionsCount: this.lastTriggers.size,
      config: this.config,
      uptime: this.isRunning ? 'Running' : 'Stopped'
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(0, limit);
  }

  getMarketData() {
    return this.marketData;
  }
}

export default BotMonitor;
