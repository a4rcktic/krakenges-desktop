import { useState, useMemo, useEffect } from 'react';
import { 
  Eye, 
  EyeOff, 
  Lock, 
  User as UserIcon, 
  Key, 
  Loader2, 
  ArrowRight, 
  AlertCircle, 
  Sparkles, 
  Laptop,
  Shield,
  KeyRound
} from 'lucide-react';
import { InteractiveBackground } from '../Common/InteractiveBackground';
import { getBranding } from '../../config/branding';
import '../Login/LoginScreen.css';
import './RegisterScreen.css';

const appBrand = getBranding();

interface Props {
  onRegister: (data: { name: string; username: string; password: string; key: string }) => Promise<any>;
  onGoToLogin?: () => void;
  onBackToLogin?: () => void;
}

export function RegisterScreen({ onRegister, onGoToLogin, onBackToLogin }: Props) {
  const handleGoToLogin = onBackToLogin || onGoToLogin;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Realtime clock for Hyprland Waybar module
  const [timeStr, setTimeStr] = useState(() => {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const d = new Date();
      setTimeStr(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fast client-side password strength (0 to 4 score)
  const passwordStrength = useMemo(() => {
    if (!password) return 0;
    let score = 0;
    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    return score;
  }, [password]);

  const strengthLabels = ['MUY DÉBIL', 'DÉBIL', 'ACEPTABLE', 'SEGURA', 'BLINDADA (100%)'];
  const strengthColors = ['#ef4444', '#f97316', '#eab308', '#10b981', '#06b6d4'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username?.trim() || !password || !licenseKey?.trim()) return;

    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }

    if (!licenseKey?.trim()) {
      setError('El código de licencia es obligatorio.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await onRegister({
        name: username.trim(),
        username: username.trim(),
        password,
        key: licenseKey.trim().toUpperCase(),
      });
    } catch (err: any) {
      console.error('REGISTER ERROR:', err);
      const msg = typeof err === 'string'
        ? err
        : (err?.message || err?.error || 'Error al validar la licencia.');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen-wrapper">
      <InteractiveBackground />

      <div className="master-container master-container-reg">
        {/* Top Floating Waybar Module (Hyprland Dark Rice) */}
        <div className="master-waybar">
          <div className="master-waybar-left">
            <span className="master-ws">1</span>
            <span className="master-ws active">
              <span className="master-ws-dot" />
              <span>2</span>
            </span>
            <span className="master-ws">3</span>
          </div>

          <div className="master-waybar-center">
            <KeyRound size={12} className="text-cyan-400" />
            <span className="master-waybar-title">{appBrand.appName.toLowerCase()}</span>
            <span className="master-waybar-sep">/</span>
            <span className="master-waybar-status">fleet-activation</span>
          </div>

          <div className="master-waybar-right">
            <span className="master-waybar-clock">{timeStr}</span>
          </div>
        </div>

        {/* Master Window Frame with Electric Neon Hyprland Active Border */}
        <div className="master-window-frame">
          <div className="master-card">
            
            {/* Header: Glowing App Emblem & Title */}
            <div className="master-header">
              <div className="master-emblem-wrap">
                <div className="master-emblem-halo" />
                <div className="master-emblem-box">
                  <img 
                    src="/icon.png" 
                    alt={appBrand.appName}
                    className="master-emblem-img"
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = 'none';
                    }}
                  />
                  <div className="master-emblem-fallback">
                    <KeyRound size={26} className="text-cyan-400" />
                  </div>
                </div>
              </div>

              <h1 className="master-title">
                Crear <span>Cuenta</span>
              </h1>
              <p className="master-subtitle">Activa tu terminal con tu código de licencia</p>
            </div>

            {/* Waybar Floating Pill Switcher: Login / Register */}
            <div className="master-pill-tabs">
              <button 
                type="button" 
                className="master-tab"
                onClick={handleGoToLogin}
              >
                <span>Iniciar Sesión</span>
              </button>
              <button 
                type="button" 
                className="master-tab active"
              >
                <span className="master-tab-glow" />
                <span>Crear Cuenta</span>
              </button>
            </div>

            {/* Error Message Alert */}
            {error && (
              <div className="master-error-alert">
                <AlertCircle size={15} className="flex-shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} className="master-form">
              {/* Field 1: User */}
              <div className="master-field">
                <label className="master-label">NOMBRE DE USUARIO</label>
                <div className="master-input-wrap">
                  <div className="master-input-icon">
                    <UserIcon size={16} />
                  </div>
                  <input
                    type="text"
                    className="master-input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="nuevo_operador"
                    required
                    autoFocus
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              </div>

              {/* Field 2: Password */}
              <div className="master-field">
                <label className="master-label">CONTRASEÑA DE ACCESO</label>
                <div className="master-input-wrap">
                  <div className="master-input-icon">
                    <Lock size={16} />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="master-input master-input-pass"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                    required
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="master-eye-btn"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    aria-label="Mostrar u ocultar contraseña"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {/* Password Stepped Strength Bar */}
                {password.length > 0 && (
                  <div className="master-strength-wrap">
                    <div className="master-strength-bars">
                      {[1, 2, 3, 4].map((step) => (
                        <div 
                          key={step} 
                          className="master-strength-bar"
                          style={{
                            backgroundColor: step <= passwordStrength 
                              ? strengthColors[passwordStrength] 
                              : 'rgba(255, 255, 255, 0.08)'
                          }}
                        />
                      ))}
                    </div>
                    <span 
                      className="master-strength-label"
                      style={{ color: strengthColors[passwordStrength] }}
                    >
                      {strengthLabels[passwordStrength]}
                    </span>
                  </div>
                )}
              </div>

              {/* Field 3: Confirm Password */}
              <div className="master-field">
                <label className="master-label">CONFIRMAR CONTRASEÑA</label>
                <div className="master-input-wrap">
                  <div className="master-input-icon">
                    <Lock size={16} />
                  </div>
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    className={`master-input master-input-pass ${confirmPassword && password !== confirmPassword ? 'master-input-mismatch' : ''}`}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repite tu contraseña exacta"
                    required
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="master-eye-btn"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    tabIndex={-1}
                    aria-label="Mostrar u ocultar contraseña"
                  >
                    {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {confirmPassword && password !== confirmPassword && (
                  <span className="master-mismatch-msg">⚠ Las contraseñas no coinciden</span>
                )}
              </div>

              {/* Field 4: License Key */}
              <div className="master-field">
                <div className="master-field-header">
                  <label className="master-label flex items-center gap-1.5">
                    <Key size={13} className="text-cyan-400" />
                    <span>CÓDIGO DE LICENCIA</span>
                  </label>
                  <span className="master-req-badge">REQUERIDO</span>
                </div>
                <div className="master-input-wrap master-input-key-wrap">
                  <div className="master-input-icon text-cyan-400">
                    <Key size={16} />
                  </div>
                  <input
                    type="text"
                    className="master-input master-key-input"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                    placeholder="MSK-XXXX-XXXX"
                    required
                    spellCheck={false}
                  />
                </div>
                <p className="master-field-hint">Proporcionado por tu asesor o proveedor autorizado.</p>
              </div>

              {/* Submit Action Button */}
              <button
                type="submit"
                disabled={loading || !username?.trim() || !password || !licenseKey?.trim() || (password !== confirmPassword)}
                className="master-btn-submit"
              >
                <div className="master-btn-shimmer" />
                {loading ? (
                  <>
                    <Loader2 size={16} className="master-spin" />
                    <span>Validando clave de flota...</span>
                  </>
                ) : (
                  <>
                    <Shield size={16} />
                    <span>Activar Licencia & Crear Cuenta</span>
                    <ArrowRight size={16} className="master-btn-arrow" />
                  </>
                )}
              </button>
            </form>

            {/* Footer */}
            <div className="master-footer">
              <span>¿Ya cuentas con licencia activada?</span>{' '}
              <button
                type="button"
                className="master-footer-link"
                onClick={handleGoToLogin}
              >
                Iniciar sesión aquí
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default RegisterScreen;
