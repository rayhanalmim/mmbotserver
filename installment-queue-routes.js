/**
 * Installment Queue Routes
 * Handles delayed token distribution with server-side queue processing
 */

import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';

export function setupInstallmentQueueRoutes(app, db, verifyMexcToken) {
  
  // POST /api/installment/queue/create - Create a new transfer queue
  app.post('/api/installment/queue/create', verifyMexcToken, async (req, res) => {
    try {
      const {
        fileName,
        adminAddress,
        tokenAddress,
        delayMinSeconds,
        delayMaxSeconds,
        recipients
      } = req.body;

      // Validate required fields
      if (!adminAddress || !tokenAddress || !recipients || !Array.isArray(recipients)) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'Missing required fields: adminAddress, tokenAddress, recipients', 
          data: null 
        });
      }

      if (recipients.length === 0) {
        return res.status(400).json({ 
          code: '-1', 
          msg: 'Recipients array cannot be empty', 
          data: null 
        });
      }

      // Validate delay range (5-60 seconds)
      const minDelay = Math.max(5, Math.min(60, parseInt(delayMinSeconds) || 5));
      const maxDelay = Math.max(minDelay, Math.min(60, parseInt(delayMaxSeconds) || 15));

      // Calculate total amount
      const totalAmount = recipients.reduce((sum, r) => sum + parseFloat(r.amount), 0);

      // Create queue record
      const queueId = uuidv4();
      const queue = {
        queueId,
        mexcUserId: req.mexcUser.id,
        fileName: fileName || 'unknown',
        adminAddress: adminAddress.toLowerCase(),
        tokenAddress: tokenAddress.toLowerCase(),
        totalAmount,
        totalRecipients: recipients.length,
        delayMinSeconds: minDelay,
        delayMaxSeconds: maxDelay,
        status: 'pending', // pending, processing, completed, failed, cancelled
        processedCount: 0,
        successCount: 0,
        failedCount: 0,
        currentIndex: 0,
        lastProcessedAt: null,
        startedAt: null,
        completedAt: null,
        error: null,
        recipients: recipients.map((r, index) => ({
          index,
          address: r.address.toLowerCase(),
          amount: parseFloat(r.amount),
          status: 'pending', // pending, processing, success, failed
          txHash: null,
          processedAt: null,
          error: null,
          retryCount: 0
        })),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await db.collection('transfer_queues').insertOne(queue);

      console.log(`📋 Queue created: ${queueId} - ${recipients.length} recipients, ${minDelay}-${maxDelay}s delay range`);

      res.json({
        code: '0',
        msg: 'Transfer queue created successfully',
        data: { 
          queueId,
          totalRecipients: recipients.length,
          totalAmount,
          delayMinSeconds: minDelay,
          delayMaxSeconds: maxDelay,
          estimatedTime: `${Math.ceil((recipients.length * minDelay) / 60)} - ${Math.ceil((recipients.length * maxDelay) / 60)} minutes`
        }
      });

    } catch (error) {
      console.error('Error creating transfer queue:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to create transfer queue', 
        data: null 
      });
    }
  });

  // GET /api/installment/queue/config - Get server wallet address for approval
  // IMPORTANT: This route MUST be defined BEFORE /:queueId to avoid "config" being matched as a queueId
  app.get('/api/installment/queue/config', verifyMexcToken, async (req, res) => {
    try {
      const serverWalletAddress = process.env.SERVER_WALLET_ADDRESS;
      
      if (!serverWalletAddress) {
        return res.status(500).json({ 
          code: '-1', 
          msg: 'Server wallet not configured', 
          data: null 
        });
      }

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          serverWalletAddress,
          minDelaySeconds: 10,
          maxDelaySeconds: 60,
          defaultDelaySeconds: 15
        }
      });

    } catch (error) {
      console.error('Error fetching queue config:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch queue config', 
        data: null 
      });
    }
  });

  // POST /api/installment/queue/gas-estimate - Get gas estimation for transfers
  // IMPORTANT: This route MUST be defined BEFORE /:queueId
  app.post('/api/installment/queue/gas-estimate', verifyMexcToken, async (req, res) => {
    try {
      const { recipientCount } = req.body;

      if (!recipientCount || recipientCount < 1) {
        return res.status(400).json({
          code: '-1',
          msg: 'Invalid recipient count',
          data: null
        });
      }

      // Initialize provider
      const rpcUrl = process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545';
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const serverWalletAddress = process.env.SERVER_WALLET_ADDRESS;

      if (!serverWalletAddress) {
        return res.status(500).json({
          code: '-1',
          msg: 'Server wallet not configured',
          data: null
        });
      }

      // Get current gas price and server wallet balance
      const [feeData, serverBalance] = await Promise.all([
        provider.getFeeData(),
        provider.getBalance(serverWalletAddress)
      ]);

      const currentGasPrice = feeData.gasPrice;
      const serverBalanceBNB = parseFloat(ethers.formatEther(serverBalance));

      // ERC20 transferFrom typically uses ~65000 gas
      const gasPerTransfer = 65000n;
      const totalGasUnits = gasPerTransfer * BigInt(recipientCount);

      // Calculate gas costs for different scenarios
      // Normal: current gas price
      // Moderate: 1.5x current gas price  
      // Critical: 3x current gas price (network congestion)
      const normalGasPrice = currentGasPrice;
      const moderateGasPrice = (currentGasPrice * 150n) / 100n;
      const criticalGasPrice = (currentGasPrice * 300n) / 100n;

      const normalCostWei = totalGasUnits * normalGasPrice;
      const moderateCostWei = totalGasUnits * moderateGasPrice;
      const criticalCostWei = totalGasUnits * criticalGasPrice;

      const normalCostBNB = parseFloat(ethers.formatEther(normalCostWei));
      const moderateCostBNB = parseFloat(ethers.formatEther(moderateCostWei));
      const criticalCostBNB = parseFloat(ethers.formatEther(criticalCostWei));

      // Fetch BNB price from Binance API
      let bnbPriceUSDT = 0;
      try {
        const priceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
        const priceData = await priceResponse.json();
        bnbPriceUSDT = parseFloat(priceData.price) || 0;
      } catch (e) {
        console.error('Failed to fetch BNB price:', e.message);
        // Use fallback price
        bnbPriceUSDT = 300;
      }

      // Calculate USDT values
      const serverBalanceUSDT = serverBalanceBNB * bnbPriceUSDT;
      const normalCostUSDT = normalCostBNB * bnbPriceUSDT;
      const moderateCostUSDT = moderateCostBNB * bnbPriceUSDT;
      const criticalCostUSDT = criticalCostBNB * bnbPriceUSDT;

      // Check if server wallet has enough for critical scenario
      const hasSufficientGas = serverBalanceBNB >= criticalCostBNB;
      // Add 10% safety margin
      const hasSufficientGasWithMargin = serverBalanceBNB >= (criticalCostBNB * 1.1);

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          recipientCount,
          gasPerTransfer: Number(gasPerTransfer),
          totalGasUnits: Number(totalGasUnits),
          currentGasPriceGwei: parseFloat(ethers.formatUnits(currentGasPrice, 'gwei')).toFixed(2),
          gasEstimates: {
            normal: {
              label: 'Normal',
              gasPriceGwei: parseFloat(ethers.formatUnits(normalGasPrice, 'gwei')).toFixed(2),
              costBNB: normalCostBNB.toFixed(6),
              costUSDT: normalCostUSDT.toFixed(2)
            },
            moderate: {
              label: 'Moderate',
              gasPriceGwei: parseFloat(ethers.formatUnits(moderateGasPrice, 'gwei')).toFixed(2),
              costBNB: moderateCostBNB.toFixed(6),
              costUSDT: moderateCostUSDT.toFixed(2)
            },
            critical: {
              label: 'Critical',
              gasPriceGwei: parseFloat(ethers.formatUnits(criticalGasPrice, 'gwei')).toFixed(2),
              costBNB: criticalCostBNB.toFixed(6),
              costUSDT: criticalCostUSDT.toFixed(2)
            }
          },
          serverWallet: {
            address: serverWalletAddress,
            balanceBNB: serverBalanceBNB.toFixed(6),
            balanceUSDT: serverBalanceUSDT.toFixed(2)
          },
          bnbPriceUSDT: bnbPriceUSDT.toFixed(2),
          hasSufficientGas,
          hasSufficientGasWithMargin
        }
      });

    } catch (error) {
      console.error('Error estimating gas:', error);
      res.status(500).json({
        code: '-1',
        msg: 'Failed to estimate gas: ' + error.message,
        data: null
      });
    }
  });

  // GET /api/installment/queue/list - List all queues
  // IMPORTANT: This route MUST be defined BEFORE /:queueId to avoid "list" being matched as a queueId
  app.get('/api/installment/queue/list', verifyMexcToken, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const queues = await db.collection('transfer_queues')
        .find({ mexcUserId: req.mexcUser.id })
        .project({
          queueId: 1,
          fileName: 1,
          adminAddress: 1,
          totalAmount: 1,
          totalRecipients: 1,
          delayMinSeconds: 1,
          delayMaxSeconds: 1,
          status: 1,
          processedCount: 1,
          successCount: 1,
          failedCount: 1,
          startedAt: 1,
          completedAt: 1,
          createdAt: 1
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const total = await db.collection('transfer_queues')
        .countDocuments({ mexcUserId: req.mexcUser.id });

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          queues,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          }
        }
      });

    } catch (error) {
      console.error('Error listing queues:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to list queues', 
        data: null 
      });
    }
  });

  // GET /api/installment/queue/:queueId - Get queue status
  app.get('/api/installment/queue/:queueId', verifyMexcToken, async (req, res) => {
    try {
      const { queueId } = req.params;

      const queue = await db.collection('transfer_queues').findOne({
        queueId,
        mexcUserId: req.mexcUser.id
      });

      if (!queue) {
        return res.status(404).json({ 
          code: '-1', 
          msg: 'Queue not found', 
          data: null 
        });
      }

      // Calculate progress
      const minDelay = queue.delayMinSeconds || 5;
      const maxDelay = queue.delayMaxSeconds || 15;
      const progress = {
        queueId: queue.queueId,
        status: queue.status,
        totalRecipients: queue.totalRecipients,
        processedCount: queue.processedCount,
        successCount: queue.successCount,
        failedCount: queue.failedCount,
        pendingCount: queue.totalRecipients - queue.processedCount,
        currentIndex: queue.currentIndex,
        delayMinSeconds: minDelay,
        delayMaxSeconds: maxDelay,
        lastProcessedAt: queue.lastProcessedAt,
        startedAt: queue.startedAt,
        completedAt: queue.completedAt,
        error: queue.error,
        // Calculate next transfer time (use max delay for estimation)
        nextTransferIn: queue.status === 'processing' && queue.lastProcessedAt 
          ? Math.max(0, maxDelay - Math.floor((Date.now() - new Date(queue.lastProcessedAt).getTime()) / 1000))
          : null,
        // Return recent recipients (last 10 processed + next 5 pending)
        recentRecipients: queue.recipients
          .filter(r => r.status !== 'pending' || r.index < queue.currentIndex + 5)
          .slice(-15)
          .map(r => ({
            index: r.index,
            address: r.address,
            amount: r.amount,
            status: r.status,
            txHash: r.txHash,
            processedAt: r.processedAt,
            error: r.error
          }))
      };

      res.json({
        code: '0',
        msg: 'Success',
        data: progress
      });

    } catch (error) {
      console.error('Error fetching queue status:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch queue status', 
        data: null 
      });
    }
  });

  // POST /api/installment/queue/:queueId/cancel - Cancel a queue
  app.post('/api/installment/queue/:queueId/cancel', verifyMexcToken, async (req, res) => {
    try {
      const { queueId } = req.params;

      const result = await db.collection('transfer_queues').updateOne(
        {
          queueId,
          mexcUserId: req.mexcUser.id,
          status: { $in: ['pending', 'processing'] }
        },
        {
          $set: {
            status: 'cancelled',
            updatedAt: new Date(),
            completedAt: new Date()
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ 
          code: '-1', 
          msg: 'Queue not found or already completed', 
          data: null 
        });
      }

      console.log(`🚫 Queue cancelled: ${queueId}`);

      res.json({
        code: '0',
        msg: 'Queue cancelled successfully',
        data: { queueId }
      });

    } catch (error) {
      console.error('Error cancelling queue:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to cancel queue', 
        data: null 
      });
    }
  });

  // POST /api/installment/queue/:queueId/pause - Pause a queue
  app.post('/api/installment/queue/:queueId/pause', verifyMexcToken, async (req, res) => {
    try {
      const { queueId } = req.params;

      const result = await db.collection('transfer_queues').updateOne(
        {
          queueId,
          mexcUserId: req.mexcUser.id,
          status: 'processing'
        },
        {
          $set: {
            status: 'paused',
            updatedAt: new Date()
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ 
          code: '-1', 
          msg: 'Queue not found or not processing', 
          data: null 
        });
      }

      console.log(`⏸️ Queue paused: ${queueId}`);

      res.json({
        code: '0',
        msg: 'Queue paused successfully',
        data: { queueId }
      });

    } catch (error) {
      console.error('Error pausing queue:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to pause queue', 
        data: null 
      });
    }
  });

  // POST /api/installment/queue/:queueId/resume - Resume a paused queue
  app.post('/api/installment/queue/:queueId/resume', verifyMexcToken, async (req, res) => {
    try {
      const { queueId } = req.params;

      const result = await db.collection('transfer_queues').updateOne(
        {
          queueId,
          mexcUserId: req.mexcUser.id,
          status: 'paused'
        },
        {
          $set: {
            status: 'pending',
            updatedAt: new Date()
          }
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ 
          code: '-1', 
          msg: 'Queue not found or not paused', 
          data: null 
        });
      }

      console.log(`▶️ Queue resumed: ${queueId}`);

      res.json({
        code: '0',
        msg: 'Queue resumed successfully',
        data: { queueId }
      });

    } catch (error) {
      console.error('Error resuming queue:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to resume queue', 
        data: null 
      });
    }
  });

  // GET /api/installment/queue/:queueId/recipients - Get all recipients with their status
  app.get('/api/installment/queue/:queueId/recipients', verifyMexcToken, async (req, res) => {
    try {
      const { queueId } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      const queue = await db.collection('transfer_queues').findOne({
        queueId,
        mexcUserId: req.mexcUser.id
      });

      if (!queue) {
        return res.status(404).json({ 
          code: '-1', 
          msg: 'Queue not found', 
          data: null 
        });
      }

      const recipients = queue.recipients
        .slice(skip, skip + limit)
        .map(r => ({
          index: r.index,
          address: r.address,
          amount: r.amount,
          status: r.status,
          txHash: r.txHash,
          processedAt: r.processedAt,
          error: r.error
        }));

      res.json({
        code: '0',
        msg: 'Success',
        data: {
          recipients,
          pagination: {
            page,
            limit,
            total: queue.recipients.length,
            totalPages: Math.ceil(queue.recipients.length / limit)
          }
        }
      });

    } catch (error) {
      console.error('Error fetching queue recipients:', error);
      res.status(500).json({ 
        code: '-1', 
        msg: 'Failed to fetch queue recipients', 
        data: null 
      });
    }
  });

  console.log('✅ Installment queue routes initialized');
}
