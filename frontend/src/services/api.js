import axios from 'axios';
import toast from 'react-hot-toast';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor — attach JWT token to every request
api.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('nexus_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor — handle errors and retries
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;

    // Handle 401 Unauthorized
    if (error.response && error.response.status === 401) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('nexus_token');
        localStorage.removeItem('nexus_user');
        document.cookie = 'token=; path=/; max-age=0';
        document.cookie = 'nexus_token=; path=/; max-age=0';
        window.location.href = '/';
      }
      return Promise.reject(error);
    }

    // Handle Network Errors
    if (!error.response || error.code === 'ERR_NETWORK') {
      toast.error('Network error. Please check your connection.');
    } 
    // Handle 500 Server Errors
    else if (error.response && error.response.status >= 500) {
      toast.error('Server error occurred. Retrying...');
      
      // Basic Retry Logic (max 2 retries)
      config.__retryCount = config.__retryCount || 0;
      if (config.__retryCount < 2) {
        config.__retryCount += 1;
        const delay = new Promise((resolve) => setTimeout(resolve, 1000 * config.__retryCount));
        await delay;
        return api(config);
      } else {
        toast.error('Server is unreachable after multiple attempts.');
      }
    }

    return Promise.reject(error);
  }
);

export default api;
