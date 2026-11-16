import React from 'react';

export function WindowsIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 88 88" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M0 12.5L36 7.5V42H0V12.5ZM0 46H36V80.5L0 75.5V46ZM40 6.9L88 0V42H40V6.9ZM40 46H88V88L40 81.1V46Z" />
    </svg>
  );
}

export function AppleIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 170 170" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.69-7.79-11.97-14.24-6.74-10.13-12.04-21.65-15.9-34.56-3.86-12.91-5.79-24.81-5.79-35.7 0-14.7 3.59-26.68 10.77-35.95 7.18-9.27 16.27-13.98 27.27-14.13 5.43 0 11.45 1.45 18.06 4.35 6.61 2.9 10.81 4.41 12.6 4.54 1.57-.13 6.06-1.76 13.48-4.9 7.42-3.13 13.62-4.47 18.6-4.01 14.13.86 25.13 6.34 32.99 16.44-12.44 7.55-18.52 17.89-18.25 31.02.26 10.38 4.13 19.09 11.61 26.13 7.48 7.04 16.51 11.05 27.09 12.03-2.12 6.33-4.66 12.65-7.63 18.96zM119.22 33.15c0-7.39 2.65-14.14 7.95-20.25 5.3-6.11 11.89-9.77 19.77-11 1.05 7.64-1.29 14.54-7.03 20.7-5.74 6.16-12.63 9.77-20.69 10.55z" />
    </svg>
  );
}

export function LinuxIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C8 2 6 5 6 9c0 3 1 6 2 8l-2 3h12l-2-3c1-2 2-5 2-8 0-4-2-7-6-7z" />
      <circle cx="10" cy="8" r="1" fill="currentColor" />
      <circle cx="14" cy="8" r="1" fill="currentColor" />
      <path d="M10 11c1 .5 3 .5 4 0" />
      <path d="M4 17c1.5-1 3-2 3-4" />
      <path d="M20 17c-1.5-1-3-2-3-4" />
    </svg>
  );
}
