import { useEffect, useState } from 'react';
import { LayoutDashboard, Layers, Radio, CreditCard, Settings, FileText, UserCheck } from 'lucide-react';
import { Sidebar } from './components/Sidebar/Sidebar';
import { LoginScreen } from './components/Login/LoginScreen';
import { DashboardDesktop } from './views/desktop/DashboardDesktop';
import { DashboardMobile } from './views/mobile/DashboardMobile';
import { ProfilesView } from './components/Profiles/ProfilesView';
import { SessionsView } from './components/Sessions/SessionsView';
import { SettingsView } from './components/Settings/SettingsView';
import { UsersView } from './components/Users/UsersView';
import { ContentView } from './components/Content/ContentView';
import { PlansView } from './components/Plans/PlansView';
import { SetupWizard } from './components/Setup/SetupWizard';
import { InteractiveBackground } from './components/Common/InteractiveBackground';
import { useAuth } from './hooks/useAuth';
import { usePublicContent } from './hooks/usePublicContent';
import { applyAppTheme } from './theme/applyTheme';
import { isTauri } from './services/tauriBridge';
import { isMobileNative } from './services/mobileBrowser';
import { usePlatform } from './context/PlatformContext';
import { getBranding } from './config/branding';
import './App.css';

const appBrand = getBranding();

type View = 'dashboard' | 'profiles' | 'sessions' | 'settings' | 'users' | 'content' | 'planes';
type AuthView = 'login' | 'register';

