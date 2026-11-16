/**
 * White-Labeling & Branding Configuration Engine
 * 
 * Centraliza el 100% de la identidad de la aplicación:
 * - Nombre de la app, descripciones y textos legales.
 * - Rutas de logos, iconos y favicons.
 * - Paleta completa de colores (primario, secundario, fondos, bordes, brillos).
 * - Presets de temas listos para cambiar la identidad visual al instante.
 * - Inyección automática de variables CSS en tiempo de ejecución.
 * 
 * Para vender o renombrar el proyecto, edita `brand.config.json` en la raíz y
 * ejecuta `node tools/brand/apply.mjs`. Este archivo solo consume el resultado
 * generado en `brand.generated.ts`.
 */

import { BRAND } from './brand.generated';

export interface BrandColors {
  primary: string;           // Color de acento principal (ej. #00f0ff)
  primaryHover: string;      // Hover del color principal
  primaryGlow: string;       // Sombra/resplandor (ej. rgba(0, 240, 255, 0.35))
  secondary: string;         // Color secundario (ej. #7928ca)
  secondaryGlow: string;     // Sombra secundaria
  bgDark: string;            // Fondo principal de la ventana
  bgSurface: string;         // Fondo de paneles y barras laterales
  bgCard: string;            // Fondo de tarjetas y tablas
  border: string;            // Borde estándar sutil
  borderHighlight: string;   // Borde con foco o hover
  textPrimary: string;       // Texto principal (blanco/muy claro)
  textSecondary: string;     // Texto secundario (gris claro)
  textMuted: string;         // Texto tenue o deshabilitado
  accentSuccess: string;     // Verde de éxito / conectado
  accentWarning: string;     // Ámbar de advertencia
  accentDanger: string;      // Rojo de peligro / error
}

export interface BrandConfig {
  appName: string;
  shortName: string;
  appTitle: string;
  appDescription: string;
  tagline: string;
  companyName: string;
  copyright: string;
  supportUrl: string;
  logoUrl: string;
  logoSquare: string;
  faviconUrl: string;
  colors: BrandColors;
}

export const THEME_PRESETS: Record<string, { name: string; colors: BrandColors }> = {
  cyberpunkCyan: {
    name: 'Cyberpunk Cyan (Predeterminado)',
    colors: {
      primary: '#00f0ff',
      primaryHover: '#38f9d7',
      primaryGlow: 'rgba(0, 240, 255, 0.35)',
      secondary: '#7928ca',
      secondaryGlow: 'rgba(121, 40, 202, 0.35)',
      bgDark: '#06070a',
      bgSurface: '#0b0f19',
      bgCard: '#0f172a',
      border: '#1e293b',
      borderHighlight: '#334155',
      textPrimary: '#f8fafc',
      textSecondary: '#94a3b8',
      textMuted: '#64748b',
      accentSuccess: '#10b981',
      accentWarning: '#f59e0b',
      accentDanger: '#ef4444',
    },
  },
  matrixEmerald: {
    name: 'Matrix Emerald (Verde Hacker)',
    colors: {
      primary: '#10b981',
      primaryHover: '#34d399',
      primaryGlow: 'rgba(16, 185, 129, 0.35)',
      secondary: '#059669',
      secondaryGlow: 'rgba(5, 150, 105, 0.35)',
      bgDark: '#040d08',
      bgSurface: '#06160c',
      bgCard: '#092113',
      border: '#143823',
      borderHighlight: '#1f5436',
      textPrimary: '#f0fdf4',
      textSecondary: '#86efac',
      textMuted: '#4ade80',
      accentSuccess: '#10b981',
      accentWarning: '#fbbf24',
      accentDanger: '#f87171',
    },
  },
  synthwaveViolet: {
    name: 'Synthwave Violet (Neón Morado)',
    colors: {
      primary: '#a855f7',
      primaryHover: '#c084fc',
      primaryGlow: 'rgba(168, 85, 247, 0.35)',
      secondary: '#ec4899',
      secondaryGlow: 'rgba(236, 72, 153, 0.35)',
      bgDark: '#090514',
      bgSurface: '#120a24',
      bgCard: '#1a0e36',
      border: '#2e1957',
      borderHighlight: '#4a2b85',
      textPrimary: '#faf5ff',
      textSecondary: '#d8b4fe',
      textMuted: '#a855f7',
      accentSuccess: '#34d399',
      accentWarning: '#f59e0b',
      accentDanger: '#f43f5e',
    },
  },
  titaniumBlue: {
    name: 'Titanium Blue (Corporativo)',
    colors: {
      primary: '#3b82f6',
      primaryHover: '#60a5fa',
      primaryGlow: 'rgba(59, 130, 246, 0.35)',
      secondary: '#0284c7',
      secondaryGlow: 'rgba(2, 132, 199, 0.35)',
      bgDark: '#050b14',
      bgSurface: '#081220',
      bgCard: '#0c1b30',
      border: '#1a304f',
      borderHighlight: '#294770',
      textPrimary: '#f8fafc',
      textSecondary: '#93c5fd',
      textMuted: '#60a5fa',
      accentSuccess: '#10b981',
      accentWarning: '#f59e0b',
      accentDanger: '#ef4444',
    },
  },
  crimsonRed: {
    name: 'Crimson Red (Viper / Sigilo Táctico)',
    colors: {
      primary: '#ef4444',
      primaryHover: '#f87171',
      primaryGlow: 'rgba(239, 68, 68, 0.35)',
      secondary: '#dc2626',
      secondaryGlow: 'rgba(220, 38, 38, 0.35)',
      bgDark: '#0f0505',
      bgSurface: '#1a0808',
      bgCard: '#260d0d',
      border: '#421717',
      borderHighlight: '#612424',
      textPrimary: '#fef2f2',
      textSecondary: '#fca5a5',
      textMuted: '#ef4444',
      accentSuccess: '#10b981',
      accentWarning: '#f59e0b',
      accentDanger: '#dc2626',
    },
  },
};

