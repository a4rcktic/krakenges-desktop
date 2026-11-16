import React, { createContext, useContext, useState } from 'react';
import { isMobileNative } from '../services/mobileBrowser';
import { isTauri } from '../services/tauriBridge';

export type PlatformMode = 'desktop' | 'mobile';

interface PlatformContextValue {
  platform: PlatformMode;
  setPlatform: (p: PlatformMode) => void;
  isNativeMobile: boolean;
  isNativeDesktop: boolean;
}

const PlatformContext = createContext<PlatformContextValue>({
  platform: 'desktop',
  setPlatform: () => {},
  isNativeMobile: false,
  isNativeDesktop: false,
});

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  const [platform, setPlatformState] = useState<PlatformMode>(() => {
    // If running natively in Capacitor Android APK -> mobile
    if (isMobileNative) return 'mobile';
    // If running natively in Tauri Desktop app -> desktop
    if (isTauri) return 'desktop';
    // In browser development, read from localStorage or screen width
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('krakenges_dev_platform') as PlatformMode : null;
    if (saved && (saved === 'desktop' || saved === 'mobile')) return saved;
    if (typeof window !== 'undefined' && window.innerWidth < 768) return 'mobile';
    return 'desktop';
  });

  const setPlatform = (p: PlatformMode) => {
    setPlatformState(p);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('krakenges_dev_platform', p);
    }
  };

  return (
    <PlatformContext.Provider value={{
      platform,
      setPlatform,
      isNativeMobile: isMobileNative,
      isNativeDesktop: isTauri,
    }}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform() {
  return useContext(PlatformContext);
}
