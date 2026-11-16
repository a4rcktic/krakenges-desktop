import mongoose from 'mongoose';
import { config } from './config';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export const connectDatabase = async (): Promise<void> => {
  try {
    await mongoose.connect(config.mongodbUri);
    logger.info(`MongoDB conectado a ${config.mongodbUri.replace(/\/\/.*@/, '//****@')}`);
  } catch (error) {
    logger.error({ err: error as Error }, 'Error conectando a MongoDB');
    process.exit(1);
  }
};
