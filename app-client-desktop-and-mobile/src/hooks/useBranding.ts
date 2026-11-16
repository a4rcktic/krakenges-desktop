import { useState, useEffect } from 'react';
import { getBranding, setBranding, resetBranding, applyBrandTheme, type BrandConfig, THEME_PRESETS } from '../config/branding';

export function useBranding() {
  const [branding, setBrandState] = useState<BrandConfig>(() => getBranding());

  useEffect(() => {
    applyBrandTheme(branding);

    const handleBrandChange = (e: Event) => {
      const customEvent = e as CustomEvent<BrandConfig>;
      if (customEvent.detail) {
        setBrandState(customEvent.detail);
      } else {
        setBrandState(getBranding());
      }
    };

    window.addEventListener('krakenges:brand-changed', handleBrandChange);
    return () => window.removeEventListener('krakenges:brand-changed', handleBrandChange);
  }, []);

  const updateBranding = (updates: Partial<BrandConfig>) => {
    const updated = setBranding(updates);
    setBrandState(updated);
  };

  const applyPreset = (presetKey: keyof typeof THEME_PRESETS) => {
    const preset = THEME_PRESETS[presetKey];
    if (preset) {
      updateBranding({ colors: preset.colors });
    }
  };

  const restoreDefault = () => {
    const def = resetBranding();
    setBrandState(def);
  };

  return {
    branding,
    updateBranding,
    applyPreset,
    restoreDefault,
    presets: THEME_PRESETS,
  };
}
