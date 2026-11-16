import { BRAND_NAME } from '../config/brand';
import { APP_PUBLIC_URL } from '../config/publicUrls';

/**
 * Envío de correo por HTTP, sin dependencias nuevas.
 *
 * El backend no tenía ningún proveedor: `/forgot-password` generaba un token y
 * lo guardaba, pero el usuario nunca recibía el enlace. Eso no es un reset
 * incompleto, es un reset que no existe.
 *
 * Se usa Resend porque su API es un POST JSON y no obliga a añadir nodemailer
 * ni un servidor SMTP. Si `RESEND_API_KEY` o `MAIL_FROM` faltan, la ruta
 * responde 503 en vez de aceptar una solicitud que no puede completar.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const MAIL_FROM = process.env.MAIL_FROM?.trim();

export function isMailConfigured(): boolean {
  return Boolean(RESEND_API_KEY && MAIL_FROM);
}

export function passwordResetUrl(token: string): string {
  return `${APP_PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<boolean> {
  if (!isMailConfigured()) return false;

  const resetUrl = passwordResetUrl(token);
  const text = [
    `Has solicitado restablecer la contraseña de ${BRAND_NAME}.`,
    '',
    `Abre este enlace para cambiarla: ${resetUrl}`,
    '',
    'El enlace caduca en 1 hora. Si no lo pediste, ignora este correo.',
  ].join('\n');

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to,
        subject: `Restablece tu contraseña de ${BRAND_NAME}`,
        text,
      }),
    });

    if (!response.ok) {
      console.error(`[mailer] Resend respondió ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[mailer] no se pudo contactar con Resend:', error);
    return false;
  }
}
