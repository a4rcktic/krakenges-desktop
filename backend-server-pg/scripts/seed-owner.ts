import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq, ilike, or } from 'drizzle-orm';
import { config } from '../src/config';
import { createPostgresDatabase } from '../src/db/client';
import { users } from '../src/db/schema';

/**
 * Crea el usuario Owner inicial.
 *
 * Uso:
 *   OWNER_PASSWORD='...' npm run seed:owner
 *
 * Variables:
 *   OWNER_NAME      (default: Owner)
 *   OWNER_USERNAME  (default: owner)
 *   OWNER_EMAIL     (opcional)
 *   OWNER_PASSWORD  (obligatoria, mínimo 8 caracteres)
 *
 * Es idempotente en el sentido de que no duplica: si el usuario ya existe,
 * termina sin tocarlo. Para rotar la contraseña del Owner, hazlo desde la API
 * de administración o con una consulta manual.
 */
async function main() {
  const name = (process.env.OWNER_NAME || 'Owner').trim();
  const username = (process.env.OWNER_USERNAME || 'owner').trim().toLowerCase();
  const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase() || null;
  const password = process.env.OWNER_PASSWORD || '';

  if (!password || password.length < 8) {
    console.error('OWNER_PASSWORD es obligatoria y debe tener al menos 8 caracteres.');
    process.exit(1);
  }
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    console.error('OWNER_USERNAME solo admite letras, números y guion bajo (3-30).');
    process.exit(1);
  }

  const handle = createPostgresDatabase(config.databaseUrl);
  try {
    const conditions = [ilike(users.username, username)];
    if (email) conditions.push(ilike(users.email, email));

    const [existing] = await handle.db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(or(...conditions))
      .limit(1);

    if (existing) {
      console.log(
        `Ya existe un usuario con ese nombre/correo (id=${existing.id}, username=${existing.username}). No se ha modificado nada.`,
      );
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [created] = await handle.db
      .insert(users)
      .values({
        name,
        username,
        email,
        passwordHash,
        role: 'owner',
        isAdmin: true,
        plan: 'phantom',
        isLifetime: true,
        devices: [],
      })
      .returning({ id: users.id, username: users.username, role: users.role });

    console.log('Owner creado:');
    console.log(`  id:       ${created.id}`);
    console.log(`  username: ${created.username}`);
    console.log(`  role:     ${created.role}`);
    console.log('Guarda la contraseña en tu gestor de secretos.');
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error('Error creando el Owner:', err);
  process.exit(1);
});
