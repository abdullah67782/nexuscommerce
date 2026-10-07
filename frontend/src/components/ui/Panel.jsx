// Panel: the elevated surface. Use sparingly — open sections (variant="flush")
// and subtle wells (variant="subtle") keep the page from becoming a card grid.
export function Panel({ as: Tag = 'section', variant = 'default', tone, className = '', children, style, ...rest }) {
  const cls = ['panel', variant === 'subtle' && 'panel-subtle', variant === 'flush' && 'panel-flush', className].filter(Boolean).join(' ');
  return (
    <Tag className={cls} style={tone ? { '--tone': tone, ...style } : style} {...rest}>
      {tone && <span className="tone-rule" aria-hidden="true" />}
      {children}
    </Tag>
  );
}

export function PanelHeader({ title, description, actions, titleId, as: H = 'h2', children }) {
  return (
    <header className="panel-head">
      <div style={{ minWidth: 0 }}>
        <H className="panel-title" id={titleId}>{title}</H>
        {description && <p className="panel-desc">{description}</p>}
      </div>
      {(actions || children) && <div className="panel-actions">{actions}{children}</div>}
    </header>
  );
}

export default Panel;
