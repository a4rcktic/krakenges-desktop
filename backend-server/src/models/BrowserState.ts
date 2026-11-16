import { model, Schema, Document, Types } from 'mongoose';

/**
 * Estado de navegador associated a un perfil.
 *
 * NOTA: aquí NO hay fingerprint, y es deliberado.
 *
 * Hasta el 03/10/2026 este modelo guardaba un `fingerprint` completo (userAgent,
 * platform, GPU, fuentes, extensiones WebGL, plugins, batería, media devices)
 * que generaba services/fingerprint.ts. Ese generador era un segundo motor de
 * identidad que NO usaba nadie: el motor real (src-tauri, cdp.rs + el shim)
 * consume la receta de POST /api/fingerprint, y sus tablas de GPU y fuentes
 * viven en el cliente. Medido sobre 200 perfiles, el 47,5% tenía guardado un
 * sistema operativo que contradecía al que se le servía.
 *
 * Es decir: un dato que se escribía en cada alta de perfil, ocupaba espacio, y
 * además se contradecía con la identidad real. Sin consumidor.
 *
 * Lo que queda es lo único que el servidor tiene de verdad del navegador:
 * cookies y localStorage, que ya no se sincronizan al servidor por política
 * (los datos sensibles se quedan en la máquina del cliente), pero se conservan
 * los campos por compatibilidad con los registros antiguos.
 */
export interface IBrowserState extends Document {
  profileId: Types.ObjectId;
  userId: Types.ObjectId;
  cookies: string;
  localStorage: string;
  lastUsedAt: Date;
  createdAt: Date;
}

const BrowserStateSchema = new Schema<IBrowserState>({
  profileId: { type: Schema.Types.ObjectId, ref: 'Profile', required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cookies: { type: String, default: '[]' },
  localStorage: { type: String, default: '{}' },
  lastUsedAt: { type: Date, default: () => new Date() },
  createdAt: { type: Date, default: () => new Date() },
});

// Los documentos de producción siguen teniendo el campo `fingerprint` guardado.
// Mongoose no los devuelve (el esquema ya no lo declara) y nadie lo lee, así que
// no estorban. El borrado real de los 675 registros es una operación de una vez
// sobre Mongo, fuera del código:
//   db.browserstates.updateMany({}, { $unset: { fingerprint: '' } })
export default model<IBrowserState>('BrowserState', BrowserStateSchema);