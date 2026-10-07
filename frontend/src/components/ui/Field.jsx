import { cloneElement, isValidElement, useId } from 'react';

// Label + control + hint/error, wired for accessibility.
export default function Field({ label, hint, error, children, id: idProp }) {
  const auto = useId();
  const id = idProp || `f${auto.replace(/:/g, '')}`;
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id: children.props.id || id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })
    : children;
  return (
    <div className="field">
      {label && <label htmlFor={children?.props?.id || id} className="label-text">{label}</label>}
      {control}
      {error ? <p id={`${id}-err`} className="err-msg" role="alert">{error}</p> : hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
    </div>
  );
}
