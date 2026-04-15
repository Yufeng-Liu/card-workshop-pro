-- ============================================
-- 智能卡片工坊 Pro - Supabase 数据库 Schema
-- ============================================
-- 
-- 📌 使用方法：
-- 1. 登录 https://supabase.com
-- 2. 创建新项目（选择免费套餐）
-- 3. 进入 SQL Editor
-- 4. 复制粘贴此文件内容并执行
-- 5. 等待所有表创建完成
--
-- ⚠️ 重要提示：执行前请确保项目已创建！
-- ============================================

-- 启用必要的扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- 1. 用户扩展表 (profiles)
-- 存储用户的额外信息（积分、VIP状态等）
-- ============================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT UNIQUE NOT NULL,
    avatar_url TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    
    -- 积分系统
    credits INTEGER NOT NULL DEFAULT 100,
    total_credits_earned BIGINT NOT NULL DEFAULT 0,
    total_credits_spent BIGINT NOT NULL DEFAULT 0,
    
    -- VIP 系统
    is_vip BOOLEAN NOT NULL DEFAULT FALSE,
    vip_expire_date TIMESTAMPTZ DEFAULT NULL,
    
    -- 角色和状态
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'vip', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'inactive')),
    
    -- 统计数据
    stats JSONB NOT NULL DEFAULT '{"totalGenerated":0,"todayGenerated":0,"lastGenerateDate":null}'::jsonb,
    
    -- 时间戳
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引以优化查询性能
CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_is_vip ON public.profiles(is_vip);

-- 自动更新 updated_at 触发器
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_profile_updated
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- 新用户注册时自动创建 profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, username, credits)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
        100
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- RLS: 只有用户本人或管理员可以查看/修改
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户可以查看自己的资料"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id OR 
           EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "用户可以更新自己的资料"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

CREATE POLICY "管理员可以更新任何人的资料"
    ON public.profiles FOR UPDATE
    USING (EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));


