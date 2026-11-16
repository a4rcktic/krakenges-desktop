import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock3,
  Eye,
  FileText,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { invoke } from '../../hooks/useAuth';
import { PublicContent, RemotePlanOverride } from '../../hooks/usePublicContent';
import { PLANS, PlanId } from '../../domain/plans';
import '../Users/UsersView.css';
import './ContentView.css';

interface HistoryEntry {
  id: string;
  version: number;
  size: number;
  createdAt: string;
}

interface AdminContentResponse {
  content: PublicContent;
}

interface HistoryResponse {
  items: HistoryEntry[];
}

type BusyAction = 'preview' | 'publish' | 'revert' | null;
type Section = 'texts' | 'plans' | 'theme' | 'history';

const PLAN_IDS: PlanId[] = ['ghost', 'shadow', 'specter', 'phantom'];

const TEXT_FIELDS = [
  { key: 'loginTitle', label: 'Título del login', multiline: false },
  { key: 'loginTitleHighlight', label: 'Título destacado', multiline: false },
  { key: 'loginSubtitle', label: 'Subtítulo del login', multiline: true },
  { key: 'plansSummaryTitle', label: 'Título del resumen de planes', multiline: false },
  { key: 'plansSectionEyebrow', label: 'Etiqueta superior de planes', multiline: false },
  { key: 'plansSectionTitle', label: 'Título de la sección de planes', multiline: false },
] as const;

