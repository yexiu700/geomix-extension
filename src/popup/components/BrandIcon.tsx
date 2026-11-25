export function BrandIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="gm-brand-icon"
    >
      <rect width="64" height="64" rx="14" fill="#0A0C0E" />
      <g transform="translate(4 4) scale(0.875)">
        <path
          fill="#FFFFFF"
          d="M52 32A20 20 0 1 1 46.142 17.858L42.253 21.747A14.5 14.5 0 1 0 45.416 37.5H41.5V32Z"
        />
        <circle cx="32.4" cy="32" r="6.2" fill="#CEFA29" />
      </g>
    </svg>
  );
}
