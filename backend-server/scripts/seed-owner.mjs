#!/usr/bin/env node
/**
 * Crea el primer Owner en una instalación nueva.
 *
 * El registro público exige una licencia, así que una base vacía no tiene
 * forma de entrar al panel. Este script es el bootstrap: se ejecuta una vez,
 * después de compilar, con las variables OWNER_* en el entorno.
 *
 * Uso:
 *   OWNER_USERNAME=owner OWNER_PASSWORD='...' npm run seed:owner
 *   OWNER_USERNAME=owner OWNER_PASSWORD='...' npm run seed:owner -- --dry-run
 *
 * No imprime la contraseña. Si ya existe un Owner, no toca nada.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const User = require('../dist/models/User.js').default;

const dryRun = process.argv.includes('--dry-run');
const uri = process.env.MONGODB_URI;
const username = (process.env.OWNER_USERNAME || '').trim().toLowerCase();
const password = process.env.OWNER_PASSWORD || '';
const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const name = (process.env.OWNER_NAME || 'Owner').trim();

function fail(message) {
  console.error(`[seed-owner] ${message}`);
  process.exit(1);
}

if (!uri) fail('Falta MONGODB_URI.');
if (!/^[a-z0-9_]{3,30}$/.test(username)) {
  fail('OWNER_USERNAME debe tener 3-30 caracteres: letras, números o guion bajo.');
}
if (password.length < 12) {
  fail('OWNER_PASSWORD debe tener al menos 12 caracteres.');
}
if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  fail('OWNER_EMAIL no es una dirección válida.');
}
if (name.length < 2 || name.length > 100) {
  fail('OWNER_NAME debe tener entre 2 y 100 caracteres.');
}

try {
  await mongoose.connect(uri);

  const existingOwner = await User.findOne({ role: 'owner' }).lean();
  if (existingOwner) {
    console.log(
      `[seed-owner] Ya existe un Owner (${existingOwner.username || existingOwner.email || existingOwner._id}). No se crea otro.`,
    );
    process.exit(0);
  }

  const duplicate = await User.findOne({
    $or: [{ username }, ...(email ? [{ email }] : [])],
  }).lean();
  if (duplicate) {
    fail('Ya existe un usuario con ese username o email.');
  }

  if (dryRun) {
    console.log(`[seed-owner] Dry-run: se crearía el Owner "${username}". No se escribió nada.`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const owner = await User.create({
    name,
    username,
    email: email || undefined,
    passwordHash,
    role: 'owner',
    isAdmin: true,
    plan: 'phantom',
    isLifetime: true,
    planExpiresAt: null,
    twoFactorEnabled: false,
    passwordChangedAt: new Date(),
  });

  console.log(`[seed-owner] Owner creado: ${owner.username}. Cambia la contraseña tras el primer login.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await mongoose.disconnect().catch(() => {});
}
