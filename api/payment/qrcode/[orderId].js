// Vercel Serverless Function - 支付宝收款码接口
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { orderId } = req.query;

  try {
    const { data, error } = await supabase.storage
      .from('payment-screenshots')
      .download('alipay-qrcode.png');

    if (error || !data) {
      return res.status(404).json({
        success: false,
        message: '收款码图片未上传，请联系管理员'
      });
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    
    const arrayBuffer = await data.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('获取收款码错误:', error);
    return res.status(500).json({
      success: false,
      message: '获取收款码失败'
    });
  }
};