const API_BASE_URL = 'http://localhost:5000/api';

let authToken = localStorage.getItem('authToken') || '';

const api = {
  setToken(token) {
    authToken = token;
    if (token) {
      localStorage.setItem('authToken', token);
    } else {
      localStorage.removeItem('authToken');
    }
  },

  getToken() {
    return authToken;
  },

  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        ...options.headers
      },
      ...options
    };

    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error(`API请求错误 [${endpoint}]:`, error);
      
      if (error.message.includes('401') || error.message.includes('令牌')) {
        this.setToken(null);
        window.location.reload();
      }
      
      throw error;
    }
  },

  auth: {
    async register(username, email, password) {
      return api.request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password })
      });
    },

    async login(email, password) {
      const result = await api.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      
      if (result.success && result.data?.token) {
        api.setToken(result.data.token);
      }
      
      return result;
    },

    async getMe() {
      return api.request('/auth/me');
    }
  },

  user: {
    async getProfile() {
      return api.request('/user/profile');
    },

    async updateProfile(data) {
      return api.request('/user/profile', {
        method: 'PUT',
        body: JSON.stringify(data)
      });
    },

    async changePassword(currentPassword, newPassword) {
      return api.request('/user/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword })
      });
    }
  },

  credits: {
    async getBalance() {
      return api.request('/credits/balance');
    },

    async deduct(amount, reason = '', metadata = {}) {
      return api.request('/credits/deduct', {
        method: 'POST',
        body: JSON.stringify({ amount, reason, metadata })
      });
    },

    async add(amount, type, reason = '', orderId = '') {
      return api.request('/credits/add', {
        method: 'POST',
        body: JSON.stringify({ amount, type, reason, orderId })
      });
    },

    async getHistory(page = 1, limit = 20, type = '') {
      const params = new URLSearchParams({ page, limit });
      if (type) params.append('type', type);
      return api.request(`/credits/history?${params}`);
    }
  },

  orders: {
    async getPlans() {
      return api.request('/orders/plans');
    },

    async create(planType, paymentMethod = 'alipay') {
      return api.request('/orders/create', {
        method: 'POST',
        body: JSON.stringify({ planType, paymentMethod })
      });
    },

    async getList(page = 1, limit = 10, status = '') {
      const params = new URLSearchParams({ page, limit });
      if (status) params.append('status', status);
      return api.request(`/orders/list?${params}`);
    },

    async getDetail(orderId) {
      return api.request(`/orders/${orderId}`);
    }
  },

  payment: {
    getQrcodeUrl(orderId) {
      return `${API_BASE_URL}/payment/qrcode/${orderId}`;
    },

    async uploadScreenshot(orderId, file) {
      const formData = new FormData();
      formData.append('screenshot', file);
      formData.append('orderId', orderId);

      return api.request('/payment/upload-screenshot', {
        method: 'POST',
        headers: {}, 
        body: formData
      });
    },

    async getMyScreenshots() {
      return api.request('/payment/my-screenshots');
    }
  },

  analytics: {
    async getDashboard() {
      return api.request('/analytics/dashboard');
    },

    async getUserStats() {
      return api.request('/analytics/users/stats');
    },

    async getRevenueStats(period = 'month') {
      return api.request(`/analytics/revenue/stats?period=${period}`);
    },

    async getRecentEvents(limit = 50) {
      return api.request(`/analytics/events/recent?limit=${limit}`);
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
