interface HelmetLogoProps {
  size?: number;
  className?: string;
}

export function HelmetLogo({ size = 32, className = '' }: HelmetLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Helmet King logo"
      className={className}
    >
      {/* Helmet shell */}
      <path
        d="M8 28C8 16.954 14.268 8 24 8C33.732 8 40 16.954 40 28V32H8V28Z"
        fill="hsl(38, 92%, 50%)"
        opacity="0.9"
      />
      {/* Visor */}
      <path
        d="M12 26C12 20.477 17.373 14 24 14C30.627 14 36 20.477 36 26V28H12V26Z"
        fill="hsl(225, 25%, 7%)"
        opacity="0.7"
      />
      {/* Visor shine */}
      <path
        d="M15 22C16.5 18.5 20 16 24 16C26.5 16 28.8 17 30.5 18.5"
        stroke="hsl(38, 92%, 60%)"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.5"
      />
      {/* HK letterform */}
      <text
        x="24"
        y="42"
        textAnchor="middle"
        fontFamily="Inter, sans-serif"
        fontWeight="800"
        fontSize="11"
        fill="hsl(38, 92%, 50%)"
        letterSpacing="1"
      >
        HK
      </text>
    </svg>
  );
}
