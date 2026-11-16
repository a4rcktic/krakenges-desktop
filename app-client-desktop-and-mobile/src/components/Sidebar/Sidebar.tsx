import { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  Layers, 
  Radio, 
  Settings, 
  LogOut, 
  Shield, 
  UserCheck, 
  CreditCard, 
  PanelLeftClose, 
  PanelLeftOpen, 
  User as UserIcon,
  Crown,
  Briefcase,
  FileText
} from 'lucide-react';
import { getBranding } from '../../config/branding';
import './Sidebar.css';

const appBrand = getBranding();

interface User {
  name: string;
  email: string;
  username?: string;
  plan?: string;
  planName?: string;
  isAdmin: boolean;
  role?: string;
  sellerCredits?: number;
}

interface Props {
  user: User;
  currentView: string;
  onNavigate: (view: any) => void;
  onLogout: () => void;
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ user, currentView, onNavigate, onLogout, isOpen, onClose }: Props) {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('krakenges_sidebar_collapsed') === 'true';
  });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('krakenges_sidebar_collapsed', String(next));
      return next;
    });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleCollapse();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleNavigate = (view: string) => {
    onNavigate(view);
    onClose?.();
  };

  const isOwner = user.role === 'owner';
  const isAdmin = user.role === 'admin' || isOwner;

  const navItems = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Overview', section: 'Gestión de Flota' },
    { id: 'profiles', icon: Layers, label: 'Perfiles Stealth', section: 'Gestión de Flota' },
    { id: 'sessions', icon: Radio, label: 'Sesiones en Marcha', section: 'Gestión de Flota', isLive: true },
    { id: 'planes', icon: CreditCard, label: 'Planes & Cuotas', section: 'Gestión de Flota' },
    ...(isAdmin ? [
      { id: 'users', icon: UserCheck, label: isOwner ? 'Consola Owner' : 'Panel Admin', section: 'Administración' },
      { id: 'content', icon: FileText, label: 'Contenido', section: 'Administración' },
    ] : []),
    { id: 'settings', icon: Settings, label: 'Configuración', section: 'Sistema' },
  ];

  return (
    <>
      {isOpen && <div className="sidebar-overlay" onClick={onClose} />}

      <aside className={`uber-sidebar ${isCollapsed ? 'collapsed' : ''} ${isOpen ? 'mobile-open' : ''}`}>
        <div>
          {/* Brand Header */}
          <div className="uber-sidebar-header">
            <div 
              className="uber-brand-wrap" 
              onClick={() => { if (isCollapsed) toggleCollapse(); }}
              title={isCollapsed ? `${appBrand.shortName} Fleet (Click para expandir)` : `${appBrand.shortName} Fleet`}
            >
              <div className="uber-brand-badge" style={{ overflow: 'hidden', padding: 0 }}>
                <img src="/icon.png" alt={appBrand.appName} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
              </div>
              <div className="uber-brand-info">
                <div className="uber-brand-title-row">
                  <span className="uber-brand-name">{appBrand.shortName}</span>
                  <span className="uber-brand-tag">FLEET</span>
                </div>
                <span className="uber-brand-caption">Enterprise Core</span>
              </div>
            </div>

            <button 
              type="button" 
              onClick={toggleCollapse} 
              className="uber-collapse-btn" 
              title={isCollapsed ? "Expandir barra lateral (Ctrl+B)" : "Colapsar barra lateral (Ctrl+B)"}
            >
              {isCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>

          {/* User Role Tag (Expanded only) */}
          {!isCollapsed && (
            <div className="uber-role-bar">
              {isOwner ? (
                <div className="uber-role-pill owner">
                  <Crown size={11} />
                  <span>SUPER OWNER</span>
                </div>
              ) : user.role === 'admin' ? (
                <div className="uber-role-pill admin">
                  <Shield size={11} />
                  <span>ADMINISTRADOR</span>
                </div>
              ) : user.role === 'seller' ? (
                <div className="uber-role-pill seller">
                  <Briefcase size={11} />
                  <span>SELLER ({user.sellerCredits ?? 0} CR)</span>
                </div>
              ) : (
                <div className="uber-role-pill user">
                  <Shield size={11} />
                  <span>PLAN {(user.planName || user.plan || 'GHOST').toUpperCase()}</span>
                </div>
              )}
            </div>
          )}

          {/* Navigation Menu */}
          <nav className="uber-nav">
            {!isCollapsed && <div className="uber-nav-section-label">Gestión de Flota</div>}
            
            <div className="uber-nav-group">
              {navItems.map((item) => {
                const isActive = currentView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNavigate(item.id)}
                    className={`uber-nav-btn ${isActive ? 'active' : ''}`}
                    title={item.label}
                  >
                    <div className="uber-nav-btn-inner">
                      <item.icon size={16} className="uber-nav-icon shrink-0" />
                      <span className="uber-nav-label">{item.label}</span>
                    </div>

                    {item.isLive && (
                      <span className="uber-live-indicator" title="Sesión activa">
                        <span className="uber-live-dot" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
        </div>

        {/* Footer: User Account & Logout */}
        <div className="uber-sidebar-footer">
          <div className="uber-user-card" title={`${user.name} · ${user.planName || user.plan || 'Free'}`}>
            <div className="uber-user-avatar">
              <UserIcon size={14} className="text-neutral-300" />
              <span className="uber-avatar-beacon" />
            </div>

            <div className="uber-user-info">
              <div className="uber-user-name">{user.name}</div>
              <div className="uber-user-sub">Plan: {(user.planName || user.plan || 'Ghost').toUpperCase()}</div>
            </div>

            <button
              onClick={onLogout}
              className="uber-logout-btn"
              title="Cerrar sesión"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

export default Sidebar;
