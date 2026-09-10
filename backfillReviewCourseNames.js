require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

async function backfill() {
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.l6latif.mongodb.net/?appName=Cluster0`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('EdCare');
  const reviewsCollection = db.collection('reviews');
  const classCollection = db.collection('classes');

  const reviewsMissingName = await reviewsCollection.find({
    $or: [{ courseName: { $exists: false } }, { courseName: '' }]
  }).toArray();

  // console.log(`Found ${reviewsMissingName.length} reviews needing courseName.`);

  for (const review of reviewsMissingName) {
    if (!ObjectId.isValid(review.classId)) continue;
    const course = await classCollection.findOne({ _id: new ObjectId(review.classId) });
    if (course) {
      await reviewsCollection.updateOne(
        { _id: review._id },
        { $set: { courseName: course.title || 'Course' } }
      );
      // console.log(`✓ Patched review ${review._id} → ${course.title}`);
    } else {
      // console.log(`✗ Skipped ${review._id} (class not found)`);
    }
  }

  // console.log('Backfill complete.');
  await client.close();
}

backfill();