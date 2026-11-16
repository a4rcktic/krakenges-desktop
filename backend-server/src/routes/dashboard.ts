import { Router } from 'express';
import { authenticate } from '../authMiddleware';
import Profile from '../models/Profile';
import Session from '../models/Session';
import ApiKey from '../models/ApiKey';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user!._id;

  // Las seis consultas son independientes entre si: ninguna depende del
  // resultado de otra. Antes iban en serie, asi que el panel esperaba la suma
  // de los seis tiempos de ida y vuelta en lugar del mas lento. Promise.all las
  // lanza a la vez.
  const [
    profilesCount,
    sessionsCount,
    activeSessionsCount,
    latestProfiles,
    latestSessions,
    stoppedSessions,
    apiKeysCount,
  ] = await Promise.all([
    Profile.countDocuments({ userId }),
    Session.countDocuments({ userId }),
    // Contador real de sesiones activas.
    //
    // Antes el panel contaba los `latestSessions`, que son solo las 5 mas
    // recientes. Con 8 sesiones activas el movil decia "5 en ejecucion", y con
    // 6 activas y 4 paradas recientes podia decir "1". Ese numero no era el
    // total, aunque se pintaba como tal.
    Session.countDocuments({ userId, status: 'active' }),
    Profile.find({ userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name createdAt updatedAt'),
    Session.find({ userId })
      .sort({ createdAt: -1 })
      .limit(5)
      // populate deja en null cuando el perfil ya no existe (se borro). Con
      // name en el select, un populate fallido deja name a null y se puede
      // distinguir un perfil borrado de uno sin nombre.
      //
      // No se piden `browser` ni `userAgent`: el modelo Profile no tiene esos
      // campos. Pedirlos no devolvia nada y el cliente acababa pintando "—"
      // igual, pero el comentario daba a entender que si existian.
      .populate('profileId', 'name os')
      .select('profileId status startedAt createdAt'),
    Session.find({ userId, status: 'stopped' }).select('duration'),
    ApiKey.countDocuments({ userId }),
  ]);

  const totalMinutes = stoppedSessions.reduce((sum, s) => sum + (s.duration || 0), 0);

  res.json({
    profilesCount,
    sessionsCount,
    activeSessionsCount,
    totalMinutes,
    latestProfiles,
    latestSessions,
    apiKeysCount,
  });
}));

export default router;
