import xtTelegramService from './xt-telegram-service.js';
import { generateXtSignature, buildSignatureMessage, getXtTimestamp, syncXtServerTime } from './xt-user-routes.js';

const XT_BASE_URL = process.env.XT_BASE_URL || 'https://sapi.xt.com';

/**
 * XT Sell-Side Liquidity Bot Monitor
 * 
 * Fulfills XT exchange liquidity requirements for SELL SIDE ONLY:
 * 1. Order Depth ≥ 500 USDT within +2% of Mid-Price (sell side only)
 * 2. Price gap between adjacent orders ≤ 1% in top 20 (sell side only)
 * 3. Top 20 sell cumulative depth ≥ 1,000 USDT
 * 4. Minimum 30 sell orders
 * 
 * This bot does NOT place any buy orders.
 */
class XtSellLiquidityBotMonitor {
  constructor(db) {
    this.db = db;
    this.isRunning = false;
    this.checkInterval = null;
    this.logs = [];
    this.maxLogs = 500;
    this.marketData = {};
    this.processingBots = new Set();
  }

  log(type, message, data = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      data
    };
    this.logs.unshift(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }
    const emoji = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : type === 'trade' ? '💱' : type === 'liquidity' ? '💧' : 'ℹ️';
    console.log(`${emoji} [XtSellLiquidityBot] ${message}`, data ? JSON.stringify(data).substring(0, 200) : '');
  }

  async start() {
    if (this.isRunning) {
      this.log('warning', 'XT Sell Liquidity Bot monitor already running');
      return;
    }

    this.isRunning = true;
    this.log('success', 'XT Sell Liquidity Bot monitor started');

    // Check every 10 seconds
    this.checkInterval = setInterval(() => this.checkAllSellLiquidityBots(), 10000);
    
    // Initial check
    await this.checkAllSellLiquidityBots();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('warning', 'XT Sell Liquidity Bot monitor not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.log('info', 'XT Sell Liquidity Bot monitor stopped');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      marketData: this.marketData
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(0, limit);
  }

  // Helper to make authenticated XT API requests with retry logic
  async makeXtRequest(apiKey, apiSecret, method, path, queryParams = '', body = null, maxRetries = 3) {
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
          this.log('warning', `XT API error ${data.mc}, resyncing time and retrying (attempt ${attempt}/${maxRetries})`);
          await syncXtServerTime();
          continue;
        }
        
        return data;
      } catch (error) {
        if (attempt < maxRetries) {
          this.log('warning', `XT API request error, retrying (attempt ${attempt}/${maxRetries}): ${error.message}`);
          await syncXtServerTime();
          continue;
        }
        throw error;
      }
    }
  }

  // Get full order book depth
  async getOrderBook(symbol = 'gcb_usdt', limit = 100) {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/depth?symbol=${symbol}&limit=${limit}`);
      const data = await response.json();
      
      if (data.rc === 0 && data.result) {
        return {
          bids: data.result.bids || [],
          asks: data.result.asks || [],
          timestamp: data.result.timestamp
        };
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch order book: ${error.message}`);
      return null;
    }
  }

  // Get market price
  async getMarketPrice(symbol = 'gcb_usdt') {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/ticker/price?symbol=${symbol}`);
      const data = await response.json();
      if (data.rc === 0 && data.result && data.result.length > 0) {
        return parseFloat(data.result[0].p);
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch market price: ${error.message}`);
      return null;
    }
  }

  // Get symbol info for precision
  async getSymbolInfo(symbol = 'gcb_usdt') {
    try {
      const response = await fetch(`${XT_BASE_URL}/v4/public/symbol?symbol=${symbol}`);
      const data = await response.json();
      if (data.rc === 0 && data.result?.symbols?.length > 0) {
        return data.result.symbols[0];
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch symbol info: ${error.message}`);
      return null;
    }
  }

  async getUserCredentials(mexcUserId) {
    try {
      const xtUser = await this.db.collection('xt_users').findOne({ mexcUserId });
      if (!xtUser) return null;
      return { apiKey: xtUser.apiKey, apiSecret: xtUser.apiSecret };
    } catch (error) {
      this.log('error', `Error getting XT user credentials: ${error.message}`);
      return null;
    }
  }

  async getAccountBalance(apiKey, apiSecret) {
    try {
      const data = await this.makeXtRequest(apiKey, apiSecret, 'GET', '/v4/balances', 'currencies=usdt,gcb');
      
      if (data.rc === 0 && data.result?.assets) {
        const balanceMap = {};
        data.result.assets.forEach(asset => {
          balanceMap[asset.currency.toLowerCase()] = {
            availableAmount: parseFloat(asset.availableAmount) || 0,
            frozenAmount: parseFloat(asset.frozenAmount) || 0,
            totalAmount: parseFloat(asset.totalAmount) || 0
          };
        });
        return balanceMap;
      }
      return null;
    } catch (error) {
      this.log('error', `Failed to fetch account balance: ${error.message}`);
      return null;
    }
  }

  // Get user's open orders (SELL only)
  async getOpenOrders(apiKey, apiSecret, symbol = 'gcb_usdt') {
    try {
      const lowerSymbol = symbol.toLowerCase();
      const data = await this.makeXtRequest(apiKey, apiSecret, 'GET', '/v4/open-order', `symbol=${lowerSymbol}&bizType=SPOT`);
      
      if (data.rc === 0) {
        const orders = data.result || [];
        // Filter to only SELL orders
        const sellOrders = orders.filter(o => o.side?.toUpperCase() === 'SELL');
        this.log('info', `📋 API returned ${sellOrders.length} SELL orders for ${lowerSymbol}`);
        return sellOrders;
      }
      
      this.log('warning', `Open orders API returned rc=${data.rc}, mc=${data.mc}`);
      return [];
    } catch (error) {
      this.log('error', `Failed to fetch open orders: ${error.message}`);
      return [];
    }
  }

  // Place a single limit order
  async placeLimitOrder(apiKey, apiSecret, symbol, side, price, quantity) {
    try {
      const orderBody = {
        symbol: symbol.toLowerCase(),
        side: side.toUpperCase(),
        type: 'LIMIT',
        timeInForce: 'GTC',
        bizType: 'SPOT',
        price: price.toString(),
        quantity: quantity.toString()
      };

      const data = await this.makeXtRequest(apiKey, apiSecret, 'POST', '/v4/order', '', orderBody);

      if (data.rc === 0 && data.result?.orderId) {
        return { success: true, orderId: data.result.orderId };
      } else {
        return { success: false, error: data.mc || 'Order failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Place batch orders (SELL only)
  async placeBatchOrders(apiKey, apiSecret, orders) {
    try {
      const items = orders.map((order, index) => ({
        symbol: order.symbol.toLowerCase(),
        clientOrderId: `sell_liq_${Date.now()}_${index}`,
        side: 'SELL', // Always SELL
        type: 'LIMIT',
        timeInForce: 'GTC',
        bizType: 'SPOT',
        price: order.price,
        quantity: order.quantity
      }));

      const batchBody = {
        clientBatchId: `sell_liquidity_${Date.now()}`,
        items: items
      };

      const data = await this.makeXtRequest(apiKey, apiSecret, 'POST', '/v4/batch-order', '', batchBody);

      if (data.rc === 0) {
        return { success: true, result: data.result };
      } else {
        return { success: false, error: data.mc || 'Batch order failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Cancel an order
  async cancelOrder(apiKey, apiSecret, orderId) {
    try {
      const data = await this.makeXtRequest(apiKey, apiSecret, 'DELETE', `/v4/order/${orderId}`);
      return data.rc === 0;
    } catch (error) {
      this.log('error', `Failed to cancel order ${orderId}: ${error.message}`);
      return false;
    }
  }

  // Cancel ALL SELL open orders for a symbol
  async cancelAllSellOrders(apiKey, apiSecret, symbol = 'gcb_usdt') {
    try {
      const cancelBody = {
        bizType: 'SPOT',
        symbol: symbol.toLowerCase(),
        side: 'SELL'
      };

      this.log('info', `🗑️ Cancelling all SELL open orders for ${symbol}...`);
      
      const data = await this.makeXtRequest(apiKey, apiSecret, 'DELETE', '/v4/open-order', '', cancelBody);

      if (data.rc === 0) {
        this.log('success', `✅ Cancelled all SELL open orders for ${symbol}`);
        return { success: true, data: data.result };
      } else {
        this.log('error', `Failed to cancel orders: ${data.mc}`);
        return { success: false, error: data.mc || 'Cancel failed' };
      }
    } catch (error) {
      this.log('error', `Error cancelling all orders: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Cancel batch orders by order IDs
  async cancelBatchOrders(apiKey, apiSecret, orderIds) {
    try {
      if (!orderIds || orderIds.length === 0) {
        return { success: true, cancelled: 0 };
      }

      const cancelBody = {
        orderIds: orderIds.map(id => id.toString())
      };

      const data = await this.makeXtRequest(apiKey, apiSecret, 'DELETE', '/v4/batch-order', '', cancelBody);

      if (data.rc === 0) {
        this.log('success', `✅ Cancelled ${orderIds.length} orders`);
        return { success: true, cancelled: orderIds.length };
      } else {
        return { success: false, error: data.mc || 'Batch cancel failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Force immediate sell-side liquidity adjustment
  async forceAdjustLiquidity(bot) {
    const botId = bot._id.toString();
    this.log('info', `🔧 Force adjusting SELL liquidity for [${bot.name}]`);

    try {
      const symbol = bot.symbol || 'gcb_usdt';
      
      const credentials = await this.getUserCredentials(bot.mexcUserId);
      if (!credentials) {
        this.log('error', `[${bot.name}] XT credentials not found`);
        return { success: false, error: 'Credentials not found' };
      }

      // Get market data
      const [orderBook, marketPrice, symbolInfo] = await Promise.all([
        this.getOrderBook(symbol, 100),
        this.getMarketPrice(symbol),
        this.getSymbolInfo(symbol)
      ]);

      if (!orderBook || !marketPrice) {
        this.log('error', `[${bot.name}] Could not fetch market data`);
        return { success: false, error: 'Could not fetch market data' };
      }

      // Analyze with autoManage forced on
      const tempBot = { ...bot, autoManage: true };
      const analysis = this.analyzeSellLiquidity(orderBook, marketPrice, tempBot);

      // Check balance
      const balances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      if (!balances) {
        return { success: false, error: 'Could not fetch balance' };
      }

      // Get existing SELL orders to avoid duplicates
      const mySellOrders = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);

      // Generate and place SELL orders only
      const neededOrders = this.generateNeededSellOrders(analysis, tempBot, symbolInfo, mySellOrders);
      
      let ordersPlaced = 0;
      let ordersFailed = 0;

      // Place sell orders
      if (neededOrders.sells.length > 0) {
        const sellBatches = this.chunkArray(neededOrders.sells.map(o => ({
          symbol,
          side: 'SELL',
          price: o.price,
          quantity: o.quantity
        })), 10);

        for (const batch of sellBatches) {
          const result = await this.placeBatchOrders(credentials.apiKey, credentials.apiSecret, batch);
          if (result.success) {
            ordersPlaced += batch.length;
          } else {
            ordersFailed += batch.length;
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // Update bot stats
      await this.db.collection('xt_sell_liquidity_bots').updateOne(
        { _id: bot._id },
        { 
          $inc: { totalOrdersPlaced: ordersPlaced, totalMaintenance: 1 },
          $set: { lastMaintenanceAt: new Date(), lastCheckedAt: new Date() }
        }
      );

      this.log('success', `[${bot.name}] Force adjustment complete: ${ordersPlaced} SELL orders placed`);
      return { success: true, ordersPlaced, ordersFailed };

    } catch (error) {
      this.log('error', `[${bot.name}] Force adjust error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Analyze current SELL SIDE liquidity status only
   */
  analyzeSellLiquidity(orderBook, midPrice, config) {
    const scale = config.scaleFactor || 1;
    
    const minDepth2Pct = (config.minDepth2Percent || 500) * scale;
    const minDepthTop20 = (config.minDepthTop20 || 1000) * scale;
    const minOrderCount = config.minOrderCount || 30;
    const maxGap = config.maxOrderGap || 1;

    const analysis = {
      midPrice,
      sellOrders: [],
      metrics: {
        sellDepth2Pct: 0,
        depth2PctOk: false,
        sellDepthTop20: 0,
        depthTop20Ok: false,
        sellOrderCount: 0,
        orderCountOk: false,
        sellGapsOk: true,
        gapIssues: []
      },
      neededOrders: {
        sells: []
      }
    };

    const asks = orderBook.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));

    // Sort asks ascending (lowest first)
    asks.sort((a, b) => a.price - b.price);

    analysis.sellOrders = asks;

    // Calculate depth within +2% of best ask (sell side only - best ask is reference)
    const bestAsk = asks.length > 0 ? asks[0].price : midPrice;
    const sellUpperBound = bestAsk * 1.02;

    analysis.metrics.sellDepth2Pct = asks
      .filter(a => a.price >= bestAsk && a.price <= sellUpperBound)
      .reduce((sum, a) => sum + (a.price * a.qty), 0);

    analysis.metrics.depth2PctOk = analysis.metrics.sellDepth2Pct >= minDepth2Pct;

    // Calculate top 20 cumulative depth (sell side only)
    const top20Asks = asks.slice(0, 20);

    analysis.metrics.sellDepthTop20 = top20Asks.reduce((sum, a) => sum + (a.price * a.qty), 0);

    analysis.metrics.depthTop20Ok = analysis.metrics.sellDepthTop20 >= minDepthTop20;

    // Count orders (sell side only)
    analysis.metrics.sellOrderCount = asks.length;
    analysis.metrics.orderCountOk = asks.length >= minOrderCount;

    // Check gaps in top 20 (sell side only)
    for (let i = 0; i < Math.min(19, top20Asks.length - 1); i++) {
      const gap = ((top20Asks[i + 1].price - top20Asks[i].price) / top20Asks[i].price) * 100;
      if (gap > maxGap) {
        analysis.metrics.sellGapsOk = false;
        analysis.metrics.gapIssues.push({ side: 'SELL', index: i, gap: gap.toFixed(2) });
      }
    }

    return analysis;
  }

  /**
   * NEW STRATEGY: Generate SELL orders to fulfill liquidity requirements
   * 
   * Budget Split from minDepthTop20 (admin config):
   * - 20% for top 10 orders (gap-filling for requirement #3)
   * - 80% for orders 11-20 (depth-filling for requirements #2 & #4)
   * 
   * Distribution for orders 11-20: 5%, 5%, 5%, 5%, 10%, 10%, 10%, 15%, 15%, 20%
   */
  generateNeededSellOrders(analysis, config, symbolInfo, mySellOrders = []) {
    const orders = { sells: [], gapFills: [], depthFills: [] };
    const midPrice = analysis.midPrice;
    const marketAsks = analysis.sellOrders || []; // Sorted ascending by price
    
    const pricePrecision = symbolInfo?.pricePrecision || 6;
    const qtyPrecision = symbolInfo?.quantityPrecision || 2;
    
    // Admin-configured total budget (from minDepthTop20 - requirement #4)
    const totalBudget = config.minDepthTop20 || 1000;
    const maxGap = config.maxOrderGap || 1; // Max 1% gap allowed
    
    const formatPrice = (price) => parseFloat(price.toFixed(pricePrecision));
    const formatQty = (qty) => Math.max(parseFloat(qty.toFixed(qtyPrecision)), 0.01);

    // Get my existing order prices
    const mySellPrices = mySellOrders.map(o => parseFloat(o.price || 0));
    const existingSellPrices = new Set(mySellPrices.map(p => formatPrice(p).toString()));

    // Calculate MY current depth contribution
    const bestAsk = marketAsks.length > 0 ? marketAsks[0].price : midPrice;
    const mySellDepth = mySellOrders
      .filter(o => parseFloat(o.price) <= bestAsk * 1.02)
      .reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.origQty || 0), 0);

    // Budget split: 20% for gap-filling (top 10), 80% for depth-filling (11-20)
    const gapFillingBudget = totalBudget * 0.20;
    const depthFillingBudget = totalBudget * 0.80;
    
    this.log('info', `💰 Total Budget: $${totalBudget} | Gap-Fill (20%): $${gapFillingBudget} | Depth-Fill (80%): $${depthFillingBudget}`);

    // ============================================
    // PHASE 1: GAP-FILLING FOR TOP 10 (20% budget)
    // ============================================
    const top10Asks = marketAsks.slice(0, 10);
    const gapsToFill = [];
    
    // Check gaps between adjacent orders in top 10
    for (let i = 0; i < Math.min(9, top10Asks.length - 1); i++) {
      const currentPrice = top10Asks[i].price;
      const nextPrice = top10Asks[i + 1].price;
      const gapPct = ((nextPrice - currentPrice) / currentPrice) * 100;
      
      if (gapPct > maxGap) {
        // Gap exceeds 1%, need to fill
        gapsToFill.push({
          index: i,
          fromPrice: currentPrice,
          toPrice: nextPrice,
          gapPct: gapPct,
          fillPrice: formatPrice(currentPrice * (1 + maxGap / 100)) // Place at max allowed gap
        });
      }
    }
    
    // Also check if we need orders at the beginning (before first ask)
    if (top10Asks.length > 0) {
      const firstAskPrice = top10Asks[0].price;
      // Check if there's room to place orders closer to mid-price
      const minSpread = midPrice * 1.005; // 0.5% minimum spread
      if (firstAskPrice > minSpread * 1.01) {
        // Room to add order before first ask
        gapsToFill.unshift({
          index: -1,
          fromPrice: minSpread,
          toPrice: firstAskPrice,
          gapPct: ((firstAskPrice - minSpread) / minSpread) * 100,
          fillPrice: formatPrice(minSpread)
        });
      }
    }
    
    if (gapsToFill.length > 0) {
      // Split 20% budget among gaps (each gap gets equal share, then split into small orders)
      const budgetPerGap = gapFillingBudget / gapsToFill.length;
      const ordersPerGap = Math.min(Math.ceil(10 / gapsToFill.length), 5); // Max 5 orders per gap
      
      for (const gap of gapsToFill) {
        const orderBudget = budgetPerGap / ordersPerGap;
        const priceStep = (gap.toPrice - gap.fromPrice) / (ordersPerGap + 1);
        
        for (let j = 1; j <= ordersPerGap; j++) {
          const price = formatPrice(gap.fromPrice + priceStep * j);
          const priceStr = price.toString();
          
          if (!existingSellPrices.has(priceStr) && price > midPrice) {
            const qty = formatQty(orderBudget / price);
            if (qty >= 0.01) {
              orders.gapFills.push({ 
                price: priceStr, 
                quantity: qty.toString(),
                purpose: 'gap_fill',
                gapIndex: gap.index
              });
              existingSellPrices.add(priceStr);
            }
          }
        }
      }
      this.log('info', `🔧 Gap-filling: Found ${gapsToFill.length} gaps > ${maxGap}%, placing ${orders.gapFills.length} orders`);
    } else {
      this.log('success', `✅ Top 10 gaps OK - all gaps ≤ ${maxGap}%`);
    }

    // ============================================
    // PHASE 2: DEPTH-FILLING FOR ORDERS 11-20 (80% budget)
    // ============================================
    // Distribution: 5%, 5%, 5%, 5%, 10%, 10%, 10%, 15%, 15%, 20%
    const depthDistribution = [0.05, 0.05, 0.05, 0.05, 0.10, 0.10, 0.10, 0.15, 0.15, 0.20];
    
    // Get existing orders 11-20 from market
    const orders11to20 = marketAsks.slice(10, 20);
    
    // Calculate current depth in positions 11-20
    const existingDepth11to20 = orders11to20.reduce((sum, o) => sum + o.price * o.qty, 0);
    
    // Check if we need to add depth (requirement #4: top 20 depth >= minDepthTop20)
    const currentTop20Depth = analysis.metrics.sellDepthTop20 || 0;
    const neededTop20Depth = Math.max(0, totalBudget - currentTop20Depth);
    
    // Also check requirement #2: depth within +2% of best ask
    const currentDepth2Pct = analysis.metrics.sellDepth2Pct || 0;
    const targetDepth2Pct = config.minDepth2Percent || 500;
    const neededDepth2Pct = Math.max(0, targetDepth2Pct - currentDepth2Pct);
    
    this.log('info', `📊 Top 20 Depth: $${currentTop20Depth.toFixed(2)}/${totalBudget} | +2% Depth: $${currentDepth2Pct.toFixed(2)}/${targetDepth2Pct}`);
    
    // Only place depth orders if requirements not met
    if (neededTop20Depth > 0 || neededDepth2Pct > 0) {
      // Determine price range for orders 11-20
      // Start after existing top 10 or extend from best ask
      let basePrice;
      if (marketAsks.length >= 10) {
        basePrice = marketAsks[9].price; // Price of 10th order
      } else if (marketAsks.length > 0) {
        basePrice = marketAsks[marketAsks.length - 1].price;
      } else {
        basePrice = midPrice * 1.005;
      }
      
      // Place orders with increasing prices and weighted amounts
      for (let i = 0; i < 10; i++) {
        // Calculate price for this position (11th to 20th)
        // Each order is ~0.5% higher than previous
        const priceMultiplier = 1 + (0.005 * (i + 1)); // 0.5% steps
        const price = formatPrice(basePrice * priceMultiplier);
        const priceStr = price.toString();
        
        // Skip if we already have an order at this price
        if (existingSellPrices.has(priceStr)) {
          continue;
        }
        
        // Calculate order value based on weighted distribution
        const orderValue = depthFillingBudget * depthDistribution[i];
        const qty = formatQty(orderValue / price);
        
        if (qty >= 0.01 && price > midPrice) {
          orders.depthFills.push({
            price: priceStr,
            quantity: qty.toString(),
            purpose: 'depth_fill',
            position: 11 + i,
            weightPct: depthDistribution[i] * 100
          });
          existingSellPrices.add(priceStr);
        }
      }
      
      this.log('info', `📦 Depth-filling: Placing ${orders.depthFills.length} orders in positions 11-20`);
    } else {
      this.log('success', `✅ Depth requirements already met`);
    }

    // Combine all orders
    orders.sells = [...orders.gapFills, ...orders.depthFills];

    // Log summary
    const totalSellValue = orders.sells.reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.quantity), 0);
    const totalSellQty = orders.sells.reduce((sum, o) => sum + parseFloat(o.quantity), 0);
    
    this.log('info', `📊 Generated ${orders.sells.length} sell orders (${totalSellQty.toFixed(2)} GCB worth $${totalSellValue.toFixed(2)})`);
    this.log('info', `   - Gap-fill orders: ${orders.gapFills.length} | Depth-fill orders: ${orders.depthFills.length}`);

    // Store budget requirements for UI
    const budgetNeeded = totalSellValue > 0 ? totalSellValue : 0;
    orders.budgetRequired = {
      sell: totalSellQty,
      total: budgetNeeded
    };
    
    return orders;
  }

  async checkAllSellLiquidityBots() {
    if (!this.isRunning) return;

    try {
      // Find all active SELL liquidity bots
      const activeBots = await this.db.collection('xt_sell_liquidity_bots').find({
        isActive: true,
        isRunning: true
      }).toArray();

      if (activeBots.length === 0) {
        return;
      }

      this.log('info', `🔍 Checking ${activeBots.length} active XT SELL liquidity bot(s)`);

      for (const bot of activeBots) {
        await this.checkSellLiquidityBot(bot);
      }
    } catch (error) {
      this.log('error', 'Error checking XT sell liquidity bots', error.message);
    }
  }

  async checkSellLiquidityBot(bot) {
    const botId = bot._id.toString();

    // Prevent duplicate processing
    if (this.processingBots.has(botId)) {
      return;
    }
    this.processingBots.add(botId);

    try {
      const symbol = bot.symbol || 'gcb_usdt';
      
      // Get user credentials
      const credentials = await this.getUserCredentials(bot.mexcUserId);
      if (!credentials) {
        this.log('warning', `[${bot.name}] XT credentials not found`);
        return;
      }

      // Re-fetch bot from DB
      const freshBot = await this.db.collection('xt_sell_liquidity_bots').findOne({ _id: bot._id });
      if (!freshBot || !freshBot.isRunning) {
        return;
      }

      // Check cooldown
      const cooldownMs = (freshBot.checkIntervalSeconds || 30) * 1000;
      const lastChecked = freshBot.lastCheckedAt ? new Date(freshBot.lastCheckedAt).getTime() : 0;
      const now = Date.now();

      if (now - lastChecked < cooldownMs) {
        return;
      }

      // Get market data
      const [orderBook, marketPrice, symbolInfo] = await Promise.all([
        this.getOrderBook(symbol, 100),
        this.getMarketPrice(symbol),
        this.getSymbolInfo(symbol)
      ]);

      if (!orderBook || !marketPrice) {
        this.log('warning', `[${bot.name}] Could not fetch market data`);
        return;
      }

      const midPrice = marketPrice;

      // Analyze current SELL liquidity
      const analysis = this.analyzeSellLiquidity(orderBook, midPrice, freshBot);

      // Store analysis in marketData for status endpoint
      this.marketData[symbol] = {
        midPrice,
        analysis: analysis.metrics,
        updatedAt: new Date().toISOString()
      };

      // Log current status
      this.log('liquidity', `[${bot.name}] 📊 Sell Depth: $${analysis.metrics.sellDepth2Pct.toFixed(2)} | Orders: ${analysis.metrics.sellOrderCount}S`);

      // Check if all SELL requirements are met
      const allOk = analysis.metrics.depth2PctOk && 
                    analysis.metrics.depthTop20Ok && 
                    analysis.metrics.orderCountOk &&
                    analysis.metrics.sellGapsOk;

      // Get MY open SELL orders first for accurate budget calculation
      const mySellOrdersForCalc = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
      
      // Calculate MY sell depth (value of my sell orders within +2% of best ask)
      const bestAsk = analysis.orderBook?.asks?.[0] ? parseFloat(analysis.orderBook.asks[0][0]) : midPrice;
      const mySellDepth = mySellOrdersForCalc
        .filter(o => parseFloat(o.price) <= bestAsk * 1.02)
        .reduce((sum, o) => sum + parseFloat(o.price) * parseFloat(o.origQty), 0);
      
      // Calculate budget requirements for UI
      const tempNeededOrders = this.generateNeededSellOrders(analysis, freshBot, symbolInfo, mySellOrdersForCalc);
      const budgetRequired = tempNeededOrders.budgetRequired || { sell: 0, total: 0 };
      
      // Get balance for status update
      const balancesForStatus = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      
      // Update bot status with budget info
      await this.db.collection('xt_sell_liquidity_bots').updateOne(
        { _id: bot._id },
        { 
          $set: { 
            lastCheckedAt: new Date(),
            lastMidPrice: midPrice,
            lastSellDepth: analysis.metrics.sellDepth2Pct,
            lastSellDepthTop20: analysis.metrics.sellDepthTop20,
            lastSellOrderCount: analysis.metrics.sellOrderCount,
            liquidityOk: allOk,
            budgetRequired: allOk ? { sell: 0, total: 0 } : budgetRequired,
            availableBalance: { 
              usdt: balancesForStatus?.usdt?.availableAmount || 0, 
              gcb: balancesForStatus?.gcb?.availableAmount || 0 
            },
            mySellOrderCount: mySellOrdersForCalc.length,
            mySellDepth: mySellDepth,
            marketSellOrderCount: analysis.metrics.sellOrderCount,
            updatedAt: new Date()
          } 
        }
      );

      // Only place orders if autoManage is enabled
      if (!freshBot.autoManage) {
        if (!allOk) {
          this.log('info', `[${bot.name}] ⚠️ Sell liquidity issues detected but autoManage is disabled`);
          if (!analysis.metrics.depth2PctOk) {
            this.log('warning', `[${bot.name}] Sell Depth +2% insufficient: $${analysis.metrics.sellDepth2Pct.toFixed(2)}`);
          }
          if (!analysis.metrics.orderCountOk) {
            this.log('warning', `[${bot.name}] Sell order count insufficient: ${analysis.metrics.sellOrderCount}`);
          }
        } else {
          this.log('success', `[${bot.name}] ✅ All SELL liquidity requirements met (autoManage disabled)`);
        }
        return;
      }

      // Get MY open SELL orders to check if we need to place more
      const mySellOrders = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
      
      this.log('info', `[${bot.name}] 🔍 Found ${mySellOrders.length} SELL open orders`);
      
      const minOrderCount = freshBot.minOrderCount || 30;
      
      // ============================================
      // STEP 1: Cancel stale orders (>25% from mid-price)
      // ============================================
      const ordersToCancel = [];
      const sellPriceRange = { min: midPrice * 0.98, max: midPrice * 1.25 };

      for (const order of mySellOrders) {
        const price = parseFloat(order.price);
        if (price < sellPriceRange.min || price > sellPriceRange.max) {
          ordersToCancel.push(order.orderId);
        }
      }

      if (ordersToCancel.length > 0) {
        this.log('info', `[${bot.name}] 🗑️ Cancelling ${ordersToCancel.length} stale SELL orders (>25% from mid-price)`);
        await this.cancelBatchOrders(credentials.apiKey, credentials.apiSecret, ordersToCancel);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Re-fetch orders after cancellation
      let updatedSellOrders = ordersToCancel.length > 0 
        ? await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol)
        : mySellOrders;

      // ============================================
      // STEP 2: Check if market already meets requirements
      // ============================================
      const targetDepth2Pct = freshBot.minDepth2Percent || 500;
      const targetTop20Depth = freshBot.minDepthTop20 || 1000;
      const marketSellDepthOk = analysis.metrics.sellDepth2Pct >= targetDepth2Pct;
      const marketTop20DepthOk = analysis.metrics.sellDepthTop20 >= targetTop20Depth;
      const marketSellCountOk = analysis.metrics.sellOrderCount >= minOrderCount;
      
      // If MARKET already meets all SELL requirements, check for adjustments only
      if (allOk) {
        this.log('success', `[${bot.name}] ✅ Market meets all SELL requirements. My orders: ${updatedSellOrders.length}S`);
        
        // Even if OK, check if we can optimize our order positions
        const adjustments = this.analyzeOrderAdjustments(analysis, freshBot, updatedSellOrders, symbolInfo);
        if (adjustments.ordersToCancel.length > 0) {
          this.log('info', `[${bot.name}] 🔄 Optimizing ${adjustments.ordersToCancel.length} orders...`);
          for (const reason of adjustments.reason) {
            this.log('info', `   ${reason}`);
          }
        }
        return;
      }
      
      // Log what needs improvement
      this.log('info', `[${bot.name}] 📋 Requirements check:`);
      this.log('info', `   - Depth +2%: $${analysis.metrics.sellDepth2Pct.toFixed(2)}/${targetDepth2Pct} ${marketSellDepthOk ? '✅' : '❌'}`);
      this.log('info', `   - Top 20 Depth: $${analysis.metrics.sellDepthTop20.toFixed(2)}/${targetTop20Depth} ${marketTop20DepthOk ? '✅' : '❌'}`);
      this.log('info', `   - Order Count: ${analysis.metrics.sellOrderCount}/${minOrderCount} ${marketSellCountOk ? '✅' : '❌'}`);
      this.log('info', `   - Gaps OK: ${analysis.metrics.sellGapsOk ? '✅' : '❌'}`);

      // ============================================
      // STEP 3: Analyze if existing orders need adjustment
      // ============================================
      const adjustments = this.analyzeOrderAdjustments(analysis, freshBot, updatedSellOrders, symbolInfo);
      
      if (adjustments.ordersToCancel.length > 0) {
        this.log('info', `[${bot.name}] 🔄 Adjusting ${adjustments.ordersToCancel.length} existing orders for better positioning`);
        for (const reason of adjustments.reason) {
          this.log('info', `   ${reason}`);
        }
        await this.cancelBatchOrders(credentials.apiKey, credentials.apiSecret, adjustments.ordersToCancel);
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Re-fetch orders after adjustment cancellation
        updatedSellOrders = await this.getOpenOrders(credentials.apiKey, credentials.apiSecret, symbol);
      }

      // ============================================
      // STEP 4: Check balance before placing orders
      // ============================================
      const balances = await this.getAccountBalance(credentials.apiKey, credentials.apiSecret);
      if (!balances) {
        this.log('warning', `[${bot.name}] Could not fetch balance`);
        return;
      }

      const availableGcb = balances.gcb?.availableAmount || 0;

      // ============================================
      // STEP 5: Generate needed SELL orders using new strategy
      // ============================================
      this.log('info', `[${bot.name}] 📋 Existing SELL orders: ${updatedSellOrders.length}`);
      const neededOrders = this.generateNeededSellOrders(analysis, freshBot, symbolInfo, updatedSellOrders);
      
      // Add any repositioning orders from adjustments
      if (adjustments.ordersToPlace.length > 0) {
        neededOrders.sells.push(...adjustments.ordersToPlace);
        this.log('info', `[${bot.name}] ➕ Adding ${adjustments.ordersToPlace.length} repositioned orders`);
      }
      
      const totalSellGcb = neededOrders.sells.reduce((sum, o) => sum + parseFloat(o.quantity), 0);

      this.log('info', `[${bot.name}] 📝 Will place ${neededOrders.sells.length} sell orders (${totalSellGcb.toFixed(2)} GCB)`);
      
      // If no orders needed, we're done
      if (neededOrders.sells.length === 0) {
        this.log('success', `[${bot.name}] ✅ No SELL orders needed - market is sufficient`);
        return;
      }

      // Check GCB balance
      if (totalSellGcb > availableGcb) {
        if (availableGcb >= 0.5) {
          this.log('info', `[${bot.name}] 💰 Using available ${availableGcb.toFixed(2)} GCB (need ${totalSellGcb.toFixed(2)})`);
          let gcbUsed = 0;
          const adjustedSells = [];
          
          for (const order of neededOrders.sells) {
            const orderQty = parseFloat(order.quantity);
            if (gcbUsed + orderQty <= availableGcb) {
              adjustedSells.push(order);
              gcbUsed += orderQty;
            } else if (availableGcb - gcbUsed >= 0.5) {
              const remainingGcb = availableGcb - gcbUsed;
              if (remainingGcb >= 0.01) {
                adjustedSells.push({ price: order.price, quantity: remainingGcb.toFixed(2) });
                gcbUsed += remainingGcb;
              }
              break;
            }
          }
          neededOrders.sells = adjustedSells;
        } else {
          this.log('warning', `[${bot.name}] Insufficient GCB: have ${availableGcb.toFixed(2)}, need at least 0.5`);
          neededOrders.sells = [];
        }
      }

      // Place SELL orders in batches
      let ordersPlaced = 0;
      let ordersFailed = 0;

      if (neededOrders.sells.length > 0) {
        const sellBatches = this.chunkArray(neededOrders.sells.map(o => ({
          symbol,
          side: 'SELL',
          price: o.price,
          quantity: o.quantity
        })), 10);

        for (const batch of sellBatches) {
          const result = await this.placeBatchOrders(credentials.apiKey, credentials.apiSecret, batch);
          if (result.success) {
            ordersPlaced += batch.length;
            this.log('success', `[${bot.name}] Placed ${batch.length} SELL orders`);
          } else {
            ordersFailed += batch.length;
            this.log('error', `[${bot.name}] Failed to place sell batch: ${result.error}`);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Log activity
      await this.db.collection('xt_sell_liquidity_bot_logs').insertOne({
        mexcUserId: bot.mexcUserId,
        botId: botId,
        botName: bot.name,
        action: 'SELL_LIQUIDITY_MAINTENANCE',
        symbol: symbol,
        midPrice: midPrice,
        sellDepth: analysis.metrics.sellDepth2Pct,
        ordersPlaced: ordersPlaced,
        ordersFailed: ordersFailed,
        status: ordersFailed === 0 ? 'SUCCESS' : 'PARTIAL',
        message: `Placed ${ordersPlaced} SELL orders (${ordersFailed} failed) to maintain liquidity`,
        createdAt: new Date()
      });

      // Update bot stats
      await this.db.collection('xt_sell_liquidity_bots').updateOne(
        { _id: bot._id },
        { 
          $inc: {
            totalOrdersPlaced: ordersPlaced,
            totalMaintenance: 1
          },
          $set: {
            lastMaintenanceAt: new Date()
          }
        }
      );

      this.log('success', `[${bot.name}] ✅ SELL liquidity maintenance complete: ${ordersPlaced} orders placed`);

      // Send Telegram notification if enabled
      if (freshBot.telegramEnabled && ordersPlaced > 0) {
        try {
          await xtTelegramService.sendXtNotification(
            `<b>💧 XT Sell Liquidity Bot Update</b>\n\n` +
            `🤖 <b>Bot:</b> ${bot.name}\n` +
            `💱 <b>Symbol:</b> ${symbol.toUpperCase()}\n` +
            `📊 <b>Mid Price:</b> $${midPrice.toFixed(6)}\n` +
            `💰 <b>Sell Depth:</b> $${analysis.metrics.sellDepth2Pct.toFixed(2)}\n` +
            `📝 <b>SELL Orders Placed:</b> ${ordersPlaced}\n\n` +
            `⏰ <b>Time:</b> ${new Date().toUTCString()}`
          );
        } catch (err) {
          this.log('warning', 'Telegram notification failed', err.message);
        }
      }

    } catch (error) {
      this.log('error', `[${bot.name}] Error: ${error.message}`);
    } finally {
      this.processingBots.delete(botId);
    }
  }

  /**
   * Analyze if existing orders need adjustment based on current order book state
   * Returns orders to cancel and new orders to place
   */
  analyzeOrderAdjustments(analysis, config, mySellOrders, symbolInfo) {
    const adjustments = {
      ordersToCancel: [],
      ordersToPlace: [],
      reason: []
    };
    
    const marketAsks = analysis.sellOrders || [];
    const midPrice = analysis.midPrice;
    const maxGap = config.maxOrderGap || 1;
    const pricePrecision = symbolInfo?.pricePrecision || 6;
    const qtyPrecision = symbolInfo?.quantityPrecision || 2;
    
    const formatPrice = (price) => parseFloat(price.toFixed(pricePrecision));
    const formatQty = (qty) => Math.max(parseFloat(qty.toFixed(qtyPrecision)), 0.01);

    // Build a map of my orders by price
    const myOrdersByPrice = new Map();
    for (const order of mySellOrders) {
      const price = parseFloat(order.price);
      myOrdersByPrice.set(formatPrice(price).toString(), order);
    }

    // Check top 10 market orders for gaps that need my intervention
    const top10Asks = marketAsks.slice(0, 10);
    
    for (let i = 0; i < Math.min(9, top10Asks.length - 1); i++) {
      const currentPrice = top10Asks[i].price;
      const nextPrice = top10Asks[i + 1].price;
      const gapPct = ((nextPrice - currentPrice) / currentPrice) * 100;
      
      if (gapPct > maxGap) {
        // Check if I have an order in this gap range that could be repositioned
        const gapMidPrice = formatPrice((currentPrice + nextPrice) / 2);
        const optimalFillPrice = formatPrice(currentPrice * (1 + maxGap / 100 / 2));
        
        // Check if any of my orders are poorly positioned (outside top 20 or in wrong gap)
        for (const [priceStr, order] of myOrdersByPrice) {
          const orderPrice = parseFloat(priceStr);
          
          // If my order is way outside the critical zone (>15% from mid), consider repositioning
          if (orderPrice > midPrice * 1.15) {
            // This order could be moved to fill the gap
            adjustments.ordersToCancel.push(order.orderId);
            adjustments.ordersToPlace.push({
              price: optimalFillPrice.toString(),
              quantity: order.origQty,
              purpose: 'gap_reposition'
            });
            adjustments.reason.push(`Repositioning order from $${orderPrice.toFixed(6)} to fill gap at $${optimalFillPrice.toFixed(6)}`);
            myOrdersByPrice.delete(priceStr); // Remove from consideration
            break; // Only reposition one order per gap
          }
        }
      }
    }

    // Check if market conditions changed significantly and depth orders need adjustment
    const currentTop20Depth = analysis.metrics.sellDepthTop20 || 0;
    const targetTop20Depth = config.minDepthTop20 || 1000;
    
    // If depth is significantly over target (>150%), we might have too many orders
    if (currentTop20Depth > targetTop20Depth * 1.5 && mySellOrders.length > 5) {
      // Market might have new orders, we can reduce some of ours
      // Find our orders that are in the 11-20 range and cancel some
      const ordersInDepthZone = mySellOrders
        .filter(o => {
          const price = parseFloat(o.price);
          return price > midPrice * 1.02 && price <= midPrice * 1.10;
        })
        .sort((a, b) => parseFloat(b.price) - parseFloat(a.price)); // Highest first
      
      // Cancel up to 30% of depth zone orders if we're over target
      const toCancel = Math.min(Math.floor(ordersInDepthZone.length * 0.3), 3);
      for (let i = 0; i < toCancel; i++) {
        if (ordersInDepthZone[i]) {
          adjustments.ordersToCancel.push(ordersInDepthZone[i].orderId);
          adjustments.reason.push(`Reducing excess depth - cancelling order at $${ordersInDepthZone[i].price}`);
        }
      }
    }

    return adjustments;
  }

  // Helper to chunk array into smaller batches
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

export default XtSellLiquidityBotMonitor;
