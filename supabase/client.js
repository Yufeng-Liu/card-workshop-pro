// ============================================
// Supabase 客户端配置
// ============================================
// 
// 📌 使用方法：
// 1. 安装依赖: npm install @supabase/supabase-js
// 2. 在页面中引入此文件
// 3. 使用 supabase 对象进行所有数据库操作
//
// ============================================

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'YOUR_SUPABASE_URL';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ============================================
// 认证相关函数
// ============================================

export const auth = {
    async signUp(email, password, username) {
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { username }
            }
        });
        
        if (error) throw error;
        return data;
    },

    async signIn(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        
        if (error) throw error;
        return data;
    },

    async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
    },

    async getCurrentUser() {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error) throw error;
        return user;
    },

    onAuthStateChange(callback) {
        return supabase.auth.onAuthStateChange((event, session) => {
            callback(event, session?.user);
        });
    }
};

// ============================================
// 用户资料 (Profiles)
// ============================================

export const profiles = {
    async getProfile(userId) {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
        
        if (error) throw error;
        return data;
    },

    async updateProfile(userId, updates) {
        const { data, error } = await supabase
            .from('profiles')
            .update(updates)
            .eq('id', userId)
            .select()
            .single();
        
        if (error) throw error;
        return data;
    },

    async getCredits(userId) {
        const { data, error } = await supabase
            .from('profiles')
            .select('credits, total_credits_earned, total_credits_spent, is_vip')
            .eq('id', userId)
            .single();
        
        if (error) throw error;
        return data;
    }
};

// ============================================
// 积分系统 (Credit Transactions)
// ============================================

