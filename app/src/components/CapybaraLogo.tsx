interface CapybaraLogoProps {
  className?: string;
}

export function CapybaraLogo({ className }: CapybaraLogoProps) {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Capybara logo"
    >
      {/* Body */}
      <ellipse cx="32" cy="40" rx="18" ry="14" fill="#8B6914" />
      {/* Head */}
      <ellipse cx="32" cy="22" rx="11" ry="9" fill="#A0781E" />
      {/* Snout */}
      <ellipse cx="32" cy="25" rx="6" ry="3.5" fill="#C49A3C" />
      {/* Nose */}
      <ellipse cx="32" cy="23" rx="2.5" ry="1.5" fill="#5C3D0E" />
      {/* Eyes */}
      <circle cx="28" cy="19" r="1.8" fill="#1A1A1A" />
      <circle cx="36" cy="19" r="1.8" fill="#1A1A1A" />
      {/* Eye shine */}
      <circle cx="28.5" cy="18.5" r="0.5" fill="white" />
      <circle cx="36.5" cy="18.5" r="0.5" fill="white" />
      {/* Ears */}
      <ellipse cx="23" cy="15" rx="2.5" ry="3.5" fill="#8B6914" />
      <ellipse cx="41" cy="15" rx="2.5" ry="3.5" fill="#8B6914" />
      {/* Mouth */}
      <path d="M29 26 Q32 27.5 35 26" stroke="#5C3D0E" strokeWidth="0.8" fill="none" />
    </svg>
  );
}
