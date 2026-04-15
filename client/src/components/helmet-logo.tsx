interface HelmetLogoProps {
  size?: number;
  className?: string;
}

export function HelmetLogo({ size = 32, className = '' }: HelmetLogoProps) {
  return (
    <img
      src="./hk-logo.jpg"
      alt="Helmet King logo"
      width={size}
      height={size}
      className={`rounded ${className}`}
      style={{ objectFit: 'contain' }}
    />
  );
}
