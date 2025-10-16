const express = require('express')
const router = express.Router()
const { Pool } = require('pg')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

// GET /api/dashboard/metrics - Get main dashboard metrics
router.get('/metrics', async (req, res) => {
  try {
    const metricsQuery = `
      WITH date_ranges AS (
        SELECT 
          CURRENT_DATE as today,
          CURRENT_DATE - INTERVAL '1 day' as yesterday,
          DATE_TRUNC('month', CURRENT_DATE) as month_start,
          DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') as last_month_start,
          DATE_TRUNC('week', CURRENT_DATE) as week_start
      ),
      sales_metrics AS (
        SELECT 
          -- Today's sales
          COALESCE(SUM(o.total) FILTER (WHERE DATE(o.created_at) = dr.today), 0) as today_sales,
          COALESCE(SUM(o.total) FILTER (WHERE DATE(o.created_at) = dr.yesterday), 0) as yesterday_sales,
          
          -- This month vs last month
          COALESCE(SUM(o.total) FILTER (WHERE o.created_at >= dr.month_start), 0) as month_sales,
          COALESCE(SUM(o.total) FILTER (WHERE o.created_at >= dr.last_month_start AND o.created_at < dr.month_start), 0) as last_month_sales,
          
          -- Orders count
          COUNT(o.id) FILTER (WHERE o.status = 'pending') as pending_orders,
          COUNT(o.id) FILTER (WHERE DATE(o.created_at) = dr.today) as today_orders
        FROM date_ranges dr
        CROSS JOIN orders o
        WHERE o.status IN ('completed', 'pending', 'processing')
        GROUP BY dr.today, dr.yesterday, dr.month_start, dr.last_month_start
      ),
      inventory_metrics AS (
        SELECT 
          COALESCE(SUM(p.stock * p.price), 0) as inventory_value,
          COALESCE(SUM(p.stock * p.cost), 0) as inventory_cost,
          COUNT(p.id) FILTER (WHERE p.stock <= p.min_stock) as low_stock_count,
          COUNT(p.id) FILTER (WHERE p.stock = 0) as out_of_stock_count,
          COUNT(p.id) as total_products
        FROM products p
        WHERE 1=1 -- deleted_at check temporarily disabled AND p.status = 'active'
      ),
      customer_metrics AS (
        SELECT 
          COUNT(c.id) as total_customers,
          COUNT(c.id) FILTER (WHERE c.created_at >= CURRENT_DATE - INTERVAL '30 days') as new_customers_month
        FROM customers c
        WHERE 1=1 -- deleted_at check temporarily disabled
      )
      SELECT 
        sm.*,
        im.*,
        cm.*,
        -- Calculate growth percentages
        CASE 
          WHEN sm.yesterday_sales > 0 
          THEN ROUND(((sm.today_sales - sm.yesterday_sales) / sm.yesterday_sales * 100)::numeric, 1)
          ELSE 0 
        END as daily_growth_percent,
        CASE 
          WHEN sm.last_month_sales > 0 
          THEN ROUND(((sm.month_sales - sm.last_month_sales) / sm.last_month_sales * 100)::numeric, 1)
          ELSE 0 
        END as monthly_growth_percent
      FROM sales_metrics sm
      CROSS JOIN inventory_metrics im
      CROSS JOIN customer_metrics cm
    `
    
    const result = await pool.query(metricsQuery)
    const metrics = result.rows[0] || {}
    
    res.json({
      success: true,
      data: {
        sales: {
          today: parseFloat(metrics.today_sales) || 0,
          yesterday: parseFloat(metrics.yesterday_sales) || 0,
          month: parseFloat(metrics.month_sales) || 0,
          last_month: parseFloat(metrics.last_month_sales) || 0,
          daily_growth: parseFloat(metrics.daily_growth_percent) || 0,
          monthly_growth: parseFloat(metrics.monthly_growth_percent) || 0
        },
        orders: {
          pending: parseInt(metrics.pending_orders) || 0,
          today: parseInt(metrics.today_orders) || 0
        },
        inventory: {
          total_value: parseFloat(metrics.inventory_value) || 0,
          total_cost: parseFloat(metrics.inventory_cost) || 0,
          low_stock_products: parseInt(metrics.low_stock_count) || 0,
          out_of_stock_products: parseInt(metrics.out_of_stock_count) || 0,
          total_products: parseInt(metrics.total_products) || 0,
          profit_margin: metrics.inventory_cost > 0 ? 
            ((parseFloat(metrics.inventory_value) - parseFloat(metrics.inventory_cost)) / parseFloat(metrics.inventory_cost) * 100) : 0
        },
        customers: {
          total: parseInt(metrics.total_customers) || 0,
          new_this_month: parseInt(metrics.new_customers_month) || 0
        }
      }
    })
  } catch (error) {
    console.error('Error fetching dashboard metrics:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/dashboard/sales-chart - Get sales data for charts
router.get('/sales-chart', async (req, res) => {
  try {
    const { 
      period = 'week', 
      start_date, 
      end_date 
    } = req.query
    
    let startDate, endDate, dateInterval, groupBy
    
    // Set up date filtering - support custom date range
    if (start_date && end_date) {
      startDate = start_date
      endDate = end_date
      groupBy = 'DATE(o.order_date)'
    } else {
      // Use period-based filtering
      const today = new Date()
      switch (period) {
        case 'week':
          startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          break
        case 'month':
          startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          break
        case 'year':
          startDate = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          break
        default:
          startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      }
      endDate = today.toISOString().split('T')[0]
      groupBy = 'DATE(o.order_date)'
    }
    
    const chartQuery = `
      WITH date_series AS (
        SELECT generate_series(
          '${startDate}'::DATE,
          '${endDate}'::DATE,
          INTERVAL '1 day'
        )::DATE as date
      ),
      sales_data AS (
        SELECT 
          ${groupBy} as period,
          COUNT(o.id) as orders_count,
          COALESCE(SUM(o.total), 0) as total_sales,
          COALESCE(SUM(o.subtotal), 0) as subtotal,
          COALESCE(SUM(o.tax_amount), 0) as tax_amount
        FROM orders o
        WHERE o.order_date >= '${startDate}' 
          AND o.order_date <= '${endDate}'
          AND o.status IN ('completed', 'processing', 'pending')
        GROUP BY ${groupBy}
      )
      SELECT 
        ds.date,
        COALESCE(sd.orders_count, 0) as orders_count,
        COALESCE(sd.total_sales, 0) as total_sales,
        COALESCE(sd.subtotal, 0) as subtotal,
        COALESCE(sd.tax_amount, 0) as tax_amount
      FROM date_series ds
      LEFT JOIN sales_data sd ON ds.date = sd.period
      ORDER BY ds.date
    `
    
    const result = await pool.query(chartQuery)
    
    const chartData = result.rows.map(row => ({
      date: row.date.toISOString().split('T')[0],
      orders: parseInt(row.orders_count) || 0,
      sales: parseFloat(row.total_sales) || 0,
      subtotal: parseFloat(row.subtotal) || 0,
      tax: parseFloat(row.tax_amount) || 0
    }))
    
    res.json({
      success: true,
      data: {
        period,
        date_range: { start_date, end_date },
        chart_data: chartData
      }
    })
  } catch (error) {
    console.error('Error fetching sales chart data:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/dashboard/top-products - Get top selling products
router.get('/top-products', async (req, res) => {
  try {
    const { limit = 10, period = 'month' } = req.query
    
    let dateFilter = ''
    switch (period) {
      case 'week':
        dateFilter = "AND o.created_at >= CURRENT_DATE - INTERVAL '7 days'"
        break
      case 'month':
        dateFilter = "AND o.created_at >= CURRENT_DATE - INTERVAL '30 days'"
        break
      case 'year':
        dateFilter = "AND o.created_at >= CURRENT_DATE - INTERVAL '365 days'"
        break
    }
    
    const topProductsQuery = `
      SELECT 
        p.id,
        p.name,
        p.price,
        c.name as category_name,
        c.color as category_color,
        SUM(oi.quantity) as total_quantity_sold,
        SUM(oi.total) as total_revenue,
        COUNT(DISTINCT o.id) as orders_count,
        AVG(oi.unit_price) as average_price
      FROM products p
      INNER JOIN order_items oi ON p.id = oi.product_id
      INNER JOIN orders o ON oi.order_id = o.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE o.status IN ('completed', 'processing')
        ${dateFilter}
        -- AND p.deleted_at IS NULL -- temporarily disabled
      GROUP BY p.id, p.name, p.price, c.name, c.color
      ORDER BY total_revenue DESC
      LIMIT $1
    `
    
    const result = await pool.query(topProductsQuery, [limit])
    
    const topProducts = result.rows.map(product => ({
      ...product,
      total_quantity_sold: parseFloat(product.total_quantity_sold) || 0,
      total_revenue: parseFloat(product.total_revenue) || 0,
      orders_count: parseInt(product.orders_count) || 0,
      average_price: parseFloat(product.average_price) || 0,
      price: parseFloat(product.price) || 0
    }))
    
    res.json({
      success: true,
      data: {
        period,
        products: topProducts
      }
    })
  } catch (error) {
    console.error('Error fetching top products:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/dashboard/recent-orders - Get recent orders
router.get('/recent-orders', async (req, res) => {
  try {
    const { 
      limit = 10, 
      start_date, 
      end_date 
    } = req.query
    
    // Set up date filtering - support custom date range
    let dateFilter = ''
    if (start_date && end_date) {
      dateFilter = `AND o.order_date >= '${start_date}' AND o.order_date <= '${end_date}'`
    }
    
    const recentOrdersQuery = `
      SELECT 
        o.id,
        o.order_number,
        o.total,
        o.status,
        o.payment_method,
        o.order_date,
        o.created_at,
        COALESCE(c.name, 'Cliente sin nombre') as customer_name,
        o.customer_id,
        COUNT(oi.id) as items_count
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1 -- deleted_at check temporarily disabled
        ${dateFilter}
      GROUP BY o.id, o.order_number, o.total, o.status, o.payment_method, o.order_date, o.created_at, c.name, o.customer_id
      ORDER BY o.order_date DESC, o.created_at DESC
      LIMIT $1
    `
    
    const result = await pool.query(recentOrdersQuery, [limit])
    
    const recentOrders = result.rows.map(order => ({
      ...order,
      total: parseFloat(order.total) || 0,
      items_count: parseInt(order.items_count) || 0
    }))
    
    res.json({
      success: true,
      data: { 
        date_range: { start_date, end_date },
        orders: recentOrders 
      }
    })
  } catch (error) {
    console.error('Error fetching recent orders:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/dashboard/low-stock - Get low stock alerts
router.get('/low-stock', async (req, res) => {
  try {
    const lowStockQuery = `
      SELECT 
        p.id,
        p.name,
        p.sku,
        p.stock,
        p.min_stock,
        p.price,
        p.unit,
        c.name as category_name,
        c.color as category_color,
        (p.min_stock - p.stock) as reorder_quantity
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.stock <= p.min_stock 
        AND p.status = 'active' 
        -- -- AND p.deleted_at IS NULL temporarily disabled -- temporarily disabled
      ORDER BY (p.min_stock - p.stock) DESC, p.name ASC
      LIMIT 20
    `
    
    const result = await pool.query(lowStockQuery)
    
    const lowStockProducts = result.rows.map(product => ({
      ...product,
      stock: parseFloat(product.stock) || 0,
      min_stock: parseFloat(product.min_stock) || 0,
      price: parseFloat(product.price) || 0,
      reorder_quantity: parseFloat(product.reorder_quantity) || 0
    }))
    
    res.json({
      success: true,
      data: { products: lowStockProducts }
    })
  } catch (error) {
    console.error('Error fetching low stock products:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/dashboard/category-sales - Get sales distribution by category
router.get('/category-sales', async (req, res) => {
  try {
    const { 
      period = 'month', 
      start_date, 
      end_date 
    } = req.query
    
    let dateFilter = ''
    
    // Set up date filtering - support custom date range
    if (start_date && end_date) {
      dateFilter = `AND o.order_date >= '${start_date}' AND o.order_date <= '${end_date}'`
    } else {
      switch (period) {
        case 'week':
          dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '7 days'"
          break
        case 'month':
          dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '30 days'"
          break
        case 'year':
          dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '365 days'"
          break
      }
    }
    
    const categorySalesQuery = `
      SELECT 
        COALESCE(c.name, 'Sin Categoría') as category_name,
        COALESCE(c.color, '#6B7280') as category_color,
        SUM(oi.total) as total_sales,
        SUM(oi.quantity) as total_quantity,
        COUNT(DISTINCT oi.product_id) as products_count,
        COUNT(DISTINCT o.id) as orders_count
      FROM order_items oi
      INNER JOIN orders o ON oi.order_id = o.id
      LEFT JOIN products p ON oi.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE o.status IN ('completed', 'processing')
        ${dateFilter}
      GROUP BY c.name, c.color
      ORDER BY total_sales DESC
    `
    
    const result = await pool.query(categorySalesQuery)
    
    const categorySales = result.rows.map(category => ({
      ...category,
      total_sales: parseFloat(category.total_sales) || 0,
      total_quantity: parseFloat(category.total_quantity) || 0,
      products_count: parseInt(category.products_count) || 0,
      orders_count: parseInt(category.orders_count) || 0
    }))
    
    res.json({
      success: true,
      data: {
        period,
        date_range: { start_date, end_date },
        categories: categorySales
      }
    })
  } catch (error) {
    console.error('Error fetching category sales:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

module.exports = router