export default function App() {
  const { platform } = usePlatform();
  const { user, loading, login, register, logout, updateUser } = useAuth();
  const publicContent = usePublicContent();

  // El tema se aplica en la raíz para que cubra login, escritorio y móvil.
  // El CSS viaja con el contenido publicado: cambiarlo no exige otro build.
  useEffect(() => {
    applyAppTheme(publicContent.theme);
  }, [publicContent.theme.id, publicContent.theme.version, publicContent.theme.css]);

  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem('krakenges_last_view') as View;
    return (saved && ['dashboard', 'profiles', 'sessions', 'settings', 'users', 'content', 'planes'].includes(saved)) ? saved : 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState<boolean>(false);
  // Primera ejecución tras instalar: dispara el asistente de dependencias
  // antes de la pantalla de login. Se persiste en localStorage para no
  // fastidiar en cada arranque.
  const [firstRun, setFirstRun] = useState<boolean>(
    () => isTauri && typeof localStorage !== 'undefined' && localStorage.getItem('krakenges_setup_done') !== '1'
  );

  if (loading) {
    return (
      <div className="app-loading">
        <InteractiveBackground />
        <div className="app-loading-inner">
          <div className="app-loading-badge-wrap">
            <div className="app-loading-badge" style={{ overflow: 'hidden', padding: 0 }}>
              <img src="/icon.png" alt={appBrand.appName} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
            </div>
            <div className="app-loading-pulse-ring" />
          </div>
          <div className="app-loading-brand">{appBrand.appName}</div>
          <div className="app-loading-status">Inicializando subsistemas stealth...</div>
          <div className="app-loading-progress-bar">
            <div className="app-loading-progress-beam" />
          </div>
        </div>
      </div>
    );
  }

  // Primera ejecución: se instalan las dependencias ANTES de pedir el login.
  if (firstRun && !setupWizardOpen) {
    return (
      <SetupWizard 
        onComplete={() => {
          localStorage.setItem('krakenges_setup_done', '1');
          setFirstRun(false);
          setSetupWizardOpen(false);
        }}
      />
    );
  }

  if (!user) {
    // SIN MODO DEMO.
    //
    // Antes habia un boton "Modo Preview" que entraba sin credenciales con un
    // usuario inventado: "Operador Ghost", admin, root, plan Enterprise y 9999
    // creditos. En una app que se vende eso no puede existir: cualquiera que
    // instale el APK entra como administrador sin pagar nada, y encima ve datos
    // que no son suyos. Se ha quitado de los tres sitios donde estaba (login
    // movil, login escritorio y registro).
    return (
      <LoginScreen 
        onLogin={login} 
        onRegister={register}
      />
    );
  }

  const handleNavigate = (v: View) => {
    if (v === 'users' && !user.isAdmin) return;
    if (v === 'content' && !user.isAdmin) return;
    localStorage.setItem('krakenges_last_view', v);
    setView(v);
  };

  const handleLogout = () => {
    logout();
  };

  // Helper to render the active view content
  const renderViewContent = () => {
    switch (view) {
      case 'dashboard':
        return platform === 'mobile' 
          ? <DashboardMobile user={user} onNavigate={handleNavigate} onLogout={handleLogout} />
          : <DashboardDesktop user={user} onNavigate={handleNavigate} />;
      case 'profiles':
        return <ProfilesView />;
      case 'sessions':
        return <SessionsView />;
      case 'planes':
        return <PlansView user={user} />;
      case 'users':
        return user.isAdmin ? <UsersView /> : <DashboardDesktop user={user} onNavigate={handleNavigate} />;
      case 'content':
        return user.isAdmin ? <ContentView /> : <DashboardDesktop user={user} onNavigate={handleNavigate} />;
      case 'settings':
        return (
          <SettingsView 
            user={user} 
            onUpdateUser={updateUser} 
            onOpenSetupWizard={() => setSetupWizardOpen(true)}
          />
        );
      default:
        return platform === 'mobile' 
          ? <DashboardMobile user={user} onNavigate={handleNavigate} onLogout={handleLogout} />
          : <DashboardDesktop user={user} onNavigate={handleNavigate} />;
    }
  };

  // Mobile Bottom Navigation Bar
  const renderMobileBottomNav = (isChassis: boolean) => (
    <nav
      className={isChassis ? "mob-phone-bottom-bar" : "mobile-bottom-nav"}
      style={{ gridTemplateColumns: `repeat(${user.isAdmin ? 7 : 5}, minmax(0, 1fr))` }}
    >
      <button 
        type="button" 
        onClick={() => handleNavigate('dashboard')} 
        className={`mobile-nav-item ${view === 'dashboard' ? 'active' : ''}`}
      >
        {view === 'dashboard' && <span className="mobile-nav-indicator" />}
        <LayoutDashboard size={18} />
        <span className="mobile-nav-label">Overview</span>
      </button>

      <button 
        type="button" 
        onClick={() => handleNavigate('profiles')} 
        className={`mobile-nav-item ${view === 'profiles' ? 'active' : ''}`}
      >
        {view === 'profiles' && <span className="mobile-nav-indicator" />}
        <Layers size={18} />
        <span className="mobile-nav-label">Perfiles</span>
      </button>

      <button 
        type="button" 
        onClick={() => handleNavigate('sessions')} 
        className={`mobile-nav-item ${view === 'sessions' ? 'active' : ''}`}
      >
        {view === 'sessions' && <span className="mobile-nav-indicator" />}
        <Radio size={18} />
        <span className="mobile-nav-label">Sesiones</span>
      </button>

      <button 
        type="button" 
        onClick={() => handleNavigate('planes')} 
        className={`mobile-nav-item ${view === 'planes' ? 'active' : ''}`}
      >
        {view === 'planes' && <span className="mobile-nav-indicator" />}
        <CreditCard size={18} />
        <span className="mobile-nav-label">Planes</span>
      </button>

      {user.isAdmin && (
        <button
          type="button"
          onClick={() => handleNavigate('users')}
          className={`mobile-nav-item ${view === 'users' ? 'active' : ''}`}
          title="Consola Owner"
        >
          {view === 'users' && <span className="mobile-nav-indicator" />}
          <UserCheck size={18} />
          <span className="mobile-nav-label">Owner</span>
        </button>
      )}

      {user.isAdmin && (
        <button
          type="button"
          onClick={() => handleNavigate('content')}
          className={`mobile-nav-item ${view === 'content' ? 'active' : ''}`}
          title="Contenido"
        >
          {view === 'content' && <span className="mobile-nav-indicator" />}
          <FileText size={18} />
          <span className="mobile-nav-label">Contenido</span>
        </button>
      )}

      <button 
        type="button" 
        onClick={() => handleNavigate('settings')} 
        className={`mobile-nav-item ${view === 'settings' ? 'active' : ''}`}
      >
        {view === 'settings' && <span className="mobile-nav-indicator" />}
        <Settings size={18} />
        <span className="mobile-nav-label">Ajustes</span>
      </button>
    </nav>
  );

  // ══════════════════════════════════════════════════════════════
  // DEDICATED MOBILE VIEWPORT (PHONE CHASSIS PREVIEW OR NATIVE)
  // ══════════════════════════════════════════════════════════════
  if (platform === 'mobile') {
    const isNarrowViewport = typeof window !== 'undefined' && window.innerWidth < 768;
    const renderInChassis = !isMobileNative && !isNarrowViewport;

    if (renderInChassis) {
      return (
        <>
          {setupWizardOpen && (
            <SetupWizard 
              onComplete={() => setSetupWizardOpen(false)} 
              onSkip={() => setSetupWizardOpen(false)} 
            />
          )}
          <div className="mob-preview-wrapper">
            {/* Ambient Louis Vuitton Monogram background in desktop viewport */}
            <InteractiveBackground variant="desktop" opacity={0.25} />

            {/* Centered Smartphone Chassis Frame */}
            <div className="mob-phone-frame">
              <InteractiveBackground variant="mobile" contained />
              <div className="mob-phone-notch" />
              
              <div className="mob-phone-screen">
                <div className="mob-phone-scroll-body">
                  {renderViewContent()}
                </div>
                {renderMobileBottomNav(true)}
              </div>
            </div>
          </div>
        </>
      );
    }

    // Native Mobile (Capacitor APK or Real Mobile Browser)
    return (
      <>
        {setupWizardOpen && (
          <SetupWizard 
            onComplete={() => setSetupWizardOpen(false)} 
            onSkip={() => setSetupWizardOpen(false)} 
          />
        )}
        <div className="mob-native-screen">
          <InteractiveBackground variant="mobile" contained />
          <div className="mob-native-scroll-body">
            {renderViewContent()}
          </div>
          {renderMobileBottomNav(false)}
        </div>
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // DEDICATED DESKTOP WIDESCREEN VIEWPORT (FLEET SIDEBAR + DASHBOARD)
  // ══════════════════════════════════════════════════════════════
  return (
    <>
      {setupWizardOpen && (
        <SetupWizard 
          onComplete={() => setSetupWizardOpen(false)} 
          onSkip={() => setSetupWizardOpen(false)} 
        />
      )}
      <div className="app-layout">
        <Sidebar
          user={user}
          currentView={view}
          onNavigate={handleNavigate}
          onLogout={handleLogout}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <main className="app-main">
          <div className="app-content">
            {renderViewContent()}
          </div>
        </main>
      </div>
    </>
  );
}