function cloneContent(content: PublicContent): PublicContent {
  return JSON.parse(JSON.stringify(content)) as PublicContent;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDate(value: string | null): string {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Limpia el contenido antes de enviarlo: sin textos vacíos y sin planes que
 * solo contengan campos vacíos. El servidor vuelve a validar todo.
 */
function sanitizeContent(content: PublicContent): PublicContent {
  const texts: Record<string, string> = {};
  for (const [key, value] of Object.entries(content.texts)) {
    if (key.trim() && value.trim()) texts[key.trim()] = value.trim();
  }

  const plans: Record<string, RemotePlanOverride> = {};
  for (const id of PLAN_IDS) {
    const plan = content.plans[id];
    if (!plan) continue;
    const clean: RemotePlanOverride = {};
    if (plan.name?.trim()) clean.name = plan.name.trim();
    if (typeof plan.price === 'number' && Number.isFinite(plan.price) && plan.price >= 0) clean.price = plan.price;
    if (plan.currency?.trim()) clean.currency = plan.currency.trim();
    if (plan.interval?.trim()) clean.interval = plan.interval.trim();
    if (plan.tagline?.trim()) clean.tagline = plan.tagline.trim();
    if (Array.isArray(plan.features)) {
      const features = plan.features.map((item) => item.trim()).filter(Boolean).slice(0, 20);
      if (features.length) clean.features = features;
    }
    if (Object.keys(clean).length) plans[id] = clean;
  }

  return {
    ...content,
    brand: { ...content.brand },
    texts,
    plans,
    theme: { ...content.theme },
  };
}

export function ContentView() {
  const [content, setContent] = useState<PublicContent | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [preview, setPreview] = useState<PublicContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [section, setSection] = useState<Section>('texts');
  const [customKey, setCustomKey] = useState('');
  const [customValue, setCustomValue] = useState('');

  const loadHistory = useCallback(async () => {
    try {
      const response = await invoke<HistoryResponse>('server_content_history');
      setHistory(response.items ?? []);
    } catch {
      // El historial es secundario: no debe tumbar el editor.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [admin, historyResponse] = await Promise.all([
        invoke<AdminContentResponse>('server_content_admin_get'),
        invoke<HistoryResponse>('server_content_history'),
      ]);
      setContent(cloneContent(admin.content));
      setHistory(historyResponse.items ?? []);
    } catch (err) {
      setError(errorMessage(err));
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const customTextKeys = useMemo(() => {
    if (!content) return [];
    return Object.keys(content.texts).filter(
      (key) => !TEXT_FIELDS.some((field) => field.key === key)
    );
  }, [content]);

  const themeIds = useMemo(() => {
    const ids = ['default', 'halloween'];
    if (content?.theme.id && !ids.includes(content.theme.id)) ids.push(content.theme.id);
    return ids;
  }, [content?.theme.id]);

  const markEdited = () => {
    setPreview(null);
    setNotice('');
  };

  const updateText = (key: string, value: string) => {
    setContent((previous) => {
      if (!previous) return previous;
      const texts = { ...previous.texts };
      if (value.trim()) texts[key] = value;
      else delete texts[key];
      return { ...previous, texts };
    });
    markEdited();
  };

  const addCustomText = () => {
    const key = customKey.trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
      setError('La clave debe usar solo letras, números, punto, guion o guion bajo (máximo 80).');
      return;
    }
    if (TEXT_FIELDS.some((field) => field.key === key)) {
      setError('Esa clave ya existe en los campos principales.');
      return;
    }
    if (!customValue.trim()) {
      setError('Escribe un valor para la clave nueva.');
      return;
    }
    setError('');
    updateText(key, customValue);
    setCustomKey('');
    setCustomValue('');
  };

  const updatePlan = (id: PlanId, patch: Partial<RemotePlanOverride>) => {
    setContent((previous) => {
      if (!previous) return previous;
      const current = previous.plans[id] ?? {};
      return {
        ...previous,
        plans: {
          ...previous.plans,
          [id]: { ...current, ...patch },
        },
      };
    });
    markEdited();
  };

  const updateTheme = (patch: Partial<PublicContent['theme']>) => {
    setContent((previous) => {
      if (!previous) return previous;
      return { ...previous, theme: { ...previous.theme, ...patch } };
    });
    markEdited();
  };

  const handlePreview = async () => {
    if (!content) return;
    setBusy('preview');
    setError('');
    setNotice('');
    try {
      const response = await invoke<AdminContentResponse>('server_content_preview', {
        content: sanitizeContent(content),
      });
      setPreview(response.content);
      setNotice('Vista previa validada por el servidor. Aún no se ha publicado.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handlePublish = async () => {
    if (!content) return;
    if (!window.confirm(`¿Publicar la versión ${content.version + 1}? La app la recogerá en menos de cinco minutos.`)) {
      return;
    }
    setBusy('publish');
    setError('');
    setNotice('');
    try {
      const response = await invoke<AdminContentResponse>('server_content_publish', {
        content: sanitizeContent(content),
      });
      setContent(cloneContent(response.content));
      setPreview(null);
      setNotice(`Contenido publicado como versión ${response.content.version}.`);
      await loadHistory();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRevert = async (entry: HistoryEntry) => {
    if (!window.confirm(`¿Restaurar la versión archivada del ${formatDate(entry.createdAt)}? Se publicará como una versión nueva.`)) {
      return;
    }
    setBusy('revert');
    setError('');
    setNotice('');
    try {
      const response = await invoke<AdminContentResponse>('server_content_revert', { id: entry.id });
      setContent(cloneContent(response.content));
      setPreview(null);
      setNotice(`Versión restaurada y publicada como ${response.content.version}.`);
      await loadHistory();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="admin-panel-view">
        <div className="content-loading">
          <Loader2 size={24} className="animate-spin" />
          <span>Cargando contenido publicado…</span>
        </div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="admin-panel-view">
        <div className="view-header">
          <div>
            <h1 className="view-title">Contenido</h1>
            <p className="view-subtitle">Textos, precios y tema de la app.</p>
          </div>
        </div>
        <div className="content-alert error">
          <AlertTriangle size={16} />
          <span>{error || 'No se pudo cargar el contenido.'}</span>
          <button type="button" className="admin-btn-secondary" onClick={() => void load()}>
            <RefreshCw size={13} />
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const disabled = busy !== null;

  return (
    <div className="admin-panel-view content-view">
      <div className="view-header content-view-header">
        <div>
          <h1 className="view-title">Contenido</h1>
          <p className="view-subtitle">
            Textos, precios y tema de la app. Publicado en la nube, sin recompilar.
          </p>
          <div className="content-version-line">
            <span className="content-version-chip">v{content.version}</span>
            <span className="content-version-date">Última publicación: {formatDate(content.updatedAt)}</span>
          </div>
        </div>

        <div className="content-header-actions">
          <button
            type="button"
            className="admin-btn-secondary"
            onClick={() => void load()}
            disabled={disabled}
            title="Volver a leer el contenido publicado"
          >
            <RefreshCw size={14} />
            Recargar
          </button>
          <button
            type="button"
            className="admin-btn-secondary"
            onClick={() => void handlePreview()}
            disabled={disabled}
          >
            {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
            Previsualizar
          </button>
          <button
            type="button"
            className="admin-btn-primary"
            onClick={() => void handlePublish()}
            disabled={disabled}
          >
            {busy === 'publish' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Publicar
          </button>
        </div>
      </div>

      {error && (
        <div className="content-alert error">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" className="content-alert-close" onClick={() => setError('')} aria-label="Cerrar aviso">
            <X size={14} />
          </button>
        </div>
      )}

      {notice && (
        <div className="content-alert success">
          <Check size={16} />
          <span>{notice}</span>
          <button type="button" className="content-alert-close" onClick={() => setNotice('')} aria-label="Cerrar aviso">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="admin-tab-switcher content-tabs">
        <button
          type="button"
          className={`admin-tab-btn ${section === 'texts' ? 'active' : ''}`}
          onClick={() => setSection('texts')}
        >
          <FileText size={14} />
          <span>Textos</span>
        </button>
        <button
          type="button"
          className={`admin-tab-btn ${section === 'plans' ? 'active' : ''}`}
          onClick={() => setSection('plans')}
        >
          <FileText size={14} />
          <span>Planes</span>
        </button>
        <button
          type="button"
          className={`admin-tab-btn ${section === 'theme' ? 'active' : ''}`}
          onClick={() => setSection('theme')}
        >
          <Eye size={14} />
          <span>Tema</span>
        </button>
        <button
          type="button"
          className={`admin-tab-btn ${section === 'history' ? 'active' : ''}`}
          onClick={() => setSection('history')}
        >
          <History size={14} />
          <span>Historial ({history.length})</span>
        </button>
      </div>

      {section === 'texts' && (
        <div className="content-tab-panel">
          <div className="content-grid">
            {TEXT_FIELDS.map((field) => (
              <div className={`content-field ${field.multiline ? 'wide' : ''}`} key={field.key}>
                <label htmlFor={`content-text-${field.key}`}>{field.label}</label>
                {field.multiline ? (
                  <textarea
                    id={`content-text-${field.key}`}
                    className="content-textarea"
                    value={content.texts[field.key] ?? ''}
                    onChange={(event) => updateText(field.key, event.target.value)}
                    rows={3}
                    placeholder="—"
                  />
                ) : (
                  <input
                    id={`content-text-${field.key}`}
                    className="content-input"
                    value={content.texts[field.key] ?? ''}
                    onChange={(event) => updateText(field.key, event.target.value)}
                    placeholder="—"
                  />
                )}
                <span className="content-field-key">{field.key}</span>
              </div>
            ))}
          </div>

          <section className="content-subsection">
            <h3 className="content-subsection-title">Claves adicionales</h3>
            <p className="content-subsection-note">
              Para textos nuevos que la app ya sepa leer. Si la clave no se usa, no se mostrará.
            </p>
            {customTextKeys.length > 0 ? (
              <div className="content-custom-list">
                {customTextKeys.map((key) => (
                  <div className="content-custom-row" key={key}>
                    <span className="content-custom-key">{key}</span>
                    <input
                      className="content-input"
                      value={content.texts[key] ?? ''}
                      onChange={(event) => updateText(key, event.target.value)}
                      aria-label={`Valor de ${key}`}
                    />
                    <button
                      type="button"
                      className="content-icon-btn danger"
                      onClick={() => updateText(key, '')}
                      title={`Eliminar ${key}`}
                      aria-label={`Eliminar ${key}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="content-empty-inline">No hay claves adicionales.</p>
            )}

            <div className="content-custom-add">
              <input
                className="content-input"
                value={customKey}
                onChange={(event) => setCustomKey(event.target.value)}
                placeholder="clave.nueva"
                aria-label="Clave nueva"
              />
              <input
                className="content-input"
                value={customValue}
                onChange={(event) => setCustomValue(event.target.value)}
                placeholder="Valor"
                aria-label="Valor de la clave nueva"
              />
              <button type="button" className="admin-btn-secondary" onClick={addCustomText}>
                <Plus size={14} />
                Añadir
              </button>
            </div>
          </section>
        </div>
      )}

      {section === 'plans' && (
        <div className="content-tab-panel">
          <div className="content-plan-grid">
            {PLAN_IDS.map((id) => {
              const base = PLANS[id];
              const plan = content.plans[id] ?? {};
              return (
                <article className="content-plan-card" key={id}>
                  <div className="content-plan-head">
                    <div>
                      <span className="content-plan-id">{base.codename}</span>
                      <h3>{base.name}</h3>
                    </div>
                    <span className="content-plan-base">Base: {base.price} {base.currency}</span>
                  </div>

                  <div className="content-plan-fields">
                    <div className="content-field">
                      <label htmlFor={`plan-${id}-name`}>Nombre</label>
                      <input
                        id={`plan-${id}-name`}
                        className="content-input"
                        value={plan.name ?? ''}
                        onChange={(event) => updatePlan(id, { name: event.target.value })}
                        placeholder={base.name}
                      />
                    </div>
                    <div className="content-field">
                      <label htmlFor={`plan-${id}-price`}>Precio</label>
                      <input
                        id={`plan-${id}-price`}
                        className="content-input"
                        type="number"
                        min={0}
                        step={1}
                        value={plan.price ?? ''}
                        onChange={(event) =>
                          updatePlan(id, {
                            price: event.target.value === '' ? undefined : Number(event.target.value),
                          })
                        }
                        placeholder={String(base.price)}
                      />
                    </div>
                    <div className="content-field">
                      <label htmlFor={`plan-${id}-currency`}>Moneda</label>
                      <input
                        id={`plan-${id}-currency`}
                        className="content-input"
                        value={plan.currency ?? ''}
                        onChange={(event) => updatePlan(id, { currency: event.target.value })}
                        placeholder={base.currency}
                      />
                    </div>
                    <div className="content-field">
                      <label htmlFor={`plan-${id}-interval`}>Intervalo</label>
                      <input
                        id={`plan-${id}-interval`}
                        className="content-input"
                        value={plan.interval ?? ''}
                        onChange={(event) => updatePlan(id, { interval: event.target.value })}
                        placeholder={base.interval}
                      />
                    </div>
                  </div>

                  <div className="content-field">
                    <label htmlFor={`plan-${id}-tagline`}>Frase corta</label>
                    <input
                      id={`plan-${id}-tagline`}
                      className="content-input"
                      value={plan.tagline ?? ''}
                      onChange={(event) => updatePlan(id, { tagline: event.target.value })}
                      placeholder="—"
                    />
                  </div>

                  <div className="content-field">
                    <label htmlFor={`plan-${id}-features`}>Características (una por línea)</label>
                    <textarea
                      id={`plan-${id}-features`}
                      className="content-textarea content-features"
                      value={(plan.features ?? []).join('\n')}
                      onChange={(event) => updatePlan(id, { features: event.target.value.split('\n') })}
                      rows={5}
                      placeholder="—"
                    />
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {section === 'theme' && (
        <div className="content-tab-panel">
          <section className="content-theme-card">
            <div>
              <h3 className="content-subsection-title">Tema de la app</h3>
              <p className="content-subsection-note">
                El identificador y la versión viajan con el contenido. La app aplica el tema cuando
                su versión lo soporta; los textos y precios se actualizan igual.
              </p>
            </div>

            <div className="content-theme-fields">
              <div className="content-field">
                <label htmlFor="content-theme-id">Tema</label>
                <select
                  id="content-theme-id"
                  className="content-select"
                  value={content.theme.id}
                  onChange={(event) => updateTheme({ id: event.target.value })}
                >
                  {themeIds.map((id) => (
                    <option value={id} key={id}>
                      {id === 'default' ? 'Default' : id === 'halloween' ? 'Halloween' : id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="content-field">
                <label htmlFor="content-theme-version">Versión del tema</label>
                <input
                  id="content-theme-version"
                  className="content-input"
                  type="number"
                  min={0}
                  step={1}
                  value={content.theme.version}
                  onChange={(event) =>
                    updateTheme({
                      version: Math.max(0, Math.floor(Number(event.target.value) || 0)),
                    })
                  }
                />
              </div>
            </div>

            <div className="content-field content-theme-css-field">
              <label htmlFor="content-theme-css">CSS del tema</label>
              <textarea
                id="content-theme-css"
                className="content-textarea content-theme-css"
                value={content.theme.css ?? ''}
                onChange={(event) => updateTheme({ css: event.target.value })}
                rows={12}
                spellCheck={false}
                placeholder="/* Opcional: CSS que la app inyecta cuando este tema está activo. */"
              />
              <span className="content-field-key">
                Se inyecta como texto, sin ejecutar JavaScript. Se aplica al publicar y no requiere
                recompilar la app.
              </span>
            </div>

            <div className="content-theme-status">
              <Eye size={15} />
              <span>
                Activo: <strong>{content.theme.id}</strong> · versión {content.theme.version}
                {content.theme.css?.trim() ? ' · CSS personalizado' : ' · sin CSS personalizado'}
              </span>
            </div>
          </section>
        </div>
      )}

      {section === 'history' && (
        <div className="content-tab-panel">
          {history.length === 0 ? (
            <div className="content-empty-state">
              <Clock3 size={28} />
              <h3>Todavía no hay versiones archivadas</h3>
              <p>La primera publicación guardará una copia de la versión actual.</p>
            </div>
          ) : (
            <div className="content-history-list">
              {history.map((entry) => (
                <div className="content-history-row" key={entry.id}>
                  <div className="content-history-main">
                    <span className="content-history-version">v{entry.version || '—'}</span>
                    <div>
                      <div className="content-history-date">{formatDate(entry.createdAt)}</div>
                      <div className="content-history-meta">
                        <span>{formatSize(entry.size)}</span>
                        <span className="content-history-sep">·</span>
                        <span className="content-history-id">{entry.id}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="admin-btn-secondary"
                    onClick={() => void handleRevert(entry)}
                    disabled={disabled}
                  >
                    {busy === 'revert' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                    Restaurar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {preview && (
        <div className="content-modal-overlay" role="dialog" aria-modal="true" aria-label="Vista previa del contenido">
          <div className="content-modal">
            <div className="content-modal-header">
              <div>
                <span className="content-preview-eyebrow">Vista previa validada</span>
                <h2>Así quedará el contenido</h2>
              </div>
              <button
                type="button"
                className="content-icon-btn"
                onClick={() => setPreview(null)}
                aria-label="Cerrar vista previa"
              >
                <X size={18} />
              </button>
            </div>

            <div className="content-preview-body">
              <div className="content-preview-hero">
                <h3>
                  {preview.texts.loginTitle || 'Navegación sin rastro.'}
                  <br />
                  <span>{preview.texts.loginTitleHighlight || 'Privacidad de alto nivel.'}</span>
                </h3>
                <p>
                  {preview.texts.loginSubtitle ||
                    'La vista previa usa los textos publicados actuales cuando un campo está vacío.'}
                </p>
              </div>

              <div className="content-preview-plans">
                {PLAN_IDS.map((id) => {
                  const base = PLANS[id];
                  const plan = preview.plans[id] ?? {};
                  const features = plan.features ?? [];
                  return (
                    <div className="content-preview-plan" key={id}>
                      <div className="content-preview-plan-head">
                        <span>{plan.name || base.name}</span>
                        <strong>
                          {plan.price ?? base.price} {plan.currency || base.currency}
                        </strong>
                      </div>
                      <div className="content-preview-plan-meta">
                        {plan.interval || base.interval}
                      </div>
                      {plan.tagline && <p>{plan.tagline}</p>}
                      {features.length > 0 && (
                        <ul>
                          {features.map((feature) => (
                            <li key={feature}>{feature}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="content-preview-footer">
                <span>Tema: {preview.theme.id} v{preview.theme.version}</span>
                <span>Texto y precios sí se aplican al publicar.</span>
              </div>
            </div>

            <div className="content-modal-actions">
              <button type="button" className="admin-btn-secondary" onClick={() => setPreview(null)}>
                Seguir editando
              </button>
              <button
                type="button"
                className="admin-btn-primary"
                onClick={() => void handlePublish()}
                disabled={disabled}
              >
                {busy === 'publish' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Publicar esta versión
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ContentView;
