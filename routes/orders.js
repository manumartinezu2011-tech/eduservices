const express = require('express')
const router = express.Router()
const { Pool } = require('pg')
const { body, validationResult } = require('express-validator')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

// Helper function to generate order number
async function generateOrderNumber() {
  const result = await pool.query(`
    SELECT order_number 
    FROM orders 
    WHERE order_number ~ '^ORD-[0-9]+$'
    ORDER BY CAST(SUBSTRING(order_number FROM 5) AS INTEGER) DESC 
    LIMIT 1
  `)
  
  let nextNumber = 'ORD-001'
  if (result.rows.length > 0) {
    const lastNumber = result.rows[0].order_number
    const numberPart = parseInt(lastNumber.split('-')[1])
    nextNumber = `ORD-${String(numberPart + 1).padStart(3, '0')}`
  }
  
  return nextNumber
}

// GET /api/orders - Get all orders with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      customer_id, 
      payment_status,
      date_from, 
      date_to, 
      search, 
      page = 1, 
      limit = 50 
    } = req.query
    
    let query = `
      SELECT 
        o.*,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        COUNT(oi.id) as items_count,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', oi.id,
              'product_id', oi.product_id,
              'product_name', oi.product_name,
              'sku', oi.sku,
              'quantity', oi.quantity,
              'unit_price', oi.unit_price,
              'total', oi.total
            )
          ) FILTER (WHERE oi.id IS NOT NULL), 
          '[]'::json
        ) as items
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1
    `
    
    const queryParams = []
    let paramIndex = 1
    
    if (status) {
      query += ` AND o.status = $${paramIndex}`
      queryParams.push(status)
      paramIndex++
    }
    
    if (customer_id) {
      query += ` AND o.customer_id = $${paramIndex}`
      queryParams.push(customer_id)
      paramIndex++
    }
    
    if (payment_status) {
      query += ` AND o.payment_status = $${paramIndex}`
      queryParams.push(payment_status)
      paramIndex++
    }
    
    if (date_from) {
      query += ` AND o.created_at >= $${paramIndex}`
      queryParams.push(date_from)
      paramIndex++
    }
    
    if (date_to) {
      query += ` AND o.created_at <= $${paramIndex}`
      queryParams.push(date_to + ' 23:59:59')
      paramIndex++
    }
    
    if (search) {
      query += ` AND (o.order_number ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`
      queryParams.push(`%${search}%`)
      paramIndex++
    }
    
    query += `
      GROUP BY o.id, c.name, c.email, c.phone
      ORDER BY o.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `
    
    queryParams.push(limit, (page - 1) * limit)
    
    const result = await pool.query(query, queryParams)
    
    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(DISTINCT o.id) as total
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE 1=1
    `
    
    let countParams = []
    let countParamIndex = 1
    
    if (status) {
      countQuery += ` AND o.status = $${countParamIndex}`
      countParams.push(status)
      countParamIndex++
    }
    
    if (customer_id) {
      countQuery += ` AND o.customer_id = $${countParamIndex}`
      countParams.push(customer_id)
      countParamIndex++
    }
    
    if (payment_status) {
      countQuery += ` AND o.payment_status = $${countParamIndex}`
      countParams.push(payment_status)
      countParamIndex++
    }
    
    if (date_from) {
      countQuery += ` AND o.created_at >= $${countParamIndex}`
      countParams.push(date_from)
      countParamIndex++
    }
    
    if (date_to) {
      countQuery += ` AND o.created_at <= $${countParamIndex}`
      countParams.push(date_to + ' 23:59:59')
      countParamIndex++
    }
    
    if (search) {
      countQuery += ` AND (o.order_number ILIKE $${countParamIndex} OR c.name ILIKE $${countParamIndex})`
      countParams.push(`%${search}%`)
      countParamIndex++
    }
    
    const countResult = await pool.query(countQuery, countParams)
    const total = parseInt(countResult.rows[0].total)
    
    // Format the results
    const orders = result.rows.map(order => ({
      ...order,
      subtotal: parseFloat(order.subtotal) || 0,
      tax_amount: parseFloat(order.tax_amount) || 0,
      discount_amount: parseFloat(order.discount_amount) || 0,
      total: parseFloat(order.total) || 0,
      tax_rate: parseFloat(order.tax_rate) || 0,
      items_count: parseInt(order.items_count) || 0
    }))
    
    res.json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Error fetching orders:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/orders/:id - Get specific order
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    
    const query = `
      SELECT 
        o.*,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.address as customer_address,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', oi.id,
            'product_id', oi.product_id,
            'product_name', oi.product_name,
            'sku', oi.sku,
            'quantity', oi.quantity,
            'unit_price', oi.unit_price,
            'total', oi.total
          )
        ) as items
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = $1
      GROUP BY o.id, c.name, c.email, c.phone, c.address
    `
    
    const result = await pool.query(query, [id])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Order not found' 
      })
    }
    
    const order = {
      ...result.rows[0],
      subtotal: parseFloat(result.rows[0].subtotal) || 0,
      tax_amount: parseFloat(result.rows[0].tax_amount) || 0,
      discount_amount: parseFloat(result.rows[0].discount_amount) || 0,
      total: parseFloat(result.rows[0].total) || 0,
      tax_rate: parseFloat(result.rows[0].tax_rate) || 0
    }
    
    res.json({
      success: true,
      data: order
    })
  } catch (error) {
    console.error('Error fetching order:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// POST /api/orders - Create new order
router.post('/', [
  body('customer_id').optional().isUUID().withMessage('Customer ID must be a valid UUID'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required and must not be empty'),
  body('items.*.product_id').isUUID().withMessage('Product ID is required and must be a valid UUID'),
  body('items.*.quantity').isNumeric().withMessage('Quantity must be numeric'),
  body('items.*.unit_price').isNumeric().withMessage('Unit price must be numeric'),
  body('discount_percentage').optional().isFloat({ min: 0, max: 100 }).withMessage('Discount percentage must be between 0 and 100')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  const client = await pool.connect()
  
  try {
    await client.query('BEGIN')
    
    const {
      customer_id,
      customer_name,
      items,
      delivery_address,
      delivery_date,
      payment_method = 'cash',
      notes,
      user_id,
      discount_percentage = 0
    } = req.body
    
    // Generate order number
    const orderNumber = await generateOrderNumber()
    
    // Calculate totals
    let subtotal = 0
    const processedItems = []
    
    for (const item of items) {
      // Get product details and check stock
      const productResult = await client.query(
        'SELECT * FROM products WHERE id = $1 -- -- AND deleted_at IS NULL temporarily disabled -- temporarily disabled',
        [item.product_id]
      )
      
      if (productResult.rows.length === 0) {
        throw new Error(`Product with ID ${item.product_id} not found`)
      }
      
      const product = productResult.rows[0]
      const quantity = parseFloat(item.quantity)
      const unitPrice = parseFloat(item.unit_price) || parseFloat(product.price)
      const itemTotal = quantity * unitPrice
      
      // Check stock availability
      if (parseFloat(product.stock) < quantity) {
        throw new Error(`Insufficient stock for product ${product.name}. Available: ${product.stock}, Requested: ${quantity}`)
      }
      
      processedItems.push({
        product_id: item.product_id,
        product_name: product.name,
        sku: product.sku,
        quantity,
        unit_price: unitPrice,
        total: itemTotal
      })
      
      subtotal += itemTotal
    }
    
    // Calculate discount
    const discountAmount = (subtotal * parseFloat(discount_percentage)) / 100
    const subtotalAfterDiscount = subtotal - discountAmount

    // Calculate tax on discounted amount
    const taxRate = 0.19 // 19% IVA Chile
    const taxAmount = subtotalAfterDiscount * taxRate
    const total = subtotalAfterDiscount + taxAmount
    
    // Create order
    const orderQuery = `
      INSERT INTO orders
      (customer_id, order_number, subtotal, tax_amount, discount_amount, discount_percentage, total,
       delivery_date, payment_method, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `

    const orderResult = await client.query(orderQuery, [
      customer_id, orderNumber, subtotal, taxAmount, discountAmount, discount_percentage, total,
      delivery_date, payment_method, notes
    ])
    
    const order = orderResult.rows[0]
    
    // Create order items and update stock
    for (const item of processedItems) {
      // Create order item
      await client.query(`
        INSERT INTO order_items 
        (order_id, product_id, product_name, sku, quantity, unit_price, total)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [order.id, item.product_id, item.product_name, item.sku, item.quantity, item.unit_price, item.total])
      
      // Update product stock
      const stockResult = await client.query(
        'SELECT stock FROM products WHERE id = $1',
        [item.product_id]
      )
      
      const currentStock = parseFloat(stockResult.rows[0].stock)
      const newStock = currentStock - item.quantity
      
      await client.query(
        'UPDATE products SET stock = $2 WHERE id = $1',
        [item.product_id, newStock]
      )
      
      // Create stock movement
      await client.query(`
        INSERT INTO stock_movements 
        (product_id, movement_type, quantity, reference_type, reference_id, notes)
        VALUES ($1, 'out', $2, 'sale', $3, $4)
      `, [item.product_id, item.quantity, order.id, `Sale from order ${orderNumber}`])
    }
    
    await client.query('COMMIT')
    
    // Fetch complete order with items
    const completeOrder = await pool.query(`
      SELECT 
        o.*,
        c.name as customer_name,
        c.email as customer_email,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', oi.id,
            'product_id', oi.product_id,
            'product_name', oi.product_name,
            'sku', oi.sku,
            'quantity', oi.quantity,
            'unit_price', oi.unit_price,
            'total', oi.total
          )
        ) as items
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = $1
      GROUP BY o.id, c.name, c.email
    `, [order.id])
    
    res.status(201).json({
      success: true,
      data: {
        ...completeOrder.rows[0],
        subtotal: parseFloat(completeOrder.rows[0].subtotal) || 0,
        tax_amount: parseFloat(completeOrder.rows[0].tax_amount) || 0,
        total: parseFloat(completeOrder.rows[0].total) || 0,
        tax_rate: parseFloat(completeOrder.rows[0].tax_rate) || 0
      },
      message: 'Order created successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error creating order:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  } finally {
    client.release()
  }
})

