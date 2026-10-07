// Page header used by every workspace page.
// `meta` sits under the title (status, freshness…); `children` are actions.
export default function PageHeader({ eyebrow, title, description, meta, children }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {eyebrow && <p className="page-header-eyebrow">{eyebrow}</p>}
        <h1 className="text-title">{title}</h1>
        {description && <p className="page-header-desc">{description}</p>}
        {meta && <div className="page-header-meta">{meta}</div>}
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </header>
  );
}
