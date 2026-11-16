import React, { useEffect, useState } from 'react';
import { User, invoke } from '../../hooks/useAuth';
import { usePublicContent } from '../../hooks/usePublicContent';
import {
  PLANS,
  PlanId,
  annualPrice,
  effectivePlanFleetLabel,
  formatLimit,
  normalizePlan,
} from '../../domain/plans';
import { DASH } from '../../utils/format';
import { getBranding } from '../../config/branding';
import { 
  ShieldCheck, 
  Key, 
  Check, 
  Crown, 
  Zap, 
  Loader2, 
  ArrowRight, 
  Copy, 
  MessageSquare,
  Sparkles,
  Shield,
  Clock,
  CheckCircle2,
  Lock,
  Briefcase
} from 'lucide-react';
import './PlansView.css';

const appBrand = getBranding();

interface Props {
  user: User;
}

interface MembershipUsage {
  plan: PlanId;
  planName: string;
  isLifetime: boolean;
  /** null cuando el plan no tiene fecha (gratuito o vitalicio). */
  daysRemaining: number | null;
  planExpiresAt: string | null;
  usage: {
    profiles: { current: number; max: number };
    sessions: { current: number; max: number };
    apiKeys: { current: number; max: number };
  };
}

export function PlansView({ user }: Props) {
  const currentPlan = normalizePlan(user.plan);
  // Precios/textos publicados desde el backend. La primera pintura usa el
  // catálogo local y, si hay contenido remoto, se actualiza sin bloquear.
  const publicContent = usePublicContent();
  const [licenseKey, setLicenseKey] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [sellerPlan, setSellerPlan] = useState<PlanId>('shadow');
  const [sellerDays, setSellerDays] = useState(30);
  const [sellerCount, setSellerCount] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [sellerMsg, setSellerMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [genKeys, setGenKeys] = useState<any[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Uso y vigencia REALES. Antes esta pantalla decia "1 Licencia Vigente" y
  // pintaba una clave "MSK-...-ACTIVE" que no existia en ningun sitio.
  const [usage, setUsage] = useState<MembershipUsage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [usageLoading, setUsageLoading] = useState(true);

  useEffect(() => {
    invoke<MembershipUsage>('server_membership_usage')
      .then((res) => {
        setUsage(res);
        setUsageError(false);
      })
      .catch(() => setUsageError(true))
      .finally(() => setUsageLoading(false));
  }, []);

  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'annual'>('monthly');

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseKey?.trim()) return;

    setRedeeming(true);
    setMessage(null);

    try {
      const res: any = await invoke('server_redeem_key', { key: licenseKey.trim() });
      await invoke('server_refresh_ticket');
      setMessage({ type: 'success', text: res?.message || '¡Licencia canjeada con éxito! Cuotas actualizadas.' });
      setLicenseKey('');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setMessage({ 
        type: 'error', 
        text: err?.message || 'Clave de licencia inválida o ya utilizada.' 
      });
    } finally {
      setRedeeming(false);
    }
  };

  const handleMint = async () => {
    setGenerating(true);
    setSellerMsg(null);
    try {
      const res: any = await invoke('server_mint_keys', {
        plan: sellerPlan,
        durationDays: sellerDays,
        count: sellerCount,
      });
      const keys = Array.isArray(res?.keys) ? res.keys : [];
      setGenKeys((prev) => [...keys, ...prev]);
      setSellerMsg({
        type: 'success',
        text: `${keys.length} clave(s) generada(s) exitosamente. Saldo restante: ${res?.remainingSellerCredits ?? (user.sellerCredits ?? 0) - sellerCount} créditos.`
      });
      setSellerCount(1);
    } catch (err: any) {
      setSellerMsg({ type: 'error', text: err?.message || 'No se pudieron generar las claves.' });
    } finally {
      setGenerating(false);
    }
  };

  const copyToClipboard = async (k: string) => {
    try { await navigator.clipboard.writeText(k); } catch { /* noop */ }
    setCopiedKey(k);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  // Las tarjetas se generan a partir del catálogo canonico. Antes cada tarjeta
  // repetia a mano id, precio y limites, y ya no coincidian con el backend:
  // los ids eran free/pro/specter/enterprise y el servidor devuelve
  // ghost/shadow/specter/phantom.
  const planFeatures = (id: PlanId): string[] => {
    const limits = PLANS[id].limits;
    const profiles = limits.maxProfiles === -1 ? 'Perfiles ilimitados (∞)' : `${limits.maxProfiles} perfiles aislados`;
    const sessions = limits.maxSessions === -1 ? 'Sesiones ilimitadas (∞)' : `${limits.maxSessions} sesiones simultáneas`;
    const keys = limits.maxApiKeys === -1
      ? 'API Keys ilimitadas (∞)'
      : limits.maxApiKeys === 0
        ? ''
        : `${limits.maxApiKeys} API Keys de automatización`;
    const extra: Record<PlanId, string[]> = {
      ghost: ['Aislamiento de huella digital', 'Comprobador de proxies integrado'],
      shadow: ['Emulación WebGL / Direct3D 11', 'Soporte por ticket'],
      specter: ['Rotación de proxies por URL', 'Integración Puppeteer / Playwright CDP'],
      phantom: ['Gestión centralizada de operadores', 'Soporte dedicado'],
    };
    return [profiles, sessions, keys, ...extra[id]].filter(Boolean);
  };

  const plans = (['ghost', 'shadow', 'specter', 'phantom'] as PlanId[]).map((id, index) => {
    const def = PLANS[id];
    const remote = publicContent.plans[id];
    const remotePrice =
      typeof remote?.price === 'number' && Number.isFinite(remote.price) ? remote.price : def.price;
    const pricing = { ...def, price: remotePrice };
    const period = remote?.interval || def.interval;
    const features =
      Array.isArray(remote?.features) && remote.features.length > 0
        ? remote.features
        : planFeatures(id);
    const isCurrent = currentPlan === id;
    return {
      id,
      tierNumber: `Tier 0${index + 1}`,
      tag: ['Pruebas', 'Estándar', 'Media Buyers', 'Ilimitado'][index],
      name: remote?.name || def.name,
      desc:
        remote?.tagline ||
        [
          'Invisibilidad esencial para validación local y desarrollo.',
          'Operaciones individuales y multicuenta estándar de alta rotación.',
          'Alto rendimiento para automatización intensiva y arbitraje.',
          'Capacidad total para agencias masivas y granjas de navegación.',
        ][index],
      priceMonthly: remotePrice === 0 ? '$0' : `$${remotePrice}`,
      priceAnnual: remotePrice === 0 ? '$0' : `$${annualPrice(pricing)}`,
      period,
      popular: id === 'shadow',
      isCurrent,
      hasCrown: id === 'phantom',
      features: features.map((text) => ({ text, bold: '' })),
      negative: def.limits.maxApiKeys === 0 ? 'Sin API Keys de automatización' : '',
      buttonText: isCurrent ? (id === 'ghost' ? 'Plan Activo' : 'Suscripción Vigente') : '',
    };
  });

  const subscriptionStatus = usageLoading
    ? '...'
    : usage
      ? usage.isLifetime
        ? 'Vitalicia'
        : usage.daysRemaining === null
          ? 'Sin fecha de vencimiento'
          : usage.daysRemaining > 0
            ? `Activa · ${usage.daysRemaining} días restantes`
            : 'Vencida'
      : DASH;

  const usageBadge = usage
    ? `${usage.planName} · ${
        usage.isLifetime
          ? 'Vitalicia'
          : usage.daysRemaining === null
            ? 'Sin vencimiento'
            : usage.daysRemaining > 0
              ? `${usage.daysRemaining} días`
              : 'Vencida'
      }`
    : DASH;

  const usageRows = usage
    ? [
        { label: 'Perfiles', current: usage.usage.profiles.current, max: usage.usage.profiles.max },
        { label: 'Sesiones activas', current: usage.usage.sessions.current, max: usage.usage.sessions.max },
        { label: 'API Keys', current: usage.usage.apiKeys.current, max: usage.usage.apiKeys.max },
      ]
    : [];

  return (
    <div className="fleet-plans-view fleet-scroll">

      {/* ── SECTION 1: TOP ACTIVE PLAN & FLEET TELEMETRY METERS ── */}
      <div className="plans-summary-card">
        <div className="plans-summary-top">
          <div className="plans-summary-info">
            <div className="plans-badge-row">
              <span className="plans-active-badge">
                Plan Activo: {effectivePlanFleetLabel(user)}
              </span>
              <span className="plans-server-check">
                <CheckCircle2 size={13} />
                <span>{usageLoading ? 'Consultando…' : usage ? 'Verificado en Servidor' : 'Sin verificar'}</span>
              </span>
            </div>
            <h2 className="plans-summary-title">
              {publicContent.texts.plansSummaryTitle || 'Suscripción & Licencias de Flota'}
            </h2>
            <p className="plans-summary-desc">
              Cuenta: <span style={{ color: '#ffffff', fontWeight: 600 }}>{user.name}</span> (@{user.username}) · Estado de suscripción: <span style={{ color: '#ffffff', fontWeight: 700 }}>{subscriptionStatus}</span>
            </p>
          </div>

          {/* License Key Redeem Form */}
          <div className="plans-redeem-box">
            <div className="plans-redeem-header">
              <span>Canjear Clave de Licencia</span>
              <Key size={14} style={{ color: '#ffffff' }} />
            </div>
            <form onSubmit={handleRedeem} className="plans-redeem-form">
              <input 
                type="text" 
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="MSK-XXXX-XXXX-XXXX" 
                className="plans-redeem-input"
              />
              <button 
                type="submit" 
                disabled={redeeming || !licenseKey?.trim()}
                className="plans-redeem-btn"
              >
                {redeeming ? <Loader2 size={13} className="spin" /> : <span>Canjear</span>}
                {!redeeming && <ArrowRight size={13} />}
              </button>
            </form>

            {message && (
              <div style={{
                marginTop: '0.5rem',
                padding: '0.5rem',
                borderRadius: '8px',
                fontSize: '0.6875rem',
                fontFamily: 'monospace',
                background: message.type === 'success' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(244, 63, 94, 0.1)',
                color: message.type === 'success' ? '#ffffff' : '#fda4af',
                border: message.type === 'success' ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid rgba(244, 63, 94, 0.3)'
              }}>
                {message.text}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── SECTION 2: THE 4 ENTERPRISE TIERS (MONOCHROMATIC MATRIX) ── */}
      <div className="plans-matrix-section">
        <div className="plans-matrix-header">
          <div className="plans-matrix-title-group">
            <div className="plans-matrix-eyebrow">
              {publicContent.texts.plansSectionEyebrow || 'Escalabilidad de Infraestructura'}
            </div>
            <h3 className="plans-matrix-h3">
              {publicContent.texts.plansSectionTitle || 'Tiers de Potencia & Huella Digital'}
            </h3>
          </div>
          
          <div className="plans-billing-toggle">
            <button 
              type="button"
              onClick={() => setBillingPeriod('monthly')}
              className={`plans-billing-btn ${billingPeriod === 'monthly' ? 'active' : ''}`}
            >
              Facturación Mensual
            </button>
            <button 
              type="button"
              onClick={() => setBillingPeriod('annual')}
              className={`plans-billing-btn ${billingPeriod === 'annual' ? 'active' : ''}`}
            >
              Anual (-20%)
            </button>
          </div>
        </div>

        <div className="plans-cards-grid">
          {plans.map((p) => {
            const price = billingPeriod === 'monthly' ? p.priceMonthly : p.priceAnnual;
            return (
              <div
                key={p.id}
                className={`plans-tier-card ${p.popular ? 'featured' : ''}`}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="plans-card-top-row">
                    <span className="plans-tier-code">
                      {p.tierNumber}
                    </span>
                    {p.popular ? (
                      <span className="plans-tier-tag recommended">
                        Recomendado
                      </span>
                    ) : (
                      <span className="plans-tier-tag">
                        {p.tag}
                      </span>
                    )}
                  </div>

                  <div className="plans-tier-identity">
                    <h4 className="plans-tier-name">
                      <span>{p.name}</span>
                      {p.hasCrown && <Crown size={16} style={{ color: '#ffffff', fill: '#ffffff' }} />}
                    </h4>
                    <p className="plans-tier-desc">{p.desc}</p>
                  </div>

                  <div className="plans-tier-price-row">
                    <span className="plans-tier-price">{price}</span>
                    <span className="plans-tier-period">/ {p.period}</span>
                  </div>

                  <ul className="plans-features-list">
                    {p.features.map((feat, idx) => (
                      <li key={idx} className="plans-feature-item">
                        <Check size={14} style={{ color: '#ffffff', flexShrink: 0, marginTop: '2px' }} />
                        <span>{feat.text}</span>
                      </li>
                    ))}
                    {p.negative && (
                      <li className="plans-feature-item negative">
                        <Lock size={13} style={{ color: '#52525b', flexShrink: 0, marginTop: '2px' }} />
                        <span>{p.negative}</span>
                      </li>
                    )}
                  </ul>
                </div>

                <div style={{ paddingTop: '1.25rem' }}>
                  {p.isCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="plans-card-btn-active"
                    >
                      <CheckCircle2 size={14} style={{ color: '#000000' }} />
                      <span>{p.buttonText}</span>
                    </button>
                  ) : (
                    <div className="plans-card-btn-available">
                      Disponible con Clave de Activación
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── SECTION 3: ACTIVATION HISTORY & SALES ADVISOR CONTACT ── */}
      <div className="plans-bottom-grid">
        
        {/* Uso real del plan (2 cols) */}
        <div className="plans-history-card">
          <div className="plans-history-header">
            <div>
              <h3 className="plans-history-title">Uso del Plan</h3>
              <p className="plans-history-subtitle">Consumo real informado por el servidor</p>
            </div>
            <span style={{
              padding: '0.25rem 0.6rem',
              borderRadius: '8px',
              background: 'rgba(255, 255, 255, 0.05)',
              fontSize: '0.6875rem',
              fontFamily: 'monospace',
              color: '#d4d4d8',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem'
            }}>
              <ShieldCheck size={14} style={{ color: '#ffffff' }} />
              {usageBadge}
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="plans-history-table">
              <thead>
                <tr>
                  <th>Recurso</th>
                  <th>Uso</th>
                  <th>Límite</th>
                  <th style={{ textAlign: 'right' }}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {usageRows.length > 0 ? usageRows.map((row) => {
                  const unlimited = row.max === -1;
                  const atLimit = !unlimited && row.current >= row.max;
                  return (
                    <tr key={row.label}>
                      <td style={{ color: '#ffffff', fontWeight: 700 }}>{row.label}</td>
                      <td style={{ color: '#d4d4d8' }}>{row.current}</td>
                      <td style={{ color: '#a1a1aa', fontSize: '0.6875rem' }}>{formatLimit(row.max)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          padding: '0.15rem 0.6rem',
                          borderRadius: '999px',
                          background: 'rgba(255, 255, 255, 0.1)',
                          color: '#ffffff',
                          fontSize: '0.65rem',
                          fontWeight: 700
                        }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: atLimit ? '#f87171' : '#ffffff' }}></span>
                          {unlimited ? 'Ilimitado' : atLimit ? 'Límite alcanzado' : 'Dentro del plan'}
                        </span>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td colSpan={4} style={{ color: '#a1a1aa', fontSize: '0.75rem', textAlign: 'center', padding: '1rem' }}>
                      {usageLoading ? 'Consultando el servidor…' : usageError ? 'No se pudo consultar el uso del plan.' : 'Sin datos de uso disponibles.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Sales Advisor Direct Contact Card (1 col) - Zero reseller mentions */}
        <div className="plans-advisor-card">
          <div className="plans-advisor-top">
            <div className="plans-advisor-icon">
              <MessageSquare size={18} style={{ color: '#000000' }} />
            </div>
            <div>
              <h3 className="plans-advisor-title">¿Deseas Renovar o Escalar?</h3>
              <p className="plans-advisor-desc">
                Para extender tu vigencia o subir a un plan superior (Specter o Phantom), contacta a tu asesor comercial asignado.
              </p>
            </div>

            <div className="plans-advisor-info-box">
              <div style={{ fontSize: '0.625rem', color: '#71717a', textTransform: 'uppercase', fontWeight: 700, marginBottom: '0.25rem' }}>
                Mecanismo de Entrega
              </div>
              <div style={{ color: '#d4d4d8', fontSize: '0.6875rem', lineHeight: '1.45' }}>
                Tu asesor comercial te entrega un código de activación oficial. Solo ingrésalo arriba para activar o renovar tu flota al instante sin perder perfiles.
              </div>
            </div>
          </div>

          <div style={{ paddingTop: '0.5rem', textAlign: 'center', fontSize: '0.6875rem', color: '#71717a', fontFamily: 'monospace' }}>
            Soporte & Asesoría Directa {appBrand.appName}
          </div>
        </div>

      </div>

      {/* ── SECTION 4: CONSOLA DE EMISIÓN (SOLO PERSONAL AUTORIZADO / SELLER / ADMIN) ── */}
      {(user.role === 'seller' || user.isAdmin) && (
        <div className="plans-seller-card">
          <div className="plans-seller-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: '#ffffff',
                color: '#000000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800
              }}>
                <Briefcase size={18} style={{ color: '#000000' }} />
              </div>
              <div>
                <h3 style={{ fontSize: '1rem', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.02em' }}>
                  Consola de Emisión de Licencias (Personal Autorizado)
                </h3>
                <p style={{ fontSize: '0.75rem', color: '#a1a1aa', fontFamily: 'monospace' }}>
                  Módulo interno de ventas · {user.role === 'seller'
                    ? <>Créditos de emisión disponibles: <strong style={{ color: '#ffffff' }}>{user.sellerCredits ?? 0} CR</strong></>
                    : 'Emisión sin consumo de créditos (owner/admin)'}
                </p>
              </div>
            </div>

            <span style={{
              padding: '0.25rem 0.75rem',
              borderRadius: '999px',
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#ffffff',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              fontWeight: 700
            }}>
              Rol: {user.role.toUpperCase()}
            </span>
          </div>

          <p style={{ fontSize: '0.75rem', color: '#d4d4d8', lineHeight: '1.5' }}>
            {user.role === 'seller'
              ? 'Cada clave generada consume 1 crédito de tu saldo asignado por gerencia. Entrega la clave generada al cliente para que la canjee en su app.'
              : 'Como owner/admin puedes emitir claves sin límite de créditos y con el rol que definas. Entrega la clave generada al cliente para que la canjee en su app.'}
          </p>

          <div className="plans-seller-controls">
            <div className="plans-seller-field">
              <label className="plans-seller-label">Plan a Emitir</label>
              <select
                value={sellerPlan}
                onChange={(e) => setSellerPlan(e.target.value as any)}
                className="plans-seller-select"
                style={{ minWidth: '180px' }}
              >
                <option value="ghost">{publicContent.plans.ghost?.name || PLANS.ghost.name} (Básico / ${publicContent.plans.ghost?.price ?? PLANS.ghost.price})</option>
                <option value="shadow">{publicContent.plans.shadow?.name || PLANS.shadow.name} ({PLANS.shadow.limits.maxProfiles} perfiles / ${publicContent.plans.shadow?.price ?? PLANS.shadow.price})</option>
                <option value="specter">{publicContent.plans.specter?.name || PLANS.specter.name} ({PLANS.specter.limits.maxProfiles} perfiles / ${publicContent.plans.specter?.price ?? PLANS.specter.price})</option>
                <option value="phantom">{publicContent.plans.phantom?.name || PLANS.phantom.name} (Ilimitado / ${publicContent.plans.phantom?.price ?? PLANS.phantom.price})</option>
              </select>
            </div>

            <div className="plans-seller-field">
              <label className="plans-seller-label">Vigencia (días)</label>
              <input
                type="number"
                min={1}
                max={365}
                value={sellerDays}
                onChange={(e) => setSellerDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))}
                className="plans-seller-input"
                style={{ width: '110px' }}
              />
            </div>

            <div className="plans-seller-field">
              <label className="plans-seller-label">Cantidad</label>
              <input
                type="number"
                min={1}
                max={Math.min(50, user.sellerCredits ?? 50)}
                value={sellerCount}
                onChange={(e) => setSellerCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                className="plans-seller-input"
                style={{ width: '90px' }}
              />
            </div>

            <button
              type="button"
              disabled={
                generating ||
                (user.role === 'seller' &&
                  user.sellerCredits !== undefined &&
                  user.sellerCredits < sellerCount)
              }
              onClick={handleMint}
              className="plans-seller-mint-btn"
            >
              {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              <span>Generar {sellerCount} clave{sellerCount !== 1 ? 's' : ''}</span>
            </button>
          </div>

          {sellerMsg && (
            <div style={{
              padding: '0.75rem',
              borderRadius: '10px',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              background: sellerMsg.type === 'success' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(244, 63, 94, 0.1)',
              color: sellerMsg.type === 'success' ? '#ffffff' : '#fda4af',
              border: sellerMsg.type === 'success' ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid rgba(244, 63, 94, 0.3)'
            }}>
              {sellerMsg.text}
            </div>
          )}

          {genKeys.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '0.5rem' }}>
              <div style={{ fontSize: '0.6875rem', fontFamily: 'monospace', color: '#a1a1aa', textTransform: 'uppercase', fontWeight: 700 }}>
                Claves Generadas Recientemente:
              </div>
              <div className="fleet-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '12rem', overflowY: 'auto' }}>
                {genKeys.map((k, idx) => (
                  <div 
                    key={`${k.key}-${idx}`} 
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.6rem 0.85rem',
                      borderRadius: '10px',
                      background: '#000000',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      fontFamily: 'monospace',
                      fontSize: '0.75rem'
                    }}
                  >
                    <span style={{ color: '#a1a1aa', textTransform: 'uppercase', fontSize: '0.65rem', fontWeight: 700 }}>
                      {String(k.plan || '').toUpperCase()} · {k.durationDays || sellerDays} días
                    </span>
                    <code style={{ color: '#ffffff', fontWeight: 700, letterSpacing: '0.05em' }}>{k.key}</code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(k.key)}
                      style={{
                        padding: '0.35rem',
                        borderRadius: '6px',
                        background: 'transparent',
                        border: 'none',
                        color: '#a1a1aa',
                        cursor: 'pointer'
                      }}
                      title="Copiar Clave"
                    >
                      {copiedKey === k.key ? <Check size={14} style={{ color: '#ffffff' }} /> : <Copy size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

export default PlansView;