// PATCH /api/orders/:id/status - Update order status
router.patch('/:id/status', [
  body('status').isIn(['pending', 'processing', 'completed', 'cancelled']).withMessage('Invalid status'),
  body('notes').optional().isString()
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  const client = await pool.connect()
  
  try {
    await client.query('BEGIN')
    
    const { id } = req.params
    const { status, notes } = req.body
    
    // Get current order
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [id])
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Order not found' 
      })
    }
    
    const currentOrder = orderResult.rows[0]
    const currentStatus = currentOrder.status
    
    // Handle status transitions
    if (currentStatus === 'cancelled' && status !== 'cancelled') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot change status of cancelled order' 
      })
    }
    
    if (currentStatus === 'completed' && status !== 'completed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot change status of completed order' 
      })
    }
    
    // If cancelling order, restore stock
    if (status === 'cancelled' && currentStatus !== 'cancelled') {
      const orderItems = await client.query('SELECT * FROM order_items WHERE order_id = $1', [id])
      
      for (const item of orderItems.rows) {
        const stockResult = await client.query('SELECT stock FROM products WHERE id = $1', [item.product_id])
        const currentStock = parseFloat(stockResult.rows[0].stock)
        const newStock = currentStock + parseFloat(item.quantity)
        
        await client.query('UPDATE products SET stock = $2 WHERE id = $1', [item.product_id, newStock])
        
        // Create stock movement for return
        await client.query(`
          INSERT INTO stock_movements 
          (product_id, movement_type, quantity, reference_type, reference_id, notes)
          VALUES ($1, 'in', $2, 'return', $3, $4)
        `, [item.product_id, parseFloat(item.quantity), id, `Order cancellation ${currentOrder.order_number}`])
      }
    }
    
    // Update order status
    const updateFields = ['status = $2', 'updated_at = CURRENT_TIMESTAMP']
    const updateValues = [id, status]
    let paramIndex = 3
    
    // Remove completed_at field update since column doesn't exist
    // if (status === 'completed') {
    //   updateFields.push(`completed_at = CURRENT_TIMESTAMP`)
    // }
    
    if (notes) {
      updateFields.push(`notes = $${paramIndex}`)
      updateValues.push(notes)
      paramIndex++
    }
    
    const updateQuery = `UPDATE orders SET ${updateFields.join(', ')} WHERE id = $1 RETURNING *`
    const result = await client.query(updateQuery, updateValues)
    
    await client.query('COMMIT')
    
    res.json({
      success: true,
      data: {
        ...result.rows[0],
        subtotal: parseFloat(result.rows[0].subtotal) || 0,
        tax_amount: parseFloat(result.rows[0].tax_amount) || 0,
        total: parseFloat(result.rows[0].total) || 0,
        tax_rate: parseFloat(result.rows[0].tax_rate) || 0
      },
      message: 'Order status updated successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating order status:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  } finally {
    client.release()
  }
})

