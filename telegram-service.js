import 'dotenv/config';

class TelegramService {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  isConfigured() {
    return !!(this.botToken && this.chatId);
  }

  async sendMessage(message, options = {}) {
    if (!this.isConfigured()) {
      console.warn('⚠️ Telegram not configured. Skipping notification.');
      return { success: false, error: 'Telegram not configured' };
    }

    try {
      const payload = {
        chat_id: this.chatId,
        text: message,
        parse_mode: options.parseMode || 'HTML',
        disable_notification: options.silent || false,
        ...options
      };

      const response = await fetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.ok) {
        console.log('✅ Telegram notification sent successfully');
        return { success: true, data };
      } else {
        console.error('❌ Telegram API error:', data.description);
        return { success: false, error: data.description };
      }
    } catch (error) {
      console.error('❌ Error sending Telegram message:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Format order notification for Conditional Bot
  formatConditionalBotNotification(data) {
    const {
      botName,
      conditionName,
      conditionOperator,
      conditionValue,
      orderType,
      side,
      symbol,
      volume,
      price,
      orderId,
      marketPrice,
      status,
      userId
    } = data;

    const emoji = {
      success: '✅',
      failed: '❌',
      BUY: '🟢',
      SELL: '🔴'
    };

    const operatorEmoji = {
      ABOVE: '⬆️',
      BELOW: '⬇️',
      EQUAL: '🟰',
      NOT_EQUAL: '≠'
    };

    const operatorText = {
      ABOVE: 'Above',
      BELOW: 'Below',
      EQUAL: 'Equal to',
      NOT_EQUAL: 'Not Equal to'
    };

    const statusEmoji = status === 'success' ? emoji.success : emoji.failed;
    const sideEmoji = emoji[side] || '💱';

    let message = `<b>${statusEmoji} Conditional Bot Order</b>\n\n`;
    message += `🤖 <b>Bot:</b> ${botName || 'Conditional Bot'}\n`;
    
    // User ID
    if (userId) {
      // message += `👤 <b>User ID:</b> ${userId}\n`;
    }
    
    // Enhanced condition display with operator
    if (conditionOperator && conditionValue) {
      const opEmoji = operatorEmoji[conditionOperator] || '📊';
      const opText = operatorText[conditionOperator] || conditionOperator;
      // message += `📋 <b>Condition:</b> ${conditionName}\n`;
      message += `${opEmoji} <b>Trigger:</b> GCB Price ${opText} $${conditionValue}\n`;
    } else {
      message += `📋 <b>Condition:</b> ${conditionName}\n`;
    }
    
    message += `${sideEmoji} <b>Action:</b> ${side} ${orderType}\n`;
    message += `💱 <b>Symbol:</b> ${symbol}\n`;
    message += `📊 <b>Volume:</b> ${volume}\n`;

    if (price && orderType === 'LIMIT') {
      message += `💰 <b>Price:</b> $${price}\n`;
    } else if (marketPrice) {
      message += `💰 <b>Market Price:</b> $${marketPrice}\n`;
    }

    if (orderId) {
      // message += `🔢 <b>Order ID:</b> ${orderId}\n`;
    }

    message += `⏰ <b>Time (UTC):</b> ${new Date().toUTCString()}\n`;

    if (status === 'failed' && data.error) {
      message += `\n❌ <b>Error:</b> ${data.error}`;
    }

    return message;
  }

  // Format order notification for Stabilizer Bot
  formatStabilizerBotNotification(data) {
    const {
      botName,
      symbol,
      orderNumber,
      totalOrders,
      usdtAmount,
      orderId,
      marketPrice,
      targetPrice,
      status,
      error,
      userId
    } = data;

    const emoji = {
      success: '✅',
      failed: '❌'
    };

    const statusEmoji = status === 'success' ? emoji.success : emoji.failed;

    let message = `<b>${statusEmoji} Stabilizer Bot Order</b>\n\n`;
    message += `🎯 <b>Bot:</b> ${botName || 'Price Stabilizer'}\n`;
    
    // User ID
    if (userId) {
      // message += `👤 <b>User ID:</b> ${userId}\n`;
    }
    
    message += `💱 <b>Symbol:</b> ${symbol}\n`;
    // message += `🔢 <b>Order:</b> ${orderNumber}/${totalOrders}\n`;
    message += `💵 <b>USDT Amount:</b> $${usdtAmount.toFixed(2)}\n`;
    message += `📊 <b>Market Price:</b> $${marketPrice.toFixed(6)}\n`;
    message += `🎯 <b>Target Price:</b> $${targetPrice.toFixed(6)}\n`;

    if (orderId) {
      // message += `🔢 <b>Order ID:</b> ${orderId}\n`;
    }

    message += `⏰ <b>Time (UTC):</b> ${new Date().toUTCString()}\n`;

    if (status === 'failed' && error) {
      message += `\n❌ <b>Error:</b> ${error}`;
    }

    return message;
  }

  // Send notification for Conditional Bot order
  async notifyConditionalBotOrder(orderData) {
    const message = this.formatConditionalBotNotification(orderData);
    return await this.sendMessage(message);
  }

  // Send notification for Stabilizer Bot order
  async notifyStabilizerBotOrder(orderData) {
    const message = this.formatStabilizerBotNotification(orderData);
    return await this.sendMessage(message);
  }

  // Send custom notification
  async notify(message, options = {}) {
    return await this.sendMessage(message, options);
  }

  // Test notification
  async sendTestNotification() {
    const message = `<b>🧪 Test Notification</b>\n\n` +
      `✅ Telegram integration is working correctly!\n` +
      `⏰ Time (UTC): ${new Date().toUTCString()}`;
    
    return await this.sendMessage(message);
  }
}

// Export singleton instance
const telegramService = new TelegramService();
export default telegramService;
