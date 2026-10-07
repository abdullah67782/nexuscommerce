import Link from 'next/link';
import { HiArrowLeft } from 'react-icons/hi2';
import Brand from '../components/Brand';

export default function NotFound() {
  return (
    <main className="empty-screen" id="main-content">
      <Brand />
      <p className="mono-label" style={{ marginTop: 32 }}>404 · Signal lost</p>
      <h1>A little off <em className="serif-em">the path.</em></h1>
      <p>This page doesn&apos;t exist or has moved. Your workspace is right where you left it.</p>
      <Link href="/dashboard" className="btn-primary"><HiArrowLeft />Back to workspace</Link>
      <Link href="/" className="btn-ghost">Go to home</Link>
    </main>
  );
}