// GET /api/orders/stats - Get order statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_orders,
        COUNT(*) FILTER (WHERE status = 'processing') as processing_orders,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_orders,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_orders,
        COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(SUM(total) FILTER (WHERE status = 'completed'), 0) as completed_revenue,
        COALESCE(AVG(total), 0) as average_order_value,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today_orders,
        COALESCE(SUM(total) FILTER (WHERE created_at >= CURRENT_DATE), 0) as today_revenue
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '1 year'
    `
    
    const result = await pool.query(query)
    const stats = result.rows[0]
    
    res.json({
      success: true,
      data: {
        total_orders: parseInt(stats.total_orders) || 0,
        pending_orders: parseInt(stats.pending_orders) || 0,
        processing_orders: parseInt(stats.processing_orders) || 0,
        completed_orders: parseInt(stats.completed_orders) || 0,
        cancelled_orders: parseInt(stats.cancelled_orders) || 0,
        total_revenue: parseFloat(stats.total_revenue) || 0,
        completed_revenue: parseFloat(stats.completed_revenue) || 0,
        average_order_value: parseFloat(stats.average_order_value) || 0,
        today_orders: parseInt(stats.today_orders) || 0,
        today_revenue: parseFloat(stats.today_revenue) || 0
      }
    })
  } catch (error) {
    console.error('Error fetching order stats:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/orders/next-number - Get next order number
router.get('/next-number', async (req, res) => {
  try {
    const nextNumber = await generateOrderNumber()
    res.json({
      success: true,
      data: { next_order_number: nextNumber }
    })
  } catch (error) {
    console.error('Error generating order number:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

module.exports = router