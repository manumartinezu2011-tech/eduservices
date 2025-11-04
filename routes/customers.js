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

// GET /api/customers - Get all customers with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const { search, type, sort_by = 'name', sort_order = 'ASC', page = 1, limit = 50 } = req.query

    let query = `
      SELECT 
        c.*,
        COALESCE(COUNT(DISTINCT o.id), 0) as total_orders,
        COALESCE(SUM(o.total), 0) as total_spent,
        MAX(o.created_at) as last_order_date
      FROM customers c
      LEFT JOIN orders o ON c.id = o.customer_id
      WHERE 1=1 -- deleted_at check temporarily disabled
    `

    const queryParams = []
    let paramIndex = 1

    if (search) {
      query += ` AND (c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex})`
      queryParams.push(`%${search}%`)
      paramIndex++
    }

    if (type) {
      query += ` AND c.type = $${paramIndex}`
      queryParams.push(type)
      paramIndex++
    }

    query += ` GROUP BY c.id`

    // Sorting
    const allowedSortFields = ['name', 'created_at', 'balance', 'total_spent', 'total_orders']
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'name'
    const sortDirection = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'ASC'

    if (sortField === 'balance') {
      query += ` ORDER BY c.balance ${sortDirection}`
    } else if (sortField === 'total_spent' || sortField === 'total_orders') {
      query += ` ORDER BY ${sortField} ${sortDirection}`
    } else {
      query += ` ORDER BY c.${sortField} ${sortDirection}`
    }

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
    queryParams.push(limit, (page - 1) * limit)

    const result = await pool.query(query, queryParams)

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(DISTINCT c.id) as total
      FROM customers c
      WHERE 1=1 -- deleted_at check temporarily disabled
    `

    let countParams = []
    let countParamIndex = 1

    if (search) {
      countQuery += ` AND (c.name ILIKE $${countParamIndex} OR c.email ILIKE $${countParamIndex} OR c.phone ILIKE $${countParamIndex})`
      countParams.push(`%${search}%`)
      countParamIndex++
    }

    if (type) {
      countQuery += ` AND c.type = $${countParamIndex}`
      countParams.push(type)
      countParamIndex++
    }

    const countResult = await pool.query(countQuery, countParams)
    const total = parseInt(countResult.rows[0].total)

    // Format the results
    const customers = result.rows.map(customer => ({
      ...customer,
      total_orders: parseInt(customer.total_orders) || 0,
      total_spent: parseFloat(customer.total_spent) || 0,
      balance: parseFloat(customer.balance) || 0,
      credit_limit: parseFloat(customer.credit_limit) || 0
    }))

    res.json({
      success: true,
      data: customers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Error fetching customers:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/customers/:id - Get specific customer
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const query = `
      SELECT 
        c.*,
        COALESCE(COUNT(DISTINCT o.id), 0) as total_orders,
        COALESCE(SUM(o.total), 0) as total_spent,
        MAX(o.created_at) as last_order_date,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', o.id,
            'total', o.total,
            'status', o.status,
            'created_at', o.created_at
          )
          ORDER BY o.created_at DESC
        ) FILTER (WHERE o.id IS NOT NULL) as recent_orders
      FROM customers c
      LEFT JOIN orders o ON c.id = o.customer_id
      WHERE c.id = $1 -- AND c.deleted_at IS NULL -- temporarily disabled
      GROUP BY c.id
    `

    const result = await pool.query(query, [id])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      })
    }

    const customer = {
      ...result.rows[0],
      total_orders: parseInt(result.rows[0].total_orders) || 0,
      total_spent: parseFloat(result.rows[0].total_spent) || 0,
      balance: parseFloat(result.rows[0].balance) || 0,
      credit_limit: parseFloat(result.rows[0].credit_limit) || 0,
      recent_orders: result.rows[0].recent_orders || []
    }

    res.json({
      success: true,
      data: customer
    })
  } catch (error) {
    console.error('Error fetching customer:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/customers - Create new customer
router.post('/', [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').optional({ nullable: true, checkFalsy: true }).isString(),
  body('phone').optional({ nullable: true, checkFalsy: true }).isString().isLength({ min: 6, max: 20 }),
  body('address').optional().isString(),
  body('type').isIn(['individual', 'business']).withMessage('Type must be individual or business'),
  body('credit_limit').optional().isNumeric(),
  body('status').isIn(['active', 'desactive']).withMessage('Status must be active or desactive')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      errors: errors.array()
    })
  }

  try {
    const {
      name,
      email,
      phone,
      address,
      tax_id = '',
      type = 'individual',
      credit_limit = 0,
      status
    } = req.body

    // Check if email already exists
    const existingCustomer = await pool.query(
      'SELECT id FROM customers WHERE email = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [email]
    );

    if (existingCustomer.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Customer with this email already exists'
      })
    }

    const query = `
      INSERT INTO customers 
      (name, email, phone, address, city, country, tax_id, type, credit_limit, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `

    const result = await pool.query(query, [
      name, email, phone, address, '', '', tax_id, type, credit_limit, status
    ])

    res.status(201).json({
      success: true,
      data: {
        ...result.rows[0],
        balance: parseFloat(result.rows[0].balance) || 0,
        credit_limit: parseFloat(result.rows[0].credit_limit) || 0
      },
      message: 'Customer created successfully'
    })
  } catch (error) {
    console.error('Error creating customer:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// PUT /api/customers/:id - Update customer
router.put('/:id', [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').optional({ nullable: true, checkFalsy: true }).isString(),
  body('phone').optional({ nullable: true, checkFalsy: true }).isString().isLength({ min: 6, max: 20 }),
  body('address').optional().isString(),
  body('type').isIn(['individual', 'business']).withMessage('Type must be individual or business'),
  body('credit_limit').optional().isNumeric(),
  body('status').isIn(['active', 'desactive']).withMessage('Status must be active or desactive')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      errors: errors.array()
    })
  }

  try {
    const { id } = req.params
    const {
      name,
      email,
      phone,
      address,
      type,
      credit_limit,
      status
    } = req.body

    // Check if customer exists
    const existingCustomer = await pool.query(
      'SELECT * FROM customers WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [id]
    )

    if (existingCustomer.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      })
    }

    // Check if email is already used by another customer
    const emailCheck = await pool.query(
      'SELECT id FROM customers WHERE email = $1 AND id != $2 -- AND deleted_at IS NULL -- temporarily disabled',
      [email, id]
    )

    if (emailCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Customer with this email already exists'
      })
    }

    const query = `
      UPDATE customers 
      SET name = $2, email = $3, phone = $4, address = $5, type = $6, 
          credit_limit = $7, status = $8, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled
      RETURNING *
    `

    const result = await pool.query(query, [
      id, name, email, phone, address, type, credit_limit, status
    ])

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        balance: parseFloat(result.rows[0].balance) || 0,
        credit_limit: parseFloat(result.rows[0].credit_limit) || 0
      },
      message: 'Customer updated successfully'
    })
  } catch (error) {
    console.error('Error updating customer:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// PATCH /api/customers/:id/balance - Update customer balance
router.patch('/:id/balance', [
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('operation').isIn(['add', 'subtract', 'set']).withMessage('Operation must be add, subtract, or set'),
  body('description').optional().isString()
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      errors: errors.array()
    })
  }

  try {
    const { id } = req.params
    const { amount, operation, description } = req.body

    const customer = await pool.query(
      'SELECT * FROM customers WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [id]
    )

    if (customer.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      })
    }

    let newBalance
    const currentBalance = parseFloat(customer.rows[0].balance) || 0

    switch (operation) {
      case 'add':
        newBalance = currentBalance + parseFloat(amount)
        break
      case 'subtract':
        newBalance = currentBalance - parseFloat(amount)
        break
      case 'set':
        newBalance = parseFloat(amount)
        break
    }

    const query = `
      UPDATE customers 
      SET balance = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `

    const result = await pool.query(query, [id, newBalance])

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        balance: parseFloat(result.rows[0].balance) || 0,
        credit_limit: parseFloat(result.rows[0].credit_limit) || 0
      },
      message: 'Customer balance updated successfully'
    })
  } catch (error) {
    console.error('Error updating customer balance:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// DELETE /api/customers/:id - Soft delete customer
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Check if customer exists
    const customer = await pool.query(
      'SELECT * FROM customers WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [id]
    )

    if (customer.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      })
    }

    // Check if customer has pending orders or outstanding balance
    const hasActiveData = await pool.query(`
      SELECT 
        COUNT(o.id) as pending_orders,
        c.balance
      FROM customers c
      LEFT JOIN orders o ON c.id = o.customer_id AND o.status IN ('pending', 'processing')
      WHERE c.id = $1
      GROUP BY c.balance
    `, [id])

    if (hasActiveData.rows.length > 0) {
      const { pending_orders, balance } = hasActiveData.rows[0]
      if (parseInt(pending_orders) > 0) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete customer with pending orders'
        })
      }
      if (parseFloat(balance) !== 0) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete customer with outstanding balance'
        })
      }
    }

    // Soft delete
    await pool.query(
      'UPDATE customers SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    )

    res.json({
      success: true,
      message: 'Customer deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting customer:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/customers/stats - Get customer statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE type = 'individual' -- AND deleted_at IS NULL -- temporarily disabled) as individual_customers,
        COUNT(*) FILTER (WHERE type = 'business' -- AND deleted_at IS NULL -- temporarily disabled) as business_customers,
        COUNT(*) FILTER (WHERE 1=1 -- deleted_at check temporarily disabled) as total_customers,
        COALESCE(AVG(balance), 0) as average_balance,
        COALESCE(SUM(balance), 0) as total_balance,
        COUNT(*) FILTER (WHERE balance > 0 -- AND deleted_at IS NULL -- temporarily disabled) as customers_with_credit,
        COUNT(*) FILTER (WHERE balance < 0 -- -- AND deleted_at IS NULL temporarily disabled -- temporarily disabled) as customers_with_debt
      FROM customers
    `

    const result = await pool.query(query)
    const stats = result.rows[0]

    res.json({
      success: true,
      data: {
        individual_customers: parseInt(stats.individual_customers) || 0,
        business_customers: parseInt(stats.business_customers) || 0,
        total_customers: parseInt(stats.total_customers) || 0,
        average_balance: parseFloat(stats.average_balance) || 0,
        total_balance: parseFloat(stats.total_balance) || 0,
        customers_with_credit: parseInt(stats.customers_with_credit) || 0,
        customers_with_debt: parseInt(stats.customers_with_debt) || 0
      }
    })
  } catch (error) {
    console.error('Error fetching customer stats:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

module.exports = router