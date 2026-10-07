'use client';

import { createContext, useContext, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import api from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('nexus_token');
    const savedUser = localStorage.getItem('nexus_user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    const { token: jwt, user: userData } = res.data;

    localStorage.setItem('nexus_token', jwt);
    localStorage.setItem('nexus_user', JSON.stringify(userData));

    // Also set token in cookie for middleware SSR protection
    document.cookie = `nexus_token=${jwt}; path=/; max-age=${60 * 60 * 24 * 7}`;
    document.cookie = `token=${jwt}; path=/; max-age=${60 * 60 * 24 * 7}`;

    setToken(jwt);
    setUser(userData);

    return res.data;
  };

  const register = async (name, email, password, role) => {
    const res = await api.post('/auth/register', { name, email, password, role });
    const { token: jwt, user: userData } = res.data;

    localStorage.setItem('nexus_token', jwt);
    localStorage.setItem('nexus_user', JSON.stringify(userData));
    document.cookie = `nexus_token=${jwt}; path=/; max-age=${60 * 60 * 24 * 7}`;
    document.cookie = `token=${jwt}; path=/; max-age=${60 * 60 * 24 * 7}`;

    setToken(jwt);
    setUser(userData);

    return res.data;
  };

  const logout = () => {
    localStorage.removeItem('nexus_token');
    localStorage.removeItem('nexus_user');
    document.cookie = 'nexus_token=; path=/; max-age=0';
    document.cookie = 'token=; path=/; max-age=0';
    setToken(null);
    setUser(null);
    router.push('/');
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
