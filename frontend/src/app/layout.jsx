import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "../styles/nexus.css";
import "../styles/landing.css";
import "../styles/auth.css";
import "../styles/shell.css";
import "../styles/workspace.css";
import { AuthProvider } from "../context/AuthContext";
import ToastProvider from "../components/ToastProvider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata = {
  title: "NexusCommerce — Turn your sales data into your next decision",
  description: "NexusCommerce turns the data your store already has into clear, timely business decisions.",
};

export const viewport = { themeColor: "#090b0d" };

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <AuthProvider>
          {children}
          <ToastProvider />
        </AuthProvider>
      </body>
    </html>
  );
}
