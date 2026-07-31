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
      {/* Body - warm brown */}
      <ellipse cx="32" cy="44" rx="16" ry="12" fill="#A0722B" />
      {/* Lighter belly */}
      <ellipse cx="32" cy="46" rx="10" ry="6" fill="#C49848" />
      {/* Head */}
      <ellipse cx="32" cy="28" rx="12" ry="9" fill="#A0722B" />
      {/* Snout - lighter */}
      <ellipse cx="32" cy="30" rx="7" ry="4" fill="#C49848" />
      {/* Nose - dark */}
      <ellipse cx="32" cy="28" rx="2.5" ry="1.5" fill="#5C3516" />
      {/* Left eye */}
      <circle cx="27" cy="24" r="2.2" fill="#1A1A1A" />
      <circle cx="27.6" cy="23.4" r="0.7" fill="white" />
      {/* Right eye */}
      <circle cx="37" cy="24" r="2.2" fill="#1A1A1A" />
      <circle cx="37.6" cy="23.4" r="0.7" fill="white" />
      {/* Left ear */}
      <ellipse cx="23" cy="20" rx="3" ry="4" fill="#8B6120" />
      <ellipse cx="23" cy="20" rx="1.5" ry="2.5" fill="#C49848" />
      {/* Right ear */}
      <ellipse cx="41" cy="20" rx="3" ry="4" fill="#8B6120" />
      <ellipse cx="41" cy="20" rx="1.5" ry="2.5" fill="#C49848" />
      {/* Happy mouth */}
      <path d="M28 30 Q32 33 36 30" stroke="#5C3516" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      {/* Rosy cheeks */}
      <circle cx="24" cy="28" r="2.5" fill="#E8A0A0" opacity="0.5" />
      <circle cx="40" cy="28" r="2.5" fill="#E8A0A0" opacity="0.5" />
      {/* Left foot */}
      <ellipse cx="24" cy="55" rx="4" ry="2" fill="#8B6120" />
      {/* Right foot */}
      <ellipse cx="40" cy="55" rx="4" ry="2" fill="#8B6120" />
    </svg>
  );
}
