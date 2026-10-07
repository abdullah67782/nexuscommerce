// Plate: the base surface of the workspace. Square, hairline, optional
// registration ticks and a module "tone" rule down the left edge.
export function Plate({ as: Tag = 'section', ticks = false, tone, className = '', children, style, ...rest }) {
  return (
    <Tag className={`plate ${ticks ? 'plate-ticks' : ''} ${className}`} style={tone ? { '--tone': tone, ...style } : style} {...rest}>
      {tone && <span className="tone-rule" aria-hidden="true" />}
      {children}
    </Tag>
  );
}

export function PlateHead({ index, title, sub, titleId, children, as: H = 'h2' }) {
  return (
    <header className="plate-head">
      {index && <span className="plate-head-index">{index}</span>}
      <div>
        <H className="plate-head-title" id={titleId}>{title}</H>
        {sub && <p className="plate-head-sub">{sub}</p>}
      </div>
      {children && <div className="plate-head-actions">{children}</div>}
    </header>
  );
}
