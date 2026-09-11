// migration-backfill-platform-fee.js
// Run once: node migration-backfill-platform-fee.js

const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function migrate() {
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.l6latif.mongodb.net/?appName=Cluster0`;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('EdCare');
    const paymentCollection = db.collection('payments');

    const result = await paymentCollection.updateMany(
      { platformFeePercentage: { $exists: false } },
      { $set: { platformFeePercentage: 0.10 } } // the rate active before this feature was added
    );

    console.log(`Backfilled platformFeePercentage on ${result.modifiedCount} existing payment(s).`);
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await client.close();
  }
}

migrate();