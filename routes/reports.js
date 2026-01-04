const express = require('express')
const router = express.Router()
const { Pool } = require('pg')
const { authenticateToken } = require('./auth')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

// All routes require authentication
router.use(authenticateToken)

// GET /api/reports/sales - Sales reports with various metrics
router.get('/sales', async (req, res) => {
  try {
    const {
      period = 'month',
      start_date,
      end_date,
      group_by = 'day'
    } = req.query

    let dateFilter = ''
    let groupByClause = ''
    let selectClause = ''

    // Set up date filtering (using order_date instead of created_at)
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
        case 'quarter':
          dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '90 days'"
          break
        case 'year':
          dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '365 days'"
          break
      }
    }

    // Set up grouping (using order_date instead of created_at)
    switch (group_by) {
      case 'day':
        groupByClause = "DATE(o.order_date)"
        selectClause = "DATE(o.order_date) as period"
        break
      case 'week':
        groupByClause = "DATE_TRUNC('week', o.order_date)"
        selectClause = "DATE_TRUNC('week', o.order_date) as period"
        break
      case 'month':
        groupByClause = "DATE_TRUNC('month', o.order_date)"
        selectClause = "DATE_TRUNC('month', o.order_date) as period"
        break
      default:
        groupByClause = "DATE(o.order_date)"
        selectClause = "DATE(o.order_date) as period"
    }

    // Simplified sales query
    let baseQuery = ''
    if (start_date && end_date) {
      baseQuery = `AND o.order_date >= '${start_date}' AND o.order_date <= '${end_date}'`
    } else {
      let intervalDays = 30
      switch (period) {
        case 'week': intervalDays = 7; break
        case 'month': intervalDays = 30; break
        case 'quarter': intervalDays = 90; break
        case 'year': intervalDays = 365; break
      }
      baseQuery = `AND o.order_date >= CURRENT_DATE - INTERVAL '${intervalDays} days'`
    }

    const salesReportQuery = `
      WITH OrderStats AS (
        SELECT 
           COUNT(o.id) as total_orders,
           COUNT(DISTINCT o.customer_id) as unique_customers,
           COALESCE(SUM(o.subtotal), 0) as total_sales,
           COALESCE(SUM(o.tax_amount), 0) as total_tax,
           COALESCE(SUM(o.total), 0) as total_revenue,
           COALESCE(AVG(o.total), 0) as average_order_value,
           COUNT(CASE WHEN o.status = 'completed' THEN 1 END) as completed_orders,
           COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled_orders
        FROM orders o
        WHERE 1=1 ${baseQuery}
      ),
      ItemStats AS (
        SELECT COALESCE(SUM(oi.quantity), 0) as total_items_sold
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        WHERE 1=1 ${baseQuery}
      )
      SELECT 
        CURRENT_DATE as period,
        os.total_orders,
        os.unique_customers,
        os.total_sales,
        os.total_tax,
        os.total_revenue,
        os.average_order_value,
        os.completed_orders,
        os.cancelled_orders,
        ist.total_items_sold
      FROM OrderStats os
      CROSS JOIN ItemStats ist
    `

    const salesResult = await pool.query(salesReportQuery)

    // Get top products for the same period
    const topProductsQuery = `
      SELECT 
        p.id,
        p.name,
        p.price,
        c.name as category_name,
        COALESCE(SUM(oi.quantity), 0) as total_quantity_sold,
        COALESCE(SUM(oi.total), 0) as total_revenue,
        COUNT(DISTINCT o.id) as orders_count
      FROM products p
      INNER JOIN order_items oi ON p.id = oi.product_id
      INNER JOIN orders o ON oi.order_id = o.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE o.status IN ('completed', 'processing') 
        -- -- AND p.deleted_at IS NULL temporarily disabled -- temporarily disabled 
        ${baseQuery}
      GROUP BY p.id, p.name, p.price, c.name
      ORDER BY total_revenue DESC
      LIMIT 10
    `

    const productsResult = await pool.query(topProductsQuery)

    // Get customer analysis - create separate date filter for subquery
    let customerDateFilter = ''
    if (start_date && end_date) {
      customerDateFilter = `AND order_date >= '${start_date}' AND order_date <= '${end_date}'`
    } else {
      let intervalDays = 30
      switch (period) {
        case 'week': intervalDays = 7; break
        case 'month': intervalDays = 30; break
        case 'quarter': intervalDays = 90; break
        case 'year': intervalDays = 365; break
      }
      customerDateFilter = `AND order_date >= CURRENT_DATE - INTERVAL '${intervalDays} days'`
    }

    const customersQuery = `
      SELECT 
        COUNT(DISTINCT c.id) as total_customers,
        COUNT(DISTINCT o.customer_id) as active_customers,
        COALESCE(AVG(customer_totals.total_spent), 0) as average_customer_value
      FROM customers c
      LEFT JOIN (
        SELECT 
          customer_id,
          SUM(total) as total_spent
        FROM orders 
        WHERE status IN ('completed', 'processing') 
          -- AND deleted_at IS NULL -- temporarily disabled
          ${customerDateFilter}
        GROUP BY customer_id
      ) customer_totals ON c.id = customer_totals.customer_id
      LEFT JOIN orders o ON c.id = o.customer_id -- AND o.deleted_at IS NULL -- temporarily disabled ${baseQuery}
      WHERE 1=1 -- deleted_at check temporarily disabled
    `

    const customersResult = await pool.query(customersQuery)

    // Format results
    const salesData = salesResult.rows.map(row => ({
      period: row.period,
      total_orders: parseInt(row.total_orders) || 0,
      unique_customers: parseInt(row.unique_customers) || 0,
      total_sales: parseFloat(row.total_sales) || 0,
      total_tax: parseFloat(row.total_tax) || 0,
      total_revenue: parseFloat(row.total_revenue) || 0,
      average_order_value: parseFloat(row.average_order_value) || 0,
      completed_orders: parseInt(row.completed_orders) || 0,
      cancelled_orders: parseInt(row.cancelled_orders) || 0,
      total_items_sold: parseFloat(row.total_items_sold) || 0
    }))

    const topProducts = productsResult.rows.map(row => ({
      ...row,
      total_quantity_sold: parseFloat(row.total_quantity_sold) || 0,
      total_revenue: parseFloat(row.total_revenue) || 0,
      orders_count: parseInt(row.orders_count) || 0,
      price: parseFloat(row.price) || 0
    }))

    const customerStats = customersResult.rows[0] || {}

    res.json({
      success: true,
      data: {
        period,
        group_by,
        date_range: { start_date, end_date },
        sales_data: salesData,
        top_products: topProducts,
        customer_stats: {
          total_customers: parseInt(customerStats.total_customers) || 0,
          active_customers: parseInt(customerStats.active_customers) || 0,
          average_customer_value: parseFloat(customerStats.average_customer_value) || 0
        }
      }
    })
  } catch (error) {
    console.error('Error generating sales report:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/reports/inventory - Inventory reports
router.get('/inventory', async (req, res) => {
  try {
    // Current inventory status
    const inventoryQuery = `
      SELECT 
        p.id,
        p.name,
        p.sku,
        p.stock,
        p.min_stock,
        p.price,
        p.cost,
        p.unit,
        c.name as category_name,
        (GREATEST(p.stock, 0) * COALESCE(p.price, 0)) as stock_value,
        (GREATEST(p.stock, 0) * COALESCE(p.cost, 0)) as stock_cost,
        CASE 
          WHEN p.stock <= 0 THEN 'out_of_stock'
          WHEN p.stock <= p.min_stock THEN 'low_stock'
          ELSE 'in_stock'
        END as stock_status
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1 -- deleted_at check temporarily disabled AND p.status = 'active'
      ORDER BY stock_value DESC
    `

    const inventoryResult = await pool.query(inventoryQuery)

    // Stock movements summary
    const movementsQuery = `
      SELECT 
        sm.movement_type as type,
        COUNT(*) as movement_count,
        SUM(ABS(sm.quantity)) as total_quantity,
        AVG(ABS(sm.quantity)) as average_quantity
      FROM stock_movements sm
      WHERE sm.created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY sm.movement_type
      ORDER BY total_quantity DESC
    `

    const movementsResult = await pool.query(movementsQuery)

    // Category analysis
    const categoryQuery = `
      SELECT 
        COALESCE(c.name, 'Sin Categoría') as category_name,
        COALESCE(c.color, '#6B7280') as category_color,
        COUNT(p.id) as products_count,
        SUM(GREATEST(p.stock, 0) * COALESCE(p.price, 0)) as category_value,
        SUM(GREATEST(p.stock, 0) * COALESCE(p.cost, 0)) as category_cost,
        AVG(p.stock) as average_stock,
        COUNT(*) FILTER (WHERE p.stock <= p.min_stock) as low_stock_products
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1 -- deleted_at check temporarily disabled AND p.status = 'active'
      GROUP BY c.name, c.color
      ORDER BY category_value DESC
    `

    const categoryResult = await pool.query(categoryQuery)

    // Calculate totals
    const totals = inventoryResult.rows.reduce((acc, product) => {
      acc.total_value += parseFloat(product.stock_value) || 0
      acc.total_cost += parseFloat(product.stock_cost) || 0

      switch (product.stock_status) {
        case 'out_of_stock':
          acc.out_of_stock_count++
          break
        case 'low_stock':
          acc.low_stock_count++
          break
        case 'in_stock':
          acc.in_stock_count++
          break
      }

      return acc
    }, {
      total_value: 0,
      total_cost: 0,
      out_of_stock_count: 0,
      low_stock_count: 0,
      in_stock_count: 0
    })

    // Format results
    const inventory = inventoryResult.rows.map(row => ({
      ...row,
      stock: parseFloat(row.stock) || 0,
      min_stock: parseFloat(row.min_stock) || 0,
      price: parseFloat(row.price) || 0,
      cost: parseFloat(row.cost) || 0,
      stock_value: parseFloat(row.stock_value) || 0,
      stock_cost: parseFloat(row.stock_cost) || 0
    }))

    const movements = movementsResult.rows.map(row => ({
      ...row,
      movement_count: parseInt(row.movement_count) || 0,
      total_quantity: parseFloat(row.total_quantity) || 0,
      average_quantity: parseFloat(row.average_quantity) || 0
    }))

    const categories = categoryResult.rows.map(row => ({
      ...row,
      products_count: parseInt(row.products_count) || 0,
      category_value: parseFloat(row.category_value) || 0,
      category_cost: parseFloat(row.category_cost) || 0,
      average_stock: parseFloat(row.average_stock) || 0,
      low_stock_products: parseInt(row.low_stock_products) || 0
    }))

    res.json({
      success: true,
      data: {
        summary: {
          total_products: inventory.length,
          total_value: totals.total_value,
          total_cost: totals.total_cost,
          profit_margin: totals.total_cost > 0 ? ((totals.total_value - totals.total_cost) / totals.total_cost * 100) : 0,
          in_stock_count: totals.in_stock_count,
          low_stock_count: totals.low_stock_count,
          out_of_stock_count: totals.out_of_stock_count
        },
        inventory,
        stock_movements: movements,
        categories
      }
    })
  } catch (error) {
    console.error('Error generating inventory report:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/reports/customers - Customer analysis reports
router.get('/customers', async (req, res) => {
  try {
    const { period = 'month' } = req.query

    let dateFilter = ''
    switch (period) {
      case 'week':
        dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '7 days'"
        break
      case 'month':
        dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '30 days'"
        break
      case 'quarter':
        dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '90 days'"
        break
      case 'year':
        dateFilter = "AND o.order_date >= CURRENT_DATE - INTERVAL '365 days'"
        break
    }

    // Customer performance analysis
    const customerAnalysisQuery = `
      SELECT 
        c.id,
        c.name,
        c.email,
        c.type,
        c.created_at,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_spent,
        COALESCE(AVG(o.total), 0) as average_order_value,
        MAX(o.order_date) as last_order_date,
        COUNT(DISTINCT DATE(o.order_date)) as days_with_orders,
        COALESCE(c.balance, 0) as balance
      FROM customers c
      LEFT JOIN orders o ON c.id = o.customer_id -- AND o.deleted_at IS NULL -- temporarily disabled
      WHERE 1=1 -- deleted_at check temporarily disabled
      GROUP BY c.id, c.name, c.email, c.type, c.created_at, c.balance
      ORDER BY total_spent DESC
      LIMIT 50
    `

    const customersResult = await pool.query(customerAnalysisQuery)

    // Customer segmentation
    const segmentationQuery = `
      WITH customer_metrics AS (
        SELECT 
          c.id,
          c.type,
          COALESCE(SUM(o.total), 0) as total_spent,
          COUNT(o.id) as order_count
        FROM customers c
        LEFT JOIN orders o ON c.id = o.customer_id -- AND o.deleted_at IS NULL -- temporarily disabled
        WHERE 1=1 -- deleted_at check temporarily disabled
        GROUP BY c.id, c.type
      )
      SELECT 
        type,
        COUNT(*) as customer_count,
        COALESCE(AVG(total_spent), 0) as average_spent,
        COALESCE(SUM(total_spent), 0) as total_revenue,
        COALESCE(AVG(order_count), 0) as average_orders,
        COUNT(*) FILTER (WHERE total_spent > 1000) as high_value_customers,
        COUNT(*) FILTER (WHERE order_count = 0) as inactive_customers
      FROM customer_metrics
      GROUP BY type
    `

    const segmentationResult = await pool.query(segmentationQuery)

    // New vs returning customers
    const newVsReturningQuery = `
      WITH customer_first_order AS (
        SELECT 
          customer_id,
          MIN(order_date) as first_order_date
        FROM orders
        WHERE 1=1 -- deleted_at check temporarily disabled
        GROUP BY customer_id
      )
      SELECT 
        COUNT(*) FILTER (WHERE cfo.first_order_date >= CURRENT_DATE - INTERVAL '30 days') as new_customers,
        COUNT(*) FILTER (WHERE cfo.first_order_date < CURRENT_DATE - INTERVAL '30 days') as returning_customers,
        COUNT(DISTINCT o.customer_id) as total_active_customers
      FROM orders o
      JOIN customer_first_order cfo ON o.customer_id = cfo.customer_id
      WHERE o.order_date >= CURRENT_DATE - INTERVAL '30 days'
        -- AND o.deleted_at IS NULL -- temporarily disabled
    `

    const newVsReturningResult = await pool.query(newVsReturningQuery)

    // Format results
    const customers = customersResult.rows.map(row => ({
      ...row,
      total_orders: parseInt(row.total_orders) || 0,
      total_spent: parseFloat(row.total_spent) || 0,
      average_order_value: parseFloat(row.average_order_value) || 0,
      days_with_orders: parseInt(row.days_with_orders) || 0,
      balance: parseFloat(row.balance) || 0
    }))

    const segmentation = segmentationResult.rows.map(row => ({
      ...row,
      customer_count: parseInt(row.customer_count) || 0,
      average_spent: parseFloat(row.average_spent) || 0,
      total_revenue: parseFloat(row.total_revenue) || 0,
      average_orders: parseFloat(row.average_orders) || 0,
      high_value_customers: parseInt(row.high_value_customers) || 0,
      inactive_customers: parseInt(row.inactive_customers) || 0
    }))

    const customerFlow = newVsReturningResult.rows[0] || {}

    res.json({
      success: true,
      data: {
        period,
        customers,
        segmentation,
        customer_flow: {
          new_customers: parseInt(customerFlow.new_customers) || 0,
          returning_customers: parseInt(customerFlow.returning_customers) || 0,
          total_active_customers: parseInt(customerFlow.total_active_customers) || 0
        }
      }
    })
  } catch (error) {
    console.error('Error generating customer report:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/reports/financial - Financial reports
router.get('/financial', async (req, res) => {
  try {
    const { period = 'month' } = req.query

    let dateFilter = ''
    switch (period) {
      case 'week':
        dateFilter = "WHERE o.order_date >= CURRENT_DATE - INTERVAL '7 days'"
        break
      case 'month':
        dateFilter = "WHERE o.order_date >= CURRENT_DATE - INTERVAL '30 days'"
        break
      case 'quarter':
        dateFilter = "WHERE o.order_date >= CURRENT_DATE - INTERVAL '90 days'"
        break
      case 'year':
        dateFilter = "WHERE o.order_date >= CURRENT_DATE - INTERVAL '365 days'"
        break
      default:
        dateFilter = "WHERE o.order_date >= CURRENT_DATE - INTERVAL '30 days'"
    }

    // Revenue and profit analysis
    const financialQuery = `
      SELECT 
        COALESCE(SUM(o.subtotal), 0) as total_sales,
        COALESCE(SUM(o.tax_amount), 0) as total_tax_collected,
        COALESCE(SUM(o.total), 0) as total_revenue,
        COUNT(DISTINCT o.id) as total_transactions,
        COALESCE(AVG(o.total), 0) as average_transaction_value
      FROM orders o
      ${dateFilter} 
        AND o.status IN ('completed', 'processing')
        AND (o.deleted_at IS NULL OR o.deleted_at IS NULL)
    `

    const financialResult = await pool.query(financialQuery)

    // Payment method analysis
    const paymentMethodQuery = `
      SELECT 
        payment_method,
        COUNT(*) as transaction_count,
        COALESCE(SUM(o.total), 0) as total_amount,
        COALESCE(AVG(o.total), 0) as average_amount
      FROM orders o
      ${dateFilter} 
        AND o.status IN ('completed', 'processing')
        -- AND o.deleted_at IS NULL -- temporarily disabled
      GROUP BY payment_method
      ORDER BY total_amount DESC
    `

    const paymentMethodResult = await pool.query(paymentMethodQuery)

    // Outstanding invoices
    const outstandingInvoicesQuery = `
      SELECT 
        COUNT(*) as pending_invoices,
        COALESCE(SUM(total), 0) as pending_amount,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE) as overdue_invoices,
        COALESCE(SUM(total) FILTER (WHERE due_date < CURRENT_DATE), 0) as overdue_amount
      FROM invoices
      WHERE status = 'pending'
        -- -- AND deleted_at IS NULL temporarily disabled -- temporarily disabled
    `

    const outstandingResult = await pool.query(outstandingInvoicesQuery)

    const financial = financialResult.rows[0] || {}
    const outstanding = outstandingResult.rows[0] || {}

    res.json({
      success: true,
      data: {
        period,
        revenue: {
          total_sales: parseFloat(financial.total_sales) || 0,
          total_tax_collected: parseFloat(financial.total_tax_collected) || 0,
          total_revenue: parseFloat(financial.total_revenue) || 0,
          total_transactions: parseInt(financial.total_transactions) || 0,
          average_transaction_value: parseFloat(financial.average_transaction_value) || 0
        },
        payment_methods: paymentMethodResult.rows.map(row => ({
          ...row,
          transaction_count: parseInt(row.transaction_count) || 0,
          total_amount: parseFloat(row.total_amount) || 0,
          average_amount: parseFloat(row.average_amount) || 0
        })),
        outstanding: {
          pending_invoices: parseInt(outstanding.pending_invoices) || 0,
          pending_amount: parseFloat(outstanding.pending_amount) || 0,
          overdue_invoices: parseInt(outstanding.overdue_invoices) || 0,
          overdue_amount: parseFloat(outstanding.overdue_amount) || 0
        }
      }
    })
  } catch (error) {
    console.error('Error generating financial report:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

module.exports = router