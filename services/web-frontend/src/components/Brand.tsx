export default function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? 'brand-light' : ''}`}>
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <rect width="34" height="34" rx="9" fill="currentColor" />
        <path d="M9 10l8 15 8-15" fill="none" stroke="#F5B942" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        Vijay<strong>Bank</strong>
      </span>
    </div>
  );
}