export const DEFAULT_BRANDING: BrandConfig = {
  appName: BRAND.appName,
  shortName: BRAND.shortName,
  appTitle: BRAND.appTitle,
  appDescription: BRAND.appDescription,
  tagline: BRAND.tagline,
  companyName: BRAND.companyName,
  copyright: BRAND.copyright,
  supportUrl: BRAND.supportUrl,
  logoUrl: BRAND.logoUrl,
  logoSquare: BRAND.logoSquare,
  faviconUrl: BRAND.faviconUrl,
  colors: THEME_PRESETS.cyberpunkCyan.colors,
};

const STORAGE_KEY = 'krakenges_custom_branding';

/**
 * Obtiene la configuración actual de marca (desde localStorage o valores por defecto).
 */
export function getBranding(): BrandConfig {
  if (typeof window === 'undefined') return DEFAULT_BRANDING;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_BRANDING,
        ...parsed,
        colors: { ...DEFAULT_BRANDING.colors, ...(parsed.colors || {}) },
      };
    }
  } catch (e) {
    console.warn('[Branding] Error cargando configuración personalizada:', e);
  }
  return DEFAULT_BRANDING;
}

/**
 * Guarda una nueva configuración de marca y aplica los cambios visuales.
 */
export function setBranding(updates: Partial<BrandConfig>): BrandConfig {
  const current = getBranding();
  const next: BrandConfig = {
    ...current,
    ...updates,
    colors: updates.colors ? { ...current.colors, ...updates.colors } : current.colors,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  applyBrandTheme(next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('krakenges:brand-changed', { detail: next }));
  }
  return next;
}

/**
 * Aplica los colores de la marca directamente en las variables CSS globales (:root)
 * y actualiza el título y favicon de la pestaña.
 */
export function applyBrandTheme(config?: BrandConfig): void {
  const brand = config || getBranding();
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const c = brand.colors;

  // Variables CSS dinámicas
  root.style.setProperty('--brand-primary', c.primary);
  root.style.setProperty('--brand-primary-hover', c.primaryHover);
  root.style.setProperty('--brand-primary-glow', c.primaryGlow);
  root.style.setProperty('--brand-secondary', c.secondary);
  root.style.setProperty('--brand-secondary-glow', c.secondaryGlow);
  root.style.setProperty('--brand-bg', c.bgDark);
  root.style.setProperty('--brand-surface', c.bgSurface);
  root.style.setProperty('--brand-card', c.bgCard);
  root.style.setProperty('--brand-border', c.border);
  root.style.setProperty('--brand-border-highlight', c.borderHighlight);
  root.style.setProperty('--brand-text', c.textPrimary);
  root.style.setProperty('--brand-text-secondary', c.textSecondary);
  root.style.setProperty('--brand-text-muted', c.textMuted);
  root.style.setProperty('--brand-success', c.accentSuccess);
  root.style.setProperty('--brand-warning', c.accentWarning);
  root.style.setProperty('--brand-danger', c.accentDanger);

  // Título de la ventana
  if (brand.appTitle) {
    document.title = brand.appTitle;
  }

  // Favicon
  try {
    const favicon = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
    if (favicon && brand.faviconUrl) {
      favicon.href = brand.faviconUrl;
    }
  } catch {}
}

/**
 * Restaura la marca y paleta de colores por defecto.
 */
export function resetBranding(): BrandConfig {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  applyBrandTheme(DEFAULT_BRANDING);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('krakenges:brand-changed', { detail: DEFAULT_BRANDING }));
  }
  return DEFAULT_BRANDING;
}
