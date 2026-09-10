require('dotenv').config();
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generateCourseEmbedding(course) {
  const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const textToEmbed = [
    course.title, course.category, course.shortDescription,
    course.description,
    Array.isArray(course.objectives) ? course.objectives.join('. ') : ''
  ].filter(Boolean).join('. ');

  if (!textToEmbed.trim()) return null;
  const result = await model.embedContent(textToEmbed);
  return result.embedding.values;
}

async function backfill() {
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.l6latif.mongodb.net/?appName=Cluster0`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('EdCare');
  const classCollection = db.collection('classes');

  const coursesWithoutEmbedding = await classCollection.find({ embedding: { $exists: false } }).toArray();
  // console.log(`Found ${coursesWithoutEmbedding.length} courses needing embeddings.`);

  for (const course of coursesWithoutEmbedding) {
    const embedding = await generateCourseEmbedding(course);
    if (embedding) {
      await classCollection.updateOne({ _id: course._id }, { $set: { embedding } });
      // console.log(`✓ Embedded: ${course.title}`);
    } else {
      // console.log(`✗ Skipped (no content): ${course.title}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // gentle rate-limiting
  }

  console.log('Backfill complete.');
  await client.close();
}

backfill();