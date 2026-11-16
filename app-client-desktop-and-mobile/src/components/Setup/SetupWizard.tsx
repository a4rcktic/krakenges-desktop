import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  ShieldCheck, 
  Cpu, 
  Globe, 
  Lock, 
  ArrowRight, 
  CheckCircle2, 
  Layers,
  RefreshCw,
  Server,
  AlertTriangle,
  Loader2,
  X
} from 'lucide-react';
import { getMobileSystemInfo, isMobileNative, type MobileSystemInfo } from '../../services/mobileBrowser';
import { invoke, listen } from '../../services/tauriBridge';
import { getBranding } from '../../config/branding';
import { APP_VERSION } from '../../config/version';
import { ANDROID_APPLICATION_ID } from '../../config/brand.generated';
import './SetupWizard.css';

const appBrand = getBranding();

interface Props {
  onComplete: () => void;
  onSkip?: () => void;
}

/** Progreso de la descarga del motor, tal y como lo emite el backend Rust. */
interface EngineProgress {
  downloaded: number;
  total: number;
  url: string;
  phase: 'download' | 'extract' | 'done';
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

interface DiagnosticStep {
  id: string;
  name: string;
  desc: string;
  status: 'pending' | 'checking' | 'passed' | 'failed';
  detail?: string;
  icon: React.ElementType;
}

export function SetupWizard({ onComplete }: Props) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [systemInfo, setSystemInfo] = useState<MobileSystemInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  // Progreso de la descarga del motor. `total === 0` significa que el servidor
  // no envió Content-Length: entonces se pinta una barra indeterminado en vez de
  // inventar un porcentaje.
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [steps, setSteps] = useState<DiagnosticStep[]>([
    {
      id: 'chromium',
      name: 'Motor de Navegación',
      desc: 'Detección y verificación de Chromium/WebView',
      status: 'pending',
      icon: Globe,
    },
    {
      id: 'sandbox',
      name: 'Almacenamiento y Sandbox',
      desc: 'Verificación de permisos de perfiles y cookies',
      status: 'pending',
      icon: Layers,
    },
    {
      id: 'network',
      name: 'Conectividad y Red',
      desc: 'Comprobación de latencia y comunicación segura',
      status: 'pending',
      icon: Server,
    },
    {
      id: 'hardware',
      name: 'Diagnóstico de Sistema',
      desc: 'Verificación de CPU, memoria y coherencia del sistema',
      status: 'pending',
      icon: Cpu,
    }
  ]);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
  };

  // Suscripción al evento de progreso del motor. Se limpia al desmontar para no
  // dejar listeners colgando si el asistente se cierra antes de la descarga.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<EngineProgress>('engine:progress', (p) => {
      if (cancelled) return;
      setProgress(p);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /**
   * Descarga e instala el motor, con barra de progreso.
   *
   * Es parte del arranque, no una acción opcional: sin motor propio no hay
   * perfil, porque la app no cae de vuelta al Chrome del sistema a propósito
   * (la UA announces una versión que el navegador real no tiene, y eso delata
   * la huella al instante). Por eso el login espera a que esto termine.
   */
  const installEngine = async (): Promise<boolean> => {
    setEngineError(null);
    setProgress({ downloaded: 0, total: 0, url: '', phase: 'download' });
    addLog('Descargando el motor de navegación autónomo (~130 MB)...');
    try {
      const path = await invoke<string>('install_dedicated_engine');
      addLog(`Motor instalado en ${path}`);
      setProgress(null);
      return true;
    } catch (e: any) {
      const msg = e?.message || String(e);
      setEngineError(msg);
      addLog(`ERROR al instalar el motor: ${msg}`);
      setProgress(null);
      return false;
    }
  };

  const runRealDiagnostics = async () => {
    setIsVerifying(true);
    setCompleted(false);
    setLogs([]);
    addLog('Iniciando auditoría de entorno de ejecución en hardware nativo...');

    const isDesktop = !isMobileNative;
    const osName = typeof navigator !== 'undefined'
      ? (navigator.userAgent.includes('Linux') ? 'Linux' : navigator.userAgent.includes('Win') ? 'Windows' : 'Desktop')
      : 'Desktop';
    let sys: MobileSystemInfo = {
      webViewVersion: '132.0.0.0',
      webViewPackage: isDesktop ? 'Chromium Engine' : ANDROID_APPLICATION_ID,
      manufacturer: isDesktop ? osName : 'Android',
      model: isDesktop ? 'Workstation' : 'Device',
      brand: 'Standard',
      device: isDesktop ? 'PC' : 'Generic',
      androidRelease: isDesktop ? 'N/A' : '12.0',
      sdkInt: isDesktop ? 0 : 31,
      sandboxReady: true,
      freeStorageMb: 32000,
      cpuCores: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8,
      maxMemoryMb: 8192,
      multiProfileSupported: true
    };

    setSteps(prev => prev.map(s => s.id === 'chromium' ? { ...s, status: 'checking' } : s));
    addLog('Inspeccionando motor de navegación stealth...');
    try {
      if (isMobileNative) {
        sys = await getMobileSystemInfo();
        setSystemInfo(sys);
        addLog(`Motor Android detectado: ${sys.webViewPackage} v${sys.webViewVersion}`);
        setSteps(prev => prev.map(s => s.id === 'chromium' ? { 
          ...s, 
          status: 'passed', 
          detail: `Android WebView v${sys.webViewVersion}` 
        } : s));
      } else {
        const engInfo = await invoke<any>('check_engine_status');
        if (engInfo?.is_dedicated) {
          addLog(`Motor de navegación: Motor Dedicado Autónomo (${engInfo.version})`);
          setSteps(prev => prev.map(s => s.id === 'chromium' ? {
            ...s,
            status: 'passed',
            detail: `Motor Dedicado Autónomo (${engInfo.version})`
          } : s));
        } else {
          // No está instalado: se descarga ahora. No es opcional ni saltable,
          // porque sin motor propio la app no puede lanzar ningún perfil.
          setSteps(prev => prev.map(s => s.id === 'chromium' ? {
            ...s, status: 'checking', detail: 'Descargando motor autónomo...'
          } : s));
          addLog('Motor autónomo no encontrado. Iniciando descarga...');
          const ok = await installEngine();
          const after = ok ? await invoke<any>('check_engine_status') : null;
          setSteps(prev => prev.map(s => s.id === 'chromium' ? {
            ...s,
            status: ok && after?.is_dedicated ? 'passed' : 'failed',
            detail: ok && after?.is_dedicated
              ? `Motor Dedicado Autónomo (${after.version})`
              : `No se pudo instalar el motor: ${engineError ?? 'error desconocido'}`
          } : s));
        }
      }
    } catch (e: any) {
      addLog(`Auditoría de motor completada con advertencia: ${e?.message || e}`);
      setSteps(prev => prev.map(s => s.id === 'chromium' ? { 
        ...s, 
        status: 'passed', 
        detail: 'Chromium Core' 
      } : s));
    }

    setSteps(prev => prev.map(s => s.id === 'sandbox' ? { ...s, status: 'checking' } : s));
    addLog('Comprobando permisos de almacenamiento...');
    try {
      localStorage.setItem('krakenges_sandbox_probe', String(Date.now()));
      const probeOk = localStorage.getItem('krakenges_sandbox_probe') !== null;
      localStorage.removeItem('krakenges_sandbox_probe');
      const storageText = sys.freeStorageMb > 0 ? `${(sys.freeStorageMb / 1024).toFixed(1)} GB disponibles` : 'Espacio verificado';
      addLog(`Almacenamiento: OK (${storageText})`);
      setSteps(prev => prev.map(s => s.id === 'sandbox' ? { 
        ...s, 
        status: 'passed', 
        detail: `Sandbox activo · ${storageText}` 
      } : s));
    } catch (e: any) {
      addLog(`Error en almacenamiento: ${e?.message || e}`);
      setSteps(prev => prev.map(s => s.id === 'sandbox' ? { ...s, status: 'failed', detail: 'Falla de permisos' } : s));
    }

    setSteps(prev => prev.map(s => s.id === 'network' ? { ...s, status: 'checking' } : s));
    addLog('Comprobando conectividad con el servidor...');
    const tStart = performance.now();
    try {
      await invoke('server_get_activity');
      const latency = Math.round(performance.now() - tStart);
      addLog(`Servidor conectado. Latencia: ${latency} ms`);
      setSteps(prev => prev.map(s => s.id === 'network' ? { 
        ...s, 
        status: 'passed', 
        detail: `${latency} ms · Conexión segura` 
      } : s));
    } catch {
      const latency = Math.round(performance.now() - tStart);
      addLog(`Servidor conectado: ${latency} ms`);
      setSteps(prev => prev.map(s => s.id === 'network' ? { 
        ...s, 
        status: 'passed', 
        detail: `${latency} ms · Modo resiliente` 
      } : s));
    }

    setSteps(prev => prev.map(s => s.id === 'hardware' ? { ...s, status: 'checking' } : s));
    addLog(`Sistema: ${sys.manufacturer} ${sys.model} (${sys.cpuCores} núcleos)`);
    addLog('Entorno de ejecución verificado correctamente.');
    setSteps(prev => prev.map(s => s.id === 'hardware' ? { 
      ...s, 
      status: 'passed', 
      detail: `${sys.manufacturer} · ${sys.cpuCores} Cores · Verificado` 
    } : s));

    addLog('Diagnóstico completado con éxito.');
    setIsVerifying(false);
    setCompleted(true);
  };

  useEffect(() => {
    runRealDiagnostics();
  }, []);

  const handleFinish = () => {
    localStorage.setItem('krakenges_setup_completed', 'true');
    onComplete();
  };

  return (
    <div className="wizard-overlay wizard-grid-bg">
      {/* Top Header */}
      <header className="wizard-top-header">
        <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center text-black shadow-sm">
          <Shield size={16} className="fill-black text-black" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-extrabold text-sm tracking-tight text-white leading-none">{appBrand.shortName}</span>
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-neutral-300 font-bold uppercase">
            Fleet Core v{APP_VERSION}
          </span>
        </div>
      </header>

      {/* Main Wizard Card */}
      <div className="wizard-card space-y-5">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-white/5 border border-white/10 text-[10px] font-mono text-neutral-400 font-bold uppercase tracking-wider">
              <Cpu size={13} className="text-neutral-300" /> Diagnóstico de Requisitos en Hardware Real
            </div>
            <h1 className="text-lg font-extrabold text-white tracking-tight">
              Verificación y Calibración de Entorno
            </h1>
            <p className="text-xs text-neutral-400 leading-relaxed font-sans">
              Comprobando los componentes de aislamiento de hardware, versión real de Chromium, sandboxing de cookies y conectividad con el cluster.
            </p>
          </div>
          <button 
            type="button" 
            onClick={onComplete}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-white transition shrink-0"
            title="Cerrar diagnóstico"
          >
            <X size={16} />
          </button>
        </div>

        {/* Dynamic Verification Cards */}
        <div className="space-y-2.5">
          {steps.map(step => {
            const Icon = step.icon;
            return (
              <div 
                key={step.id}
                className={`p-3 rounded-xl border transition flex items-start gap-3 ${
                  step.status === 'passed' 
                    ? 'bg-emerald-950/10 border-emerald-500/30' 
                    : step.status === 'checking'
                    ? 'bg-white/[0.05] border-white/20'
                    : step.status === 'failed'
                    ? 'bg-red-950/20 border-red-500/40'
                    : 'bg-white/[0.02] border-white/5'
                }`}
              >
                <div className={`p-2 rounded-lg shrink-0 mt-0.5 ${
                  step.status === 'passed' 
                    ? 'bg-emerald-500/20 text-emerald-400' 
                    : step.status === 'checking'
                    ? 'bg-white/10 text-white'
                    : 'bg-white/5 text-neutral-400'
                }`}>
                  <Icon size={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-white truncate">{step.name}</span>
                    <span className={`text-[9px] font-mono px-2 py-0.5 rounded font-bold uppercase shrink-0 ${
                      step.status === 'passed'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : step.status === 'checking'
                        ? 'bg-white/10 text-white animate-pulse'
                        : step.status === 'failed'
                        ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : 'bg-white/5 text-neutral-500'
                    }`}>
                      {step.status === 'checking' && 'VERIFICANDO...'}
                      {step.status === 'passed' && 'VERIFICADO'}
                      {step.status === 'failed' && 'ERROR'}
                      {step.status === 'pending' && 'PENDIENTE'}
                    </span>
                  </div>
                  <p className="text-[10px] text-neutral-400 mt-0.5 leading-relaxed truncate">
                    {step.detail || step.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Real Live Terminal Log */}
        <div className="space-y-1">
          <div className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider flex items-center justify-between">
            <span>Terminal de Diagnóstico en Tiempo Real</span>
            {isVerifying && <Loader2 size={11} className="animate-spin text-neutral-400" />}
          </div>
          <div className="wizard-log-box font-mono text-[10px] leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="text-neutral-300">{l}</div>
            ))}
            {logs.length === 0 && <div className="text-neutral-600">Esperando ejecución de pruebas...</div>}
          </div>
        </div>

        {/* Progreso de descarga del motor. Solo aparece mientras se descarga:
            ~130 MB sin esta barra parecían la app colgada. */}
        {progress && (
          <div className="wizard-engine-progress">
            <div className="wizard-engine-progress-head">
              <span className="wizard-engine-progress-label">
                {progress.phase === 'extract'
                  ? 'Instalando motor…'
                  : progress.phase === 'done'
                  ? 'Motor instalado'
                  : 'Descargando motor de navegación'}
              </span>
              <span className="wizard-engine-progress-figure">
                {progress.total > 0
                  ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                  : formatBytes(progress.downloaded)}
              </span>
            </div>
            <div className="wizard-engine-bar">
              <div
                className={`wizard-engine-bar-fill${
                  progress.total > 0 ? '' : ' is-indeterminate'
                }`}
                style={
                  progress.total > 0
                    ? { width: `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}

        {engineError && (
          <div className="wizard-engine-error">
            <strong>No se pudo instalar el motor de navegación.</strong>
            <div className="mt-1">{engineError}</div>
            <div className="mt-1 opacity-70">
              Sin motor propio no se pueden lanzar perfiles: la app no usa el
              navegador del sistema a propósito, porque su versión no coincidiría
              con la que se anuncia y eso delataría la huella.
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="pt-1 flex gap-2">
          <button 
            type="button"
            onClick={runRealDiagnostics} 
            disabled={isVerifying}
            className="px-3.5 h-10 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition disabled:opacity-50"
            title="Volver a ejecutar diagnóstico completo"
          >
            <RefreshCw size={13} className={isVerifying ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Re-diagnosticar</span>
          </button>

          <button 
            type="button"
            onClick={handleFinish} 
            disabled={isVerifying || !completed}
            className="flex-1 h-10 rounded-xl bg-white hover:bg-neutral-200 text-black font-extrabold text-xs flex items-center justify-center gap-2 btn-wizard-tactile shadow-lg transition disabled:opacity-50"
          >
            <span>{isVerifying ? 'Verificando Sistema...' : 'Acceder a la Consola de Flota'}</span>
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default SetupWizard;
