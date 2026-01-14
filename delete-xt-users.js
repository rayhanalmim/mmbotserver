import 'dotenv/config';
import { MongoClient } from 'mongodb';
import readline from 'readline';

const MONGODB_URI = process.env.MONGODB_URI;
const COLLECTION_NAME = 'xt_users';

// Create readline interface for user confirmation
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function deleteAllXtUsers() {
  let client;
  
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is not set');
    }

    console.log('🔌 Connecting to MongoDB...');
    console.log(`📍 URI: ${MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')}`); // Hide password in logs
    console.log(`📂 Collection: ${COLLECTION_NAME}`);
    console.log('');
    
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connected to MongoDB\n');
    
    // Explicitly specify the database name (same as in index.js)
    const db = client.db('mmbot');
    const collection = db.collection(COLLECTION_NAME);
    
    // Count existing documents
    const count = await collection.countDocuments();
    console.log(`📊 Found ${count} document(s) in ${COLLECTION_NAME} collection\n`);
    
    if (count === 0) {
      console.log('ℹ️  Collection is already empty. Nothing to delete.');
      rl.close();
      return;
    }
    
    // Show sample documents
    const samples = await collection.find().limit(3).toArray();
    console.log('📄 Sample documents:');
    samples.forEach((doc, i) => {
      console.log(`   ${i + 1}. ID: ${doc._id}, mexcUserId: ${doc.mexcUserId || 'N/A'}`);
    });
    console.log('');
    
    // Ask for confirmation
    rl.question(`⚠️  WARNING: This will DELETE ALL ${count} document(s) from the ${COLLECTION_NAME} collection!\n   This action CANNOT be undone!\n\n   Type 'DELETE' to confirm: `, async (answer) => {
      if (answer.trim() === 'DELETE') {
        try {
          console.log('\n🗑️  Deleting all documents...');
          const result = await collection.deleteMany({});
          console.log(`✅ Successfully deleted ${result.deletedCount} document(s) from ${COLLECTION_NAME}`);
          
          // Verify deletion
          const remainingCount = await collection.countDocuments();
          console.log(`📊 Remaining documents: ${remainingCount}`);
          
          if (remainingCount === 0) {
            console.log('✨ Collection is now empty!');
          } else {
            console.log('⚠️  Warning: Some documents may still remain');
          }
        } catch (error) {
          console.error('❌ Error during deletion:', error.message);
        }
      } else {
        console.log('\n❌ Deletion cancelled. No changes were made.');
      }
      
      rl.close();
      if (client) {
        await client.close();
        console.log('\n🔌 Disconnected from MongoDB');
      }
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    rl.close();
    if (client) {
      await client.close();
    }
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n❌ Operation cancelled by user');
  rl.close();
  process.exit(0);
});

// Run the script
deleteAllXtUsers();
