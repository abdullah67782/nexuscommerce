'use client';
import { Toaster } from 'react-hot-toast';

export default function ToastProvider() {
  return (
    <Toaster
      position="bottom-right"
      toastOptions={{
        duration: 4500,
        style: { background: '#1d242a', color: '#f3f5f4', border: '1px solid #303a42', borderRadius: '8px', fontSize: '13px', padding: '10px 14px', boxShadow: '0 16px 40px rgba(0,0,0,.5)' },
        success: { iconTheme: { primary: '#4ccb83', secondary: '#111519' } },
        error: { iconTheme: { primary: '#ef6262', secondary: '#111519' } },
      }}
    />
  );
}
