import { usePlatform } from '../../context/PlatformContext';
import { Laptop, Smartphone } from 'lucide-react';

export function PlatformDevSwitcher() {
  const { platform, setPlatform, isNativeMobile, isNativeDesktop } = usePlatform();

  // In packaged production on native device, hide switcher
  if (import.meta.env.PROD && (isNativeMobile || isNativeDesktop)) return null;
  // On smartphones and touch mobile screens (< 768px), hide switcher to avoid overlaying app headers
  if (typeof window !== 'undefined' && window.innerWidth < 768) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 6px',
        borderRadius: '14px',
        background: 'rgba(8, 8, 10, 0.94)',
        border: '1px solid rgba(255, 255, 255, 0.16)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        boxShadow: '0 12px 36px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.06)',
        userSelect: 'none',
        pointerEvents: 'auto',
        fontFamily: "'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif"
      }}
    >
      <div 
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          padding: '0 6px 0 2px',
          borderRight: '1px solid rgba(255, 255, 255, 0.1)'
        }}
      >
        <span 
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '999px',
            backgroundColor: '#10b981',
            boxShadow: '0 0 8px #10b981'
          }}
        />
        <span 
          style={{
            fontSize: '9.5px',
            fontWeight: 800,
            letterSpacing: '0.08em',
            color: 'rgba(255, 255, 255, 0.45)',
            textTransform: 'uppercase'
          }}
        >
          VIEW
        </span>
      </div>

      <button
        type="button"
        onClick={() => setPlatform('desktop')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          borderRadius: '9px',
          background: platform === 'desktop' ? '#ffffff' : 'transparent',
          border: 'none',
          color: platform === 'desktop' ? '#000000' : '#8c8c94',
          fontSize: '11px',
          fontWeight: 700,
          cursor: 'pointer',
          transition: 'all 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: platform === 'desktop' ? '0 2px 10px rgba(255, 255, 255, 0.25)' : 'none'
        }}
      >
        <Laptop size={13} strokeWidth={2.4} />
        <span>Desktop</span>
      </button>

      <button
        type="button"
        onClick={() => setPlatform('mobile')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          borderRadius: '9px',
          background: platform === 'mobile' ? '#ffffff' : 'transparent',
          border: 'none',
          color: platform === 'mobile' ? '#000000' : '#8c8c94',
          fontSize: '11px',
          fontWeight: 700,
          cursor: 'pointer',
          transition: 'all 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: platform === 'mobile' ? '0 2px 10px rgba(255, 255, 255, 0.25)' : 'none'
        }}
      >
        <Smartphone size={13} strokeWidth={2.4} />
        <span>Mobile</span>
      </button>
    </div>
  );
}
