/**
 * Aplica el tema remoto sin recompilar la app.
 *
 * El CSS viene del contenido público (`theme.css`) y se inyecta con
 * `textContent`, no con `innerHTML`: un `</style>` dentro del CSS no puede
 * escapar y convertirse en HTML. El identificador activo queda en
 * `data-theme`, que es lo que usan los selectores del propio tema.
 */

export interface AppTheme {
  id: string;
  version: number;
  css?: string;
}

const STYLE_ID = 'krakenges-theme-runtime';

export function applyAppTheme(theme: AppTheme): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const id = theme.id?.trim() || 'default';
  root.setAttribute('data-theme', id);
  root.setAttribute('data-theme-version', String(theme.version ?? 0));

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  const css = typeof theme.css === 'string' ? theme.css : '';
  const active = id !== 'default' && css.trim().length > 0;

  if (!active) {
    style?.remove();
    return;
  }

  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.setAttribute('data-theme-id', id);
  style.textContent = css;
}