export const credits = {
    async deductCredits(userId, amount, reason = '生成卡片消耗', metadata = {}) {
        // 获取当前用户信息（用于检查VIP状态）
        const profile = await profiles.getProfile(userId);
        const actualAmount = profile.is_vip ? Math.floor(amount * 0.8) : amount;

        // 检查余额
        if (profile.credits < actualAmount) {
            throw new Error('INSUFFICIENT_CREDITS');
        }

        // 开始事务（使用RPC或手动处理）
        const newBalance = profile.credits - actualAmount;

        // 更新积分余额
        const { error: updateError } = await supabase
            .from('profiles')
            .update({ 
                credits: newBalance,
                total_credits_spent: profile.total_credits_spent + actualAmount,
                stats: {
                    ...profile.stats,
                    totalGenerated: (profile.stats.totalGenerated || 0) + (metadata.type === 'generate' ? 1 : 0),
                    todayGenerated: (metadata.type === 'generate' ? (profile.stats.todayGenerated || 0) + 1 : profile.stats.todayGenerated || 0),
                    lastGenerateDate: metadata.type === 'generate' ? new Date().toISOString() : profile.stats.lastGenerateDate
                }
            })
            .eq('id', userId);

        if (updateError) throw updateError;

        // 记录交易历史
        const { error: transactionError } = await supabase
            .from('credit_transactions')
            .insert({
                user_id: userId,
                type: 'spend',
                amount: -actualAmount,
                balance_after: newBalance,
                description: reason,
                metadata
            });

        if (transactionError) throw transactionError;

        return { 
            success: true, 
            newBalance, 
            deducted: actualAmount,
            originalAmount: amount,
            discount: profile.is_vip ? 20 : 0
        };
    },

    async addCredits(userId, amount, type = 'earn', reason = '', orderId = null, metadata = {}) {
        const profile = await profiles.getProfile(userId);
        const newBalance = profile.credits + amount;

        let updates = {
            credits: newBalance,
            total_credits_earned: profile.total_credits_earned + amount
        };

        // 如果是充值且包含VIP，更新VIP状态
        if (type === 'bonus' && orderId) {
            const { data: order } = await supabase
                .from('orders')
                .select('is_vip')
                .eq('id', orderId)
                .single();

            if (order?.is_vip) {
                updates.is_vip = true;
                updates.vip_expire_date = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
                updates.role = 'vip';
            }
        }

        const { error: updateError } = await supabase
            .from('profiles')
            .update(updates)
            .eq('id', userId);

        if (updateError) throw updateError;

        const { error: transactionError } = await supabase
            .from('credit_transactions')
            .insert({
                user_id: userId,
                type,
                amount,
                balance_after: newBalance,
                description: reason || `获得${amount}积分`,
                order_id: orderId,
                metadata
            });

        if (transactionError) throw transactionError;

        return { success: true, newBalance };
    },

    async getHistory(userId, page = 1, limit = 20, type = '') {
        let query = supabase
            .from('credit_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range((page - 1) * limit, page * limit - 1);

        if (type) query = query.eq('type', type);

        const { data, count, error } = await query;
        if (error) throw error;

        return {
            transactions: data,
            pagination: {
                current: page,
                pages: Math.ceil(count / limit),
                total: count,
                limit
            }
        };
    }
};

// ============================================
// 订单系统 (Orders)
// ============================================

const PLANS = {
    basic: { name: '入门体验', credits: 100, bonus: 0, price: 9.9, originalPrice: 19.9 },
    popular: { name: '最受欢迎', credits: 500, bonus: 50, price: 39.9, originalPrice: 99.9 },
    pro: { name: '专业版', credits: 1000, bonus: 150, price: 69.9, originalPrice: 199.9 },
    enterprise: { name: '企业超值', credits: 3000, bonus: 600, price: 169.9, originalPrice: 599.9, isVIP: true }
};

export const orders = {
    getPlans() {
        return Object.entries(PLANS).map(([key, plan]) => ({
            id: key,
            ...plan,
            totalCredits: plan.credits + plan.bonus
        }));
    },

    async createOrder(userId, planType, paymentMethod = 'alipay') {
        const plan = PLANS[planType];
        if (!plan) throw new Error('无效的套餐类型');

        const orderId = `CW${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const expireAt = new Date(Date.now() + 30 * 60 * 1000); // 30分钟过期

        const { data, error } = await supabase
            .from('orders')
            .insert({
                order_id: orderId,
                user_id: userId,
                plan_type: planType,
                plan_name: plan.name,
                credits: plan.credits,
                bonus_credits: plan.bonus,
                total_credits: plan.credits + plan.bonus,
                amount: plan.price,
                original_amount: plan.originalPrice,
                discount: Math.round((1 - plan.price / plan.originalPrice) * 100),
                payment_method: paymentMethod,
                is_vip: plan.isVIP || false,
                expire_at: expireAt.toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        return {
            success: true,
            order: {
                ...data,
                qrcodeUrl: `/api/payment/qrcode/${data.order_id}`
            }
        };
    },

    async getOrders(userId, page = 1, limit = 10, status = '') {
        let query = supabase
            .from('orders')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range((page - 1) * limit, page * limit - 1);

        if (status) query = query.eq('status', status);

        const { data, count, error } = await query;
        if (error) throw error;

        return {
            orders: data,
            pagination: {
                current: page,
                pages: Math.ceil(count / limit),
                total: count,
                limit
            }
        };
    }
};

// ============================================
// 支付系统 (Payment Screenshots)
// ============================================

export const payment = {
    async uploadScreenshot(userId, orderId, file) {
        // 验证文件类型
        if (!['image/jpeg', 'image/png', 'image/jpg'].includes(file.type)) {
            throw new Error('只支持 JPG、PNG 格式的图片');
        }

        // 验证文件大小（5MB）
        if (file.size > 5 * 1024 * 1024) {
            throw new Error('图片大小不能超过5MB');
        }

        // 查询订单
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .select('*')
            .eq('order_id', orderId)
            .eq('user_id', userId)
            .single();

        if (orderError || !order) throw new Error('订单不存在');
        if (order.status !== 'pending') throw new Error('该订单已处理');

        // 检查是否过期
        if (new Date(order.expire_at) < new Date()) {
            await supabase.from('orders').update({ status: 'expired' }).eq('id', order.id);
            throw new Error('订单已过期，请重新下单');
        }

        // 上传文件到 Supabase Storage
        const fileExt = file.name.split('.').pop();
        const fileName = `${orderId}-${Date.now()}.${fileExt}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('payment-screenshots')
            .upload(`${userId}/${fileName}`, file, {
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) throw uploadError;

        // 获取公开URL
        const { data: urlData } = supabase.storage
            .from('payment-screenshots')
            .getPublicUrl(`${userId}/${fileName}`);

        // 创建截图记录
        const { data: screenshot, error: screenshotError } = await supabase
            .from('payment_screenshots')
            .insert({
                order_id: order.id,
                user_id: userId,
                image_url: urlData.publicUrl,
                original_name: file.name,
                file_size: file.size,
                mime_type: file.type
            })
            .select()
            .single();

        if (screenshotError) throw screenshotError;

        // 更新订单的截图URL
        await supabase
            .from('orders')
            .update({
                screenshot_url: urlData.publicUrl,
                screenshot_reviewed: false
            })
            .eq('id', order.id);

        return {
            success: true,
            message: '支付截图上传成功，请等待管理员审核（通常1-5分钟内完成）',
            screenshotId: screenshot.id,
            status: 'pending_review'
        };
    },

    async getPendingScreenshots(adminId) {
        const { data, error } = await supabase
            .from('payment_screenshots')
            .select(`
                *,
                orders(*, profiles!orders_user_id_fkey(username, email, credits)),
                users:profiles!user_id(username, email)
            `)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) throw error;
        return data;
    },

    async reviewScreenshot(screenshotId, adminId, action, note = '') {
        if (!['approve', 'reject'].includes(action)) {
            throw new Error('操作类型无效');
        }

        // 获取截图信息
        const { data: screenshot, error: fetchError } = await supabase
            .from('payment_screenshots')
            .select('*, orders(*)')
            .eq('id', screenshotId)
            .single();

        if (fetchError || !screenshot) throw new Error('截图记录不存在');
        if (screenshot.status !== 'pending') throw new Error('该截图已被处理');

        const order = screenshot.orders;

        // 更新截图状态
        await supabase
            .from('payment_screenshots')
            .update({
                status: action === 'approve' ? 'approved' : 'rejected',
                reviewed_by: adminId,
                reviewed_at: new Date().toISOString(),
                review_note: note
            })
            .eq('id', screenshotId);

        // 更新订单状态
        if (action === 'approve') {
            // 审核通过 - 更新订单为已支付
            await supabase
                .from('orders')
                .update({
                    status: 'paid',
                    paid_at: new Date().toISOString(),
                    screenshot_reviewed: true,
                    reviewed_by: adminId,
                    reviewed_at: new Date().toISOString(),
                    review_note: note
                })
                .eq('id', order.id);

            // 给用户添加积分
            await credits.addCredits(
                order.user_id,
                order.total_credits,
                order.bonus_credits > 0 ? 'bonus' : 'earn',
                `充值${order.plan_name}套餐`,
                order.id,
                { orderId: order.order_id, planType: order.plan_type, isVIP: order.is_vip }
            );
        } else {
            // 审核拒绝 - 标记订单失败
            await supabase
                .from('orders')
                .update({
                    status: 'failed',
                    screenshot_reviewed: true,
                    reviewed_by: adminId,
                    reviewed_at: new Date().toISOString(),
                    review_note: note
                })
                .eq('id', order.id);
        }

        return {
            success: true,
            message: action === 'approve' ? '审核通过，积分已到账' : '已拒绝该支付'
        };
    }
};

// ============================================
// 数据分析 (Analytics)
// ============================================

export const analytics = {
    async trackEvent(eventType, userId = null, data = {}) {
        const { error } = await supabase
            .from('analytics_events')
            .insert({
                event_type: eventType,
                user_id: userId,
                data,
                session_id: crypto.randomUUID?.() || Math.random().toString(36).substr(2, 16)
            });

        if (error) console.error('事件追踪错误:', error);
    },

    async getDashboard() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [usersResult, ordersResult] = await Promise.all([
            supabase.from('profiles').select('*'),
            supabase.from('orders').select('*').eq('status', 'paid')
        ]);

        const allUsers = usersResult.data || [];
        const paidOrders = ordersResult.data || [];

        return {
            overview: {
                totalUsers: allUsers.length,
                newUsersToday: allUsers.filter(u => u.created_at >= today.toISOString()).length,
                activeUsers: allUsers.filter(u => u.updated_at >= new Date(Date.now() - 7*24*60*60*1000).toISOString()).length,
                vipUsers: allUsers.filter(u => u.is_vip).length
            },
            revenue: {
                total: paidOrders.reduce((sum, o) => sum + parseFloat(o.amount), 0),
                today: paidOrders.filter(o => o.paid_at >= today.toISOString()).reduce((sum, o) => sum + parseFloat(o.amount), 0)
            },
            operations: {
                pendingReviews: 0 // 需要单独查询
            }
        };
    }
};

// 导出默认对象
export default supabase;