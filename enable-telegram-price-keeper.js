import { MongoClient } from 'mongodb';
import 'dotenv/config';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'gcbex_bot';

async function enableTelegram() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');
    
    const db = client.db(DB_NAME);
    
    // Update all price keeper bots to enable Telegram
    const result = await db.collection('price_keeper_bots').updateMany(
      {},
      { 
        $set: { 
          telegramEnabled: true,
          updatedAt: new Date()
        } 
      }
    );
    
    console.log(`✅ Updated ${result.modifiedCount} Price Keeper bot(s) to enable Telegram`);
    
    // Show updated bots
    const bots = await db.collection('price_keeper_bots').find({}).toArray();
    console.log('\n📋 Current Price Keeper Bots:');
    bots.forEach(bot => {
      console.log(`  - ${bot.name}: Telegram ${bot.telegramEnabled ? '✅ Enabled' : '❌ Disabled'}`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await client.close();
    console.log('\n✅ Done');
  }
}

enableTelegram();
