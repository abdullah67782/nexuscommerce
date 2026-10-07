export default function EmptyState({ icon, title, children, action }) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-state-mark" aria-hidden="true">{icon}</span>}
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
