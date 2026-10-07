export default function Loading({ text = 'Loading your insights…' }) {
  return (
    <div className="loading-block" role="status">
      <span className="spinner spinner-lg" aria-hidden="true" />
      {text && <p>{text}</p>}
    </div>
  );
}