-- ============================================
-- 2. 订单表 (orders)
-- 存储充值订单信息
-- ============================================
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id TEXT UNIQUE NOT NULL,
    
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- 套餐信息
    plan_type TEXT NOT NULL CHECK (plan_type IN ('basic', 'popular', 'pro', 'enterprise')),
    plan_name TEXT NOT NULL,
    
    -- 积分数量
    credits INTEGER NOT NULL,
    bonus_credits INTEGER NOT NULL DEFAULT 0,
    total_credits INTEGER NOT NULL,
    
    -- 价格信息
    amount DECIMAL(10,2) NOT NULL,
    original_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    
    -- 支付方式
    payment_method TEXT NOT NULL DEFAULT 'alipay' CHECK (payment_method IN ('alipay', 'wechat')),
    
    -- 订单状态
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
    
    -- 支付截图
    screenshot_url TEXT DEFAULT '',
    screenshot_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed_by UUID REFERENCES public.profiles(id),
    reviewed_at TIMESTAMPTZ DEFAULT NULL,
    review_note TEXT DEFAULT '',
    
    -- VIP 标记
    is_vip BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- 时间戳
    expire_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引优化查询
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON public.orders(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON public.orders(status, created_at DESC);

-- 更新时间戳触发器
CREATE TRIGGER on_order_updated
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- RLS 策略
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户可以查看自己的订单"
    ON public.orders FOR SELECT
    USING (user_id = auth.uid() OR 
           EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "用户可以创建自己的订单"
    ON public.orders FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "管理员可以审核订单"
    ON public.orders FOR UPDATE
    USING (user_id = auth.uid() OR 
           EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));


-- ============================================
-- 3. 积分交易记录表 (credit_transactions)
-- 记录每笔积分变动
-- ============================================
CREATE TABLE IF NOT EXISTS public.credit_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- 交易类型
    type TEXT NOT NULL CHECK (type IN (
        'earn', 'spend', 'bonus', 'refund', 'admin_adjust',
        'signup_bonus', 'daily_checkin', 'invite_reward'
    )),
    
    -- 金额（正数为获得，负数为消耗）
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    
    -- 描述
    description TEXT NOT NULL,
    
    -- 关联订单
    order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
    
    -- 元数据（JSON格式存储额外信息）
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- 时间戳
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON public.credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON public.credit_transactions(type);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON public.credit_transactions(created_at DESC);

-- RLS
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户可以查看自己的交易记录"
    ON public.credit_transactions FOR SELECT
    USING (user_id = auth.uid() OR 
           EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "系统可以插入交易记录"
    ON public.credit_transactions FOR INSERT
    WITH CHECK (true);


-- ============================================
-- 4. 支付截图表 (payment_screenshots)
-- 存储用户上传的支付截图
-- ============================================
CREATE TABLE IF NOT EXISTS public.payment_screenshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID UNIQUE NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- 文件信息
    image_url TEXT NOT NULL,
    thumbnail_url TEXT DEFAULT '',
    original_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    
    -- 审核状态
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    
    -- 审核信息
    reviewed_by UUID REFERENCES public.profiles(id),
    reviewed_at TIMESTAMPTZ DEFAULT NULL,
    review_note TEXT DEFAULT '',
    
    -- AI 分析结果（预留）
    ai_analysis_result JSONB DEFAULT '{}'::jsonb,
    
    -- 时间戳
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_payment_screenshots_order_id ON public.payment_screenshots(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_screenshots_user_id ON public.payment_screenshots(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_screenshots_status ON public.payment_screenshots(status);

-- 触发器
CREATE TRIGGER on_payment_screenshot_updated
    BEFORE UPDATE ON public.payment_screenshots
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- RLS
ALTER TABLE public.payment_screenshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户可以查看自己的截图"
    ON public.payment_screenshots FOR SELECT
    USING (user_id = auth.uid() OR 
           EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "用户可以上传自己的截图"
    ON public.payment_screenshots FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "管理员可以审核截图"
    ON public.payment_screenshots FOR UPDATE
    USING (EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));


-- ============================================
-- 5. 分析事件表 (analytics_events)
-- 追踪用户行为数据
-- ============================================
CREATE TABLE IF NOT EXISTS public.analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    event_type TEXT NOT NULL CHECK (event_type IN (
        'page_view', 'user_register', 'user_login', 'card_generate',
        'credit_spend', 'payment_init', 'payment_complete', 'payment_reject',
        'template_change', 'download', 'favorite', 'share', 'error'
    )),
    
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    session_id TEXT DEFAULT '',
    
    data JSONB DEFAULT '{}'::jsonb,
    
    user_agent TEXT DEFAULT '',
    ip_address INET DEFAULT '',
    referer TEXT DEFAULT '',
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引（用于快速查询统计）
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON public.analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON public.analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON public.analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created ON public.analytics_events(event_type, created_at DESC);

-- RLS: 所有认证用户都可以插入，只有管理员可以查询
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "任何人都可以插入事件" (用于匿名追踪)
    ON public.analytics_events FOR INSERT
    WITH CHECK (true);

CREATE POLICY "管理员可以查看所有事件"
    ON public.analytics_events FOR SELECT
    USING (EXISTS(SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));


-- ============================================
-- 6. 存储桶配置 (Storage Buckets)
-- 用于存储支付截图等文件
-- ============================================
-- 注意：这部分需要在 Supabase Dashboard 的 Storage 页面手动创建

-- 创建存储桶的 SQL（如果支持）
DO $$
BEGIN
    -- 尝试创建存储桶（某些版本可能不支持SQL创建）
    BEGIN
        INSERT INTO storage.buckets (id, name, public)
        VALUES ('payment-screenshots', 'payment-screenshots', false)
        ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '存储桶可能需要通过Dashboard创建';
    END;
END $$;

-- 存储桶策略（如果桶存在的话）
CREATE POLICY "已认证用户可以上传"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'payment-screenshots' AND auth.role() = 'authenticated');

CREATE POLICY "用户可以查看自己的文件"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'payment-screenshots' AND 
           auth.uid()::text = (storage.foldername(name))[1]);


-- ============================================
-- 7. 初始化管理员账户
-- ============================================
-- 注意：这将在第一次注册后通过触发器自动创建 profile
-- 你可以通过 Supabase Auth 面板邀请管理员，或使用以下方式：

-- 创建管理员账户的函数（执行一次即可）
CREATE OR REPLACE FUNCTION public.create_admin_user()
RETURNS void AS $$
DECLARE
    admin_email TEXT := 'admin@cardworkshop.com';  -- 修改为你的管理员邮箱
BEGIN
    -- 检查是否已存在管理员
    IF EXISTS(SELECT 1 FROM public.profiles WHERE email = admin_email) THEN
        RAISE NOTICE '管理员账户已存在';
        RETURN;
    END IF;
    
    -- 这里只是示例，实际应该通过 Auth API 或 Dashboard 创建用户
    RAISE NOTICE '请通过 Supabase Dashboard → Authentication → Users → Add user 创建管理员';
    RAISE NOTICE '邮箱: %', admin_email;
END;
$$ LANGUAGE plpgsql;


-- ============================================
-- 完成提示
-- ============================================
SELECT '✅ 数据库 Schema 创建成功！' AS status,
       'profiles' AS table_1,
       'orders' AS table_2,
       'credit_transactions' AS table_3,
       'payment_screenshots' AS table_4,
       'analytics_events' AS table_5;

-- 显示所有创建的表
SELECT table_name, 
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as columns
FROM information_schema.tables t
WHERE table_schema = 'public'
AND table_name IN ('profiles', 'orders', 'credit_transactions', 'payment_screenshots', 'analytics_events')
ORDER BY table_name;