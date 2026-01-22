/**
 * Installment Queue Worker
 * Background process that handles delayed token transfers
 * Uses server wallet to call transferFrom on behalf of admin
 */

import { ethers } from 'ethers';

// ERC20 ABI for transferFrom
const ERC20_ABI = [
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

class InstallmentQueueWorker {
  constructor(db) {
    this.db = db;
    this.isRunning = false;
    this.currentQueueId = null;
    this.provider = null;
    this.wallet = null;
    this.checkInterval = 5000; // Check for new queues every 5 seconds
    this.intervalId = null;
  }

  async initialize() {
    // Get RPC URL and private key from environment
    const rpcUrl = process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545';
    const privateKey = process.env.SERVER_WALLET_PRIVATE_KEY;

    if (!privateKey) {
      console.error('❌ SERVER_WALLET_PRIVATE_KEY not set - Queue worker disabled');
      return false;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      this.wallet = new ethers.Wallet(privateKey, this.provider);
      
      const balance = await this.provider.getBalance(this.wallet.address);
      console.log(`🔑 Queue worker initialized`);
      console.log(`   Wallet: ${this.wallet.address}`);
      console.log(`   Balance: ${ethers.formatEther(balance)} BNB`);
      console.log(`   RPC: ${rpcUrl}`);
      
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize queue worker:', error.message);
      return false;
    }
  }

  start() {
    if (this.intervalId) {
      console.log('⚠️ Queue worker already running');
      return;
    }

    console.log('🚀 Starting queue worker...');
    this.intervalId = setInterval(() => this.checkAndProcessQueues(), this.checkInterval);
    
    // Run immediately
    this.checkAndProcessQueues();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 Queue worker stopped');
    }
  }

  async checkAndProcessQueues() {
    // Skip if already processing a queue
    if (this.isRunning) {
      return;
    }

    try {
      // Find a pending queue
      const queue = await this.db.collection('transfer_queues').findOne({
        status: 'pending'
      }, {
        sort: { createdAt: 1 } // Process oldest first
      });

      if (queue) {
        await this.processQueue(queue);
      }
    } catch (error) {
      console.error('Error checking queues:', error.message);
    }
  }

  async processQueue(queue) {
    this.isRunning = true;
    this.currentQueueId = queue.queueId;
    
    console.log(`\n📦 Processing queue: ${queue.queueId}`);
    console.log(`   Recipients: ${queue.totalRecipients}`);
    console.log(`   Delay range: ${queue.delayMinSeconds || 5}s - ${queue.delayMaxSeconds || 15}s`);
    console.log(`   Admin: ${queue.adminAddress}`);

    try {
      // Update queue status to processing
      await this.db.collection('transfer_queues').updateOne(
        { queueId: queue.queueId },
        {
          $set: {
            status: 'processing',
            startedAt: queue.startedAt || new Date(),
            updatedAt: new Date()
          }
        }
      );

      // Create token contract instance
      const tokenContract = new ethers.Contract(queue.tokenAddress, ERC20_ABI, this.wallet);

      // Get token info
      const [decimals, symbol] = await Promise.all([
        tokenContract.decimals(),
        tokenContract.symbol()
      ]);

      // Check allowance
      const allowance = await tokenContract.allowance(queue.adminAddress, this.wallet.address);
      const totalNeeded = ethers.parseUnits(queue.totalAmount.toString(), decimals);
      
      if (allowance < totalNeeded) {
        throw new Error(`Insufficient allowance. Need ${queue.totalAmount} ${symbol}, have ${ethers.formatUnits(allowance, decimals)}`);
      }

      console.log(`   Token: ${symbol} (${decimals} decimals)`);
      console.log(`   Allowance: ${ethers.formatUnits(allowance, decimals)} ${symbol}`);

      // Process each recipient starting from currentIndex
      for (let i = queue.currentIndex; i < queue.recipients.length; i++) {
        // Check if queue was cancelled or paused
        const currentQueue = await this.db.collection('transfer_queues').findOne({
          queueId: queue.queueId
        });

        if (currentQueue.status === 'cancelled') {
          console.log(`   🚫 Queue cancelled`);
          break;
        }

        if (currentQueue.status === 'paused') {
          console.log(`   ⏸️ Queue paused at index ${i}`);
          this.isRunning = false;
          this.currentQueueId = null;
          return;
        }

        const recipient = queue.recipients[i];
        
        // Skip already processed recipients
        if (recipient.status === 'success') {
          continue;
        }

        console.log(`   [${i + 1}/${queue.totalRecipients}] Sending ${recipient.amount} ${symbol} to ${recipient.address.slice(0, 10)}...`);

        try {
          // Update recipient status to processing
          await this.updateRecipientStatus(queue.queueId, i, 'processing', null, null);

          // Convert amount to wei
          const amountWei = ethers.parseUnits(recipient.amount.toString(), decimals);

          // Execute transferFrom
          const tx = await tokenContract.transferFrom(
            queue.adminAddress,
            recipient.address,
            amountWei
          );

          console.log(`      TX: ${tx.hash}`);

          // Wait for confirmation
          const receipt = await tx.wait();

          if (receipt.status === 1) {
            // Success
            await this.updateRecipientStatus(queue.queueId, i, 'success', tx.hash, null);
            await this.updateQueueProgress(queue.queueId, i + 1, true);
            console.log(`      ✅ Confirmed in block ${receipt.blockNumber}`);
          } else {
            // Transaction failed
            await this.updateRecipientStatus(queue.queueId, i, 'failed', tx.hash, 'Transaction reverted');
            await this.updateQueueProgress(queue.queueId, i + 1, false);
            console.log(`      ❌ Transaction reverted`);
          }

        } catch (txError) {
          const errorMessage = txError.message.slice(0, 200);
          await this.updateRecipientStatus(queue.queueId, i, 'failed', null, errorMessage);
          await this.updateQueueProgress(queue.queueId, i + 1, false);
          console.log(`      ❌ Error: ${errorMessage.slice(0, 50)}`);
          
          // Check if it's a critical error (insufficient allowance, etc.)
          if (errorMessage.includes('insufficient allowance') || 
              errorMessage.includes('transfer amount exceeds balance')) {
            console.log(`   🛑 Critical error - stopping queue`);
            await this.db.collection('transfer_queues').updateOne(
              { queueId: queue.queueId },
              {
                $set: {
                  status: 'failed',
                  error: errorMessage,
                  completedAt: new Date(),
                  updatedAt: new Date()
                }
              }
            );
            break;
          }
        }

        // Wait for delay before next transfer (unless it's the last one)
        if (i < queue.recipients.length - 1) {
          // Check again if cancelled during delay
          const checkQueue = await this.db.collection('transfer_queues').findOne({
            queueId: queue.queueId
          });
          
          if (checkQueue.status === 'cancelled' || checkQueue.status === 'paused') {
            break;
          }

          // Pick a random delay within the range
          const minDelay = queue.delayMinSeconds || 5;
          const maxDelay = queue.delayMaxSeconds || 15;
          const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
          console.log(`      ⏳ Waiting ${randomDelay}s (range: ${minDelay}-${maxDelay}s)...`);
          await this.sleep(randomDelay * 1000);
        }
      }

      // Check final status
      const finalQueue = await this.db.collection('transfer_queues').findOne({
        queueId: queue.queueId
      });

      if (finalQueue.status === 'processing') {
        // All done - mark as completed
        await this.db.collection('transfer_queues').updateOne(
          { queueId: queue.queueId },
          {
            $set: {
              status: 'completed',
              completedAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        console.log(`   ✅ Queue completed!`);
        console.log(`      Success: ${finalQueue.successCount}`);
        console.log(`      Failed: ${finalQueue.failedCount}`);
      }

    } catch (error) {
      console.error(`   ❌ Queue error: ${error.message}`);
      
      await this.db.collection('transfer_queues').updateOne(
        { queueId: queue.queueId },
        {
          $set: {
            status: 'failed',
            error: error.message.slice(0, 500),
            completedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );
    }

    this.isRunning = false;
    this.currentQueueId = null;
  }

  async updateRecipientStatus(queueId, index, status, txHash, error) {
    const update = {
      [`recipients.${index}.status`]: status,
      [`recipients.${index}.processedAt`]: new Date(),
      updatedAt: new Date()
    };

    if (txHash) {
      update[`recipients.${index}.txHash`] = txHash;
    }

    if (error) {
      update[`recipients.${index}.error`] = error;
    }

    await this.db.collection('transfer_queues').updateOne(
      { queueId },
      { $set: update }
    );
  }

  async updateQueueProgress(queueId, currentIndex, isSuccess) {
    const update = {
      currentIndex,
      lastProcessedAt: new Date(),
      updatedAt: new Date()
    };

    const inc = {
      processedCount: 1
    };

    if (isSuccess) {
      inc.successCount = 1;
    } else {
      inc.failedCount = 1;
    }

    await this.db.collection('transfer_queues').updateOne(
      { queueId },
      { 
        $set: update,
        $inc: inc
      }
    );
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      currentQueueId: this.currentQueueId,
      walletAddress: this.wallet?.address || null
    };
  }
}

// Export singleton factory
let workerInstance = null;

export async function createQueueWorker(db) {
  if (!workerInstance) {
    workerInstance = new InstallmentQueueWorker(db);
    const initialized = await workerInstance.initialize();
    if (initialized) {
      workerInstance.start();
    }
  }
  return workerInstance;
}

export function getQueueWorker() {
  return workerInstance;
}
