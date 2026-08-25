import Link from "next/link";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="RetailPulse product introduction">
        <Link className="auth-brand" href="/">
          <span>RP</span>
          <div><strong>RetailPulse</strong><small>AI Sales Intelligence</small></div>
        </Link>
        <div className="auth-story-copy">
          <h1>Turn Your Sales Data Into Smarter Decisions</h1>
          <span>Secure account access, browser-based CSV analysis, evidence-led forecasts, and no preloaded business data.</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-mobile-brand"><span>RP</span><strong>RetailPulse</strong></div>
          <p className="auth-eyebrow">WELCOME TO RETAILPULSE</p>
          <h2>{title}</h2>
          <p className="auth-subtitle">{subtitle}</p>
          {children}
          {footer && <div className="auth-footer">{footer}</div>}
        </div>
      </section>
    </main>
  );
}
