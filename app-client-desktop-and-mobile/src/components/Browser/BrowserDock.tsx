import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, X, Lock, Shield } from 'lucide-react';
import { invoke } from '../../services/tauriBridge';
import './BrowserDock.css';

export function BrowserDock({ profileId }: { profileId: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('https://pixelscan.net');
  const [navState, _setNavState] = useState({ canGoBack: false, canGoForward: false, isLoading: false });

  // Sincronizar dimensiones exactas del viewport con el Webview nativo hijo
  const syncBounds = () => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    invoke('resize_embedded_browser', {
      profileId,
      bounds: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    }).catch((err) => console.error('Error redimensionando webview embebido:', err));
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();

    // Crear el Webview hijo incrustado dentro del contenedor de Kraken Ges
    invoke('create_embedded_browser', {
      profileId,
      url: url || 'https://pixelscan.net',
      bounds: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    }).catch((err) => console.error('Error creando webview embebido:', err));

    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);
    window.addEventListener('resize', syncBounds);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
      // Ocultar o cerrar la vista al salir
      invoke('close_embedded_browser', { profileId }).catch(() => {});
    };
  }, [profileId]);

  const handleClose = () => {
    invoke('close_embedded_browser', { profileId }).catch(() => {});
    window.dispatchEvent(new CustomEvent('krakenges:browser-close', { detail: { profileId } }));
  };

  return (
    <div className="browser-dock">
      <div className="browser-toolbar">
        <div className="browser-nav-group">
          <button type="button" className="browser-btn" disabled={!navState.canGoBack} title="Atrás">
            <ArrowLeft size={16} />
          </button>
          <button type="button" className="browser-btn" disabled={!navState.canGoForward} title="Adelante">
            <ArrowRight size={16} />
          </button>
          <button type="button" className="browser-btn" title="Recargar">
            <RotateCw size={15} />
          </button>
        </div>

        <div className="browser-omnibox">
          <Lock size={13} className="browser-lock-icon" />
          <input
            type="text"
            className="browser-url-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Escribe una URL o busca..."
          />
        </div>

        <div className="browser-actions-group">
          <div className="browser-profile-badge">
            <Shield size={12} className="text-cyan-400" />
            <span>Perfil Aislado: {profileId}</span>
          </div>

          <button
            type="button"
            className="browser-btn browser-btn-close"
            onClick={handleClose}
            title="Cerrar pestaña del navegador"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div ref={viewportRef} className="browser-viewport" />
    </div>
  );
}