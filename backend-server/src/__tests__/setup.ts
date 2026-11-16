import mongoose from 'mongoose';

beforeAll(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/krakenges-test';
  try {
    await mongoose.connect(uri);
  } catch {
    console.warn('MongoDB no disponible - tests de integracion saltados');
  }
});

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 1) return;
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});
