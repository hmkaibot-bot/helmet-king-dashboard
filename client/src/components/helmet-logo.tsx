import logoSrc from '../assets/hk-logo.jpg';

interface HelmetLogoProps {
  size?: number;
  className?: string;
}

export function HelmetLogo({ size = 32, className = '' }: HelmetLogoProps) {
  return (
    <img
      src={logoSrc}
      alt="Helmet King logo"
      width={size}
      height={size}
      className={`rounded ${className}`}
      style={{ objectFit: 'contain' }}
    />
  );
}
