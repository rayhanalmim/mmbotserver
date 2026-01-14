import 'dotenv/config';

/**
 * Telegram Service specifically for MEXC User Bot notifications
 * Uses TELEGRAM_BOT_TOKEN_MEXC for order notifications
 * Uses TELEGRAM_BOT_TOKEN_BALANCE for low balance warnings
 */
class MexcTelegramService {
  constructor() {
    // MEXC User Bot notifications token
    this.mexcBotToken = process.env.TELEGRAM_BOT_TOKEN_MEXC;
    this.mexcChatId = process.env.TELEGRAM_CHAT_ID;
    
    // Balance warning notifications token
    this.balanceBotToken = process.env.TELEGRAM_BOT_TOKEN_BALANCE;
    this.balanceChatId = process.env.TELEGRAM_CHAT_ID;
    
    // Low balance threshold in USDT
    this.lowBalanceThreshold = 50;
  }

  isMexcBotConfigured() {
    return !!(this.mexcBotToken && this.mexcChatId);
  }

  isBalanceBotConfigured() {
    return !!(this.balanceBotToken && this.balanceChatId);
  }

  async sendMexcNotification(message, options = {}) {
    if (!this.isMexcBotConfigured()) {
      console.warn('⚠️ MEXC Telegram bot not configured. Skipping notification.');
      return { success: false, error: 'MEXC Telegram bot not configured' };
    }

    try {
      const payload = {
        chat_id: this.mexcChatId,
        text: message,
        parse_mode: options.parseMode || 'HTML',
        disable_notification: options.silent || false,
        ...options
      };

      const response = await fetch(`https://api.telegram.org/bot${this.mexcBotToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.ok) {
        console.log('✅ MEXC Telegram notification sent successfully');
        return { success: true, data };
      } else {
        console.error('❌ MEXC Telegram API error:', data.description);
        return { success: false, error: data.description };
      }
    } catch (error) {
      console.error('❌ Error sending MEXC Telegram message:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendBalanceWarning(message, options = {}) {
    if (!this.isBalanceBotConfigured()) {
      console.warn('⚠️ Balance Telegram bot not configured. Skipping notification.');
      return { success: false, error: 'Balance Telegram bot not configured' };
    }

    try {
      const payload = {
        chat_id: this.balanceChatId,
        text: message,
        parse_mode: options.parseMode || 'HTML',
        disable_notification: options.silent || false,
        ...options
      };

      const response = await fetch(`https://api.telegram.org/bot${this.balanceBotToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.ok) {
        console.log('✅ Balance warning notification sent successfully');
        return { success: true, data };
      } else {
        console.error('❌ Balance Telegram API error:', data.description);
        return { success: false, error: data.description };
      }
    } catch (error) {
      console.error('❌ Error sending balance warning:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Format and send MEXC User Bot order notification
   */
  async notifyMexcUserBotOrder(data) {
    const {
      botName,
      symbol,
      orderAmount,
      marketPrice,
      bestAskPrice,
      priceGap,
      balances,
      orderId,
      status = 'success'
    } = data;

    const statusEmoji = status === 'success' ? '✅' : '❌';
    const gcbBalance = balances?.GCB ? parseFloat(balances.GCB.free).toFixed(2) : '0.00';
    const usdtBalance = balances?.USDT ? parseFloat(balances.USDT.free).toFixed(2) : '0.00';

    let message = `<b>🔄 MEXC User Bot Order ${statusEmoji}</b>\n\n`;
    message += `🤖 <b>Bot:</b> ${botName}\n`;
    message += `💱 <b>Symbol:</b> ${symbol}\n`;
    message += `💵 <b>Order Amount:</b> $${orderAmount} USDT\n`;
    message += `📊 <b>Market Price:</b> $${marketPrice.toFixed(6)}\n`;
    message += `🎯 <b>Best Ask:</b> $${bestAskPrice.toFixed(6)}\n`;
    message += `📈 <b>Price Gap:</b> ${priceGap.toFixed(2)}%\n\n`;
    message += `💰 <b>Balance:</b>\n`;
    message += `   • GCB: ${gcbBalance}\n`;
    message += `   • USDT: ${usdtBalance}\n\n`;
    message += `⏰ <b>Time:</b> ${new Date().toUTCString()}`;

    if (orderId) {
      message += `\n🔢 <b>Order ID:</b> ${orderId}`;
    }

    return await this.sendMexcNotification(message);
  }

  /**
   * Check balance and send warning if below threshold
   */
  async checkAndNotifyLowBalance(data) {
    const {
      botName,
      userId,
      usdtBalance,
      gcbBalance = 0,
      symbol = 'GCBUSDT'
    } = data;

    const usdtAmount = parseFloat(usdtBalance) || 0;

    if (usdtAmount < this.lowBalanceThreshold) {
      const message = `<b>⚠️ LOW BALANCE WARNING</b>\n\n` +
        `🤖 <b>Bot:</b> ${botName}\n` +
        `💱 <b>Symbol:</b> ${symbol}\n\n` +
        `💰 <b>Current Balance:</b>\n` +
        `   • USDT: $${usdtAmount.toFixed(2)} ⚠️\n` +
        `   • GCB: ${parseFloat(gcbBalance).toFixed(2)}\n\n` +
        `📉 <b>Threshold:</b> $${this.lowBalanceThreshold} USDT\n\n` +
        `⚠️ Please top up your account to ensure the bot can continue trading.\n\n` +
        `⏰ <b>Time:</b> ${new Date().toUTCString()}`;

      return await this.sendBalanceWarning(message);
    }

    return { success: true, belowThreshold: false };
  }

  /**
   * Send test notification to MEXC bot
   */
  async sendTestMexcNotification() {
    const message = `<b>🧪 MEXC User Bot Test Notification</b>\n\n` +
      `✅ MEXC Telegram bot integration is working correctly!\n` +
      `⏰ Time (UTC): ${new Date().toUTCString()}`;
    
    return await this.sendMexcNotification(message);
  }

  /**
   * Send test notification to Balance bot
   */
  async sendTestBalanceNotification() {
    const message = `<b>🧪 Balance Bot Test Notification</b>\n\n` +
      `✅ Balance warning Telegram bot integration is working correctly!\n` +
      `⏰ Time (UTC): ${new Date().toUTCString()}`;
    
    return await this.sendBalanceWarning(message);
  }
}

// Export singleton instance
const mexcTelegramService = new MexcTelegramService();
export default mexcTelegramService;
