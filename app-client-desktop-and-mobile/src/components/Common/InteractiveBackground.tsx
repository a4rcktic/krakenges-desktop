import { usePlatform } from '../../context/PlatformContext';
import { getBranding } from '../../config/branding';
import './InteractiveBackground.css';

export interface Props {
  className?: string;
  opacity?: number;
  variant?: 'auto' | 'desktop' | 'mobile';
  contained?: boolean;
}

/**
 * Kraken Ges Monogram Eclipse Watermark Background (Louis Vuitton Style)
 * 100% Vector SVG Pattern • Zero CPU Loop • Pure OLED Stealth
 * Alternates: Stylized S Monogram, 4-Point Fluted Star, Shield Crest, and KRAKEN GES Wordmark.
 *
 * Auto-scales tile size:
 * - Desktop: 156px expansive pattern
 * - Mobile: 104px compact pattern for luxury smartphone wallpaper density
 */
export function InteractiveBackground({
  className = '',
  opacity,
  variant = 'auto',
  contained = false,
}: Props) {
  const { platform } = usePlatform();
  const isMobile = variant === 'mobile' || (variant === 'auto' && platform === 'mobile');

  // Tile size: 104px on mobile (fits ~3.8 motifs across 390px) vs 156px on desktop
  const tileSize = isMobile ? 104 : 156;
  const patternId = isMobile ? 'krakenges-lv-monogram-mob' : 'krakenges-lv-monogram-desk';

  return (
    <div
      className={`stealth-bg-wrapper ${isMobile ? 'stealth-bg-mobile' : 'stealth-bg-desktop'} ${contained ? 'stealth-bg-contained' : ''} ${className}`}
    >
      {/* Luxury Monogram Watermark Layer */}
      <svg
        className="stealth-monogram-svg"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
        style={opacity !== undefined ? { opacity } : undefined}
      >
        <defs>
          <pattern
            id={patternId}
            width={tileSize}
            height={tileSize}
            viewBox="0 0 160 160"
            patternUnits="userSpaceOnUse"
          >
            {/* ========================================================
                MOTIF 1: KRAKEN GES LUXURY MONOGRAM (Position: 40, 40)
                ======================================================== */}
            <g transform="translate(40, 40)" className="monogram-glyph">
              {/* Outer delicate diamond ring */}
              <path
                d="M 0,-20 L 20,0 L 0,20 L -20,0 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.8"
                opacity="0.35"
              />
              <circle cx="0" cy="0" r="16.5" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.25" strokeDasharray="1.5 2.5" />

              {/* Bold Luxury Interlocking 'S' */}
              <text
                x="0"
                y="8.5"
                fontFamily="'Plus Jakarta Sans', 'Inter', sans-serif"
                fontWeight="900"
                fontSize="27"
                textAnchor="middle"
                fill="currentColor"
                opacity="0.88"
              >
                S
              </text>
              {/* High-fashion small capsule tag */}
              <text
                x="0"
                y="16.5"
                fontFamily="'Plus Jakarta Sans', 'Inter', sans-serif"
                fontWeight="900"
                fontSize="4.4"
                letterSpacing="1.8"
                textAnchor="middle"
                fill="currentColor"
                opacity="0.75"
              >
                STR
              </text>
            </g>

            {/* ========================================================
                MOTIF 2: 4-POINT FLUTED LUXURY STAR (Position: 120, 40)
                Classic French Haute-Couture Monogram Star
                ======================================================== */}
            <g transform="translate(120, 40)" className="monogram-glyph">
              {/* Fluted 4-Point Star (Curved Astroid Petals) */}
              <path
                d="M 0,-14.5 C 1.8,-3 3,-1.8 14.5,0 C 3,1.8 1.8,3 0,14.5 C -1.8,3 -3,1.8 -14.5,0 C -3,-1.8 -1.8,-3 0,-14.5 Z"
                fill="currentColor"
                opacity="0.75"
              />
              {/* Center Diamond Spark */}
              <polygon points="0,-3 3,0 0,3 -3,0" fill="#000000" opacity="0.9" />
              <circle cx="0" cy="0" r="1.2" fill="currentColor" />

              {/* Surrounding Luxury Satellite Dots */}
              <circle cx="0" cy="-19" r="0.9" fill="currentColor" opacity="0.45" />
              <circle cx="19" cy="0" r="0.9" fill="currentColor" opacity="0.45" />
              <circle cx="0" cy="19" r="0.9" fill="currentColor" opacity="0.45" />
              <circle cx="-19" cy="0" r="0.9" fill="currentColor" opacity="0.45" />
            </g>

            {/* ========================================================
                MOTIF 3: KRAKEN GES SHIELD CREST EMBLEM (Position: 40, 120)
                ======================================================== */}
            <g transform="translate(40, 120)" className="monogram-glyph">
              {/* Outer Security Shield */}
              <path
                d="M 0,-15 L 13.5,-8.5 L 13.5,3.5 C 13.5,10.5 7.5,15.5 0,18 C -7.5,15.5 -13.5,10.5 -13.5,3.5 L -13.5,-8.5 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                opacity="0.8"
              />
              {/* Inner Fine Shield */}
              <path
                d="M 0,-10.5 L 9,-6 L 9,2.5 C 9,7.5 5,11.5 0,13.5 C -5,11.5 -9,7.5 -9,2.5 L -9,-6 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="0.65"
                opacity="0.4"
              />
              {/* Inner Diamond Monogram Accent */}
              <polygon points="0,-4.5 3.8,0 0,4.5 -3.8,0" fill="currentColor" opacity="0.9" />
              <circle cx="0" cy="0" r="1" fill="#000000" />
            </g>

            {/* ========================================================
                MOTIF 4: KRAKEN GES HAUTE TYPOGRAPHY (Position: 120, 120)
                ======================================================== */}
            <g transform="translate(120, 120)" className="monogram-glyph">
              {/* Corner Framing Brackets */}
              <path d="M -30,-9 L -26,-9 M -30,-9 L -30,-5" fill="none" stroke="currentColor" strokeWidth="0.75" opacity="0.4" />
              <path d="M 30,-9 L 26,-9 M 30,-9 L 30,-5" fill="none" stroke="currentColor" strokeWidth="0.75" opacity="0.4" />
              <path d="M -30,9 L -26,9 M -30,9 L -30,5" fill="none" stroke="currentColor" strokeWidth="0.75" opacity="0.4" />
              <path d="M 30,9 L 26,9 M 30,9 L 30,5" fill="none" stroke="currentColor" strokeWidth="0.75" opacity="0.4" />

              {/* Main Brand Wordmark */}
              <text
                x="0"
                y="1.5"
                fontFamily="'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif"
                fontWeight="900"
                fontSize="7"
                letterSpacing="1.9"
                textAnchor="middle"
                fill="currentColor"
                opacity="0.95"
              >
                {getBranding().shortName.toUpperCase()}
              </text>

              {/* Sub-label classification */}
              <text
                x="0"
                y="7.5"
                fontFamily="'JetBrains Mono', monospace"
                fontWeight="700"
                fontSize="3.4"
                letterSpacing="1.2"
                textAnchor="middle"
                fill="currentColor"
                opacity="0.6"
              >
                GLOBAL • STEALTH
              </text>
            </g>

            {/* ========================================================
                MICRO ACCENTS: TINY GEOMETRIC CONNECTOR STARS
                ======================================================== */}
            <g opacity="0.3">
              <polygon points="80,78 82,80 80,82 78,80" fill="currentColor" />
              <polygon points="0,-2 2,0 0,2 -2,0" fill="currentColor" />
              <polygon points="160,-2 162,0 160,2 158,0" fill="currentColor" />
              <polygon points="0,158 2,160 0,162 -2,160" fill="currentColor" />
              <polygon points="160,158 162,160 160,162 158,160" fill="currentColor" />
            </g>
          </pattern>
        </defs>

        {/* Fill whole area with repeated LV Monogram */}
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>

      {/* Radial Depth Vignette */}
      <div className="stealth-bg-vignette" />
      <div className="stealth-bg-radial" />
    </div>
  );
}

export default InteractiveBackground;
