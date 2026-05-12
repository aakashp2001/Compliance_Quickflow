/** Inline SVGs — currentColor inherits from parent for theme consistency */

const svgProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
};

export function IconBrandLogo({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="2" y="2" width="28" height="28" rx="7" fill="var(--brand)" />
      <path
        d="M9 16.5 13 21l10-11"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 11h6M9 15h4"
        stroke="rgba(255,255,255,0.85)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconSearchDb() {
  return (
    <svg {...svgProps}>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M16 16l5 5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function IconCrud() {
  return (
    <svg {...svgProps}>
      <path
        d="M4 7h16M4 12h16M4 17h12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M17 17v4M15 19h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconWorkflow() {
  return (
    <svg {...svgProps}>
      <rect x="3" y="4" width="7" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.75" />
      <rect x="14" y="4" width="7" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.75" />
      <rect x="8.5" y="15" width="7" height="5" rx="1.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M6.5 9v2.5h5V14M17.5 9v2.5h-5V14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconMandatory() {
  return (
    <svg {...svgProps}>
      <path
        d="M9 11l3 3L22 4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 12v7a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2h10"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconDuplicate() {
  return (
    <svg {...svgProps}>
      <rect x="4" y="4" width="11" height="14" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <rect x="9" y="6" width="11" height="14" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path d="M12 10h5M12 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconRecording() {
  return (
    <svg {...svgProps}>
      <rect x="3" y="7" width="11" height="10" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M16 10l5-2v10l-5-2v-6z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconReport() {
  return (
    <svg {...svgProps}>
      <path
        d="M8 4h10a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V6a2 2 0 012-2z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M9 9h8M9 13h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevronCollapse() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChevronExpand() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCompliance() {
  return (
    <svg {...svgProps}>
      <path
        d="M12 2L4 4V12C4 18 12 22 12 22C12 22 20 18 20 12V4L12 2Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 6V18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}