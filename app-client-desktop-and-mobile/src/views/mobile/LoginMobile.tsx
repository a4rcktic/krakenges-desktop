import { useState } from 'react';
import { 
  Eye, 
  EyeOff, 
  Lock, 
  User as UserIcon, 
  Loader2, 
  ArrowRight, 
  AlertCircle, 
  Sparkles,
  Shield,
  Smartphone,
  CheckCircle2,
  KeyRound,
  Key
} from 'lucide-react';
import { InteractiveBackground } from '../../components/Common/InteractiveBackground';
import { isMobileNative } from '../../services/mobileBrowser';
import { getBranding } from '../../config/branding';
import { APP_VERSION } from '../../config/version';
import './LoginMobile.css';

const appBrand = getBranding();

interface Props {
  onLogin: (username: string, password: string) => Promise<any>;
  onRegister?: (data: { name: string; username: string; password: string; key: string }) => Promise<any>;
}

export function LoginMobile({ onLogin, onRegister }: Props) {
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');

  // Login inputs
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [showLoginPass, setShowLoginPass] = useState(false);

  // Register inputs
  const [regUser, setRegUser] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regConfirmPass, setRegConfirmPass] = useState('');
  const [regLicense, setRegLicense] = useState('');
  const [showRegPass, setShowRegPass] = useState(false);
  const [showRegConfirmPass, setShowRegConfirmPass] = useState(false);

  // Common state
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  const triggerShake = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const hasMinLen = regPass.length >= 8;
  const hasUpper = /[A-Z]/.test(regPass);
  const hasNum = /[0-9]/.test(regPass);
  const passwordsMatch = regConfirmPass.length > 0 && regPass === regConfirmPass;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginUser.trim() || !loginPass) {
      triggerShake('Por favor ingresa usuario y contraseña.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await onLogin(loginUser.trim(), loginPass);
    } catch (err: any) {
      console.error('MOBILE LOGIN ERROR:', err);
      const msg = typeof err === 'string' 
        ? err 
        : (err?.message || err?.error || 'Usuario o contraseña incorrectos.');
      triggerShake(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regUser.trim() || !regPass || !regLicense.trim()) {
      triggerShake('Completa todos los campos obligatorios.');
      return;
    }

    if (regPass !== regConfirmPass) {
      triggerShake('Las contraseñas no coinciden.');
      return;
    }

    if (regPass.length < 8) {
      triggerShake('Mínimo 8 caracteres en la contraseña.');
      return;
    }

    if (!onRegister) {
      triggerShake('Registro no disponible en este momento.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await onRegister({
        name: regUser.trim(),
        username: regUser.trim(),
        password: regPass,
        key: regLicense.trim().toUpperCase(),
      });
    } catch (err: any) {
      console.error('MOBILE REGISTER ERROR:', err);
      const msg = typeof err === 'string' 
        ? err 
        : (err?.message || err?.error || 'Error al validar la licencia móvil.');
      triggerShake(msg);
    } finally {
      setLoading(false);
    }
  };

  const content = (
    <div className={`mob-app-surface ${shake ? 'mob-shake' : ''}`}>
      {/* Top Mobile Status Header (Safe Area / Mobile App Bar) */}
      <div className="mob-top-bar">
        <div className="mob-status-pill">
          <span className="mob-status-dot" />
          <span>STEALTH ACTIVE</span>
        </div>
        <div className="mob-version-badge">
          <span>v{APP_VERSION} ANDROID</span>
        </div>
      </div>

      {/* Brand Hero */}
      <div className="mob-hero">
        <div className="mob-logo-box">
          <img 
            src="/icon.png" 
            alt={appBrand.appName}
            className="mob-logo-img"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
          <div className="mob-logo-fallback">
            <Shield size={24} className="text-cyan-400" />
          </div>
        </div>
        <h1 className="mob-title">{appBrand.appName}</h1>
        <p className="mob-subtitle">Navegador Anti-Detect Móvil</p>
      </div>

      {/* Thumb-friendly Segmented Touch Switcher */}
      <div className="mob-tab-switch">
        <div 
          className="mob-tab-indicator"
          style={{ transform: activeTab === 'login' ? 'translateX(0%)' : 'translateX(100%)' }}
        />
        <button
          type="button"
          className={`mob-tab-btn ${activeTab === 'login' ? 'active' : ''}`}
          onClick={() => { setActiveTab('login'); setError(''); }}
        >
          Iniciar sesión
        </button>
        <button
          type="button"
          className={`mob-tab-btn ${activeTab === 'register' ? 'active' : ''}`}
          onClick={() => { setActiveTab('register'); setError(''); }}
        >
          Crear cuenta
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mob-error-banner">
          <AlertCircle size={15} className="flex-shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Active Tab Form Content (Natural Height, Zero Dead Space) */}
      {activeTab === 'login' ? (
        <form key="login" onSubmit={handleLoginSubmit} className="mob-form mob-tab-content">
          <div className="mob-field">
            <label className="mob-label">USUARIO</label>
            <div className="mob-input-slot">
              <UserIcon size={18} className="mob-input-icon" />
              <input
                type="text"
                className="mob-input"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                placeholder="Tu usuario o email"
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
              {loginUser.trim().length > 2 && (
                <CheckCircle2 size={16} className="mob-check-icon text-emerald-400" />
              )}
            </div>
          </div>

          <div className="mob-field">
            <div className="mob-field-header">
              <label className="mob-label">CONTRASEÑA</label>
              <button
                type="button"
                className="mob-forgot-link"
                onClick={() => alert('Contacta a tu soporte para recuperar tu acceso.')}
              >
                ¿Olvidaste tu contraseña?
              </button>
            </div>
            <div className="mob-input-slot">
              <Lock size={18} className="mob-input-icon" />
              <input
                type={showLoginPass ? 'text' : 'password'}
                className="mob-input mob-pass-input"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="••••••••••••"
                required
                autoComplete="current-password"
                spellCheck={false}
              />
              <button
                type="button"
                className="mob-eye-touch"
                onClick={() => setShowLoginPass(!showLoginPass)}
                tabIndex={-1}
                aria-label="Mostrar u ocultar contraseña"
              >
                {showLoginPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !loginUser.trim() || !loginPass}
            className="mob-btn-action"
          >
            {loading ? (
              <>
                <Loader2 size={18} className="mob-spin" />
                <span>Iniciando sesión...</span>
              </>
            ) : (
              <>
                <span>Entrar a {appBrand.appName}</span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>
      ) : (
        <form key="register" onSubmit={handleRegisterSubmit} className="mob-form mob-tab-content">
          <div className="mob-field">
            <label className="mob-label">NOMBRE DE USUARIO</label>
            <div className="mob-input-slot">
              <UserIcon size={18} className="mob-input-icon" />
              <input
                type="text"
                className="mob-input"
                value={regUser}
                onChange={(e) => setRegUser(e.target.value)}
                placeholder="Elige tu nombre de usuario"
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="mob-field">
            <label className="mob-label">CONTRASEÑA</label>
            <div className="mob-input-slot">
              <Lock size={18} className="mob-input-icon" />
              <input
                type={showRegPass ? 'text' : 'password'}
                className="mob-input mob-pass-input"
                value={regPass}
                onChange={(e) => setRegPass(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                required
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                className="mob-eye-touch"
                onClick={() => setShowRegPass(!showRegPass)}
                tabIndex={-1}
              >
                {showRegPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            {/* Password Criteria Pill Checklist */}
            {regPass.length > 0 && (
              <div className="mob-checklist">
                <span className={`mob-check-chip ${hasMinLen ? 'valid' : ''}`}>8+ chars</span>
                <span className={`mob-check-chip ${hasUpper ? 'valid' : ''}`}>Mayúscula</span>
                <span className={`mob-check-chip ${hasNum ? 'valid' : ''}`}>Número</span>
              </div>
            )}
          </div>

          <div className="mob-field">
            <label className="mob-label">CONFIRMAR CONTRASEÑA</label>
            <div className="mob-input-slot">
              <Lock size={18} className="mob-input-icon" />
              <input
                type={showRegConfirmPass ? 'text' : 'password'}
                className={`mob-input mob-pass-input ${regConfirmPass && !passwordsMatch ? 'mob-input-error' : ''}`}
                value={regConfirmPass}
                onChange={(e) => setRegConfirmPass(e.target.value)}
                placeholder="Repite tu contraseña"
                required
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                className="mob-eye-touch"
                onClick={() => setShowRegConfirmPass(!showRegConfirmPass)}
                tabIndex={-1}
              >
                {showRegConfirmPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="mob-field">
            <div className="mob-field-header">
              <label className="mob-label">CÓDIGO DE LICENCIA</label>
              <span className="mob-badge-req">REQUERIDO</span>
            </div>
            <div className="mob-input-slot mob-slot-key">
              <Key size={18} className="mob-input-icon text-cyan-400" />
              <input
                type="text"
                className="mob-input mob-key-input"
                value={regLicense}
                onChange={(e) => setRegLicense(e.target.value.toUpperCase())}
                placeholder="MSK-XXXX-XXXX"
                required
                spellCheck={false}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !regUser.trim() || !regPass || !regLicense.trim() || !passwordsMatch}
            className="mob-btn-action"
          >
            {loading ? (
              <>
                <Loader2 size={18} className="mob-spin" />
                <span>Activando licencia...</span>
              </>
            ) : (
              <>
                <span>Activar y Crear Cuenta</span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>
      )}

      {/* Footer */}
      <div className="mob-footer">
        <span className="mob-footer-text">
          {activeTab === 'login' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}
        </span>{' '}
        <button
          type="button"
          className="mob-footer-link"
          onClick={() => {
            setActiveTab(activeTab === 'login' ? 'register' : 'login');
            setError('');
          }}
        >
          {activeTab === 'login' ? 'Regístrate aquí' : 'Inicia sesión'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="mob-screen-wrapper">
      {/* Outer ambient monogram background for desktop browser preview */}
      <InteractiveBackground variant="desktop" opacity={0.25} />

      {/* On native devices (or narrow screens), render directly; on desktop browser, render inside an elegant phone mockup frame */}
      {isMobileNative ? (
        <div className="mob-native-screen">
          <InteractiveBackground variant="mobile" contained />
          <div className="mob-phone-inner">
            {content}
          </div>
        </div>
      ) : (
        <div className="mob-phone-frame">
          <InteractiveBackground variant="mobile" contained />
          <div className="mob-phone-notch" />
          <div className="mob-phone-inner">
            {content}
          </div>
        </div>
      )}
    </div>
  );
}

export default LoginMobile;
