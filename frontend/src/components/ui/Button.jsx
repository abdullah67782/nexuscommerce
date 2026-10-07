import Link from 'next/link';

// One button for the whole product. `href` renders a Next <Link>.
// variant: primary | secondary | ghost | danger · size: sm | md | lg
export default function Button({ variant = 'primary', size = 'md', href, icon, iconRight, block = false, className = '', children, ...rest }) {
  const cls = [`btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className].filter(Boolean).join(' ');
  const content = <>{icon}{children}{iconRight}</>;
  if (href) return <Link href={href} className={cls} {...rest}>{content}</Link>;
  return <button type="button" className={cls} {...rest}>{content}</button>;
}
