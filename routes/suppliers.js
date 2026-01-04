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

// POST /api/suppliers/setup-db - Create supplier_payments table
router.post('/setup-db', async (req, res) => {
  const client = await pool.connect()
  try {
    console.log('Setting up supplier_payments table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
        amount DECIMAL(10, 2) NOT NULL,
        payment_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        payment_method VARCHAR(50),
        reference_number VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `)
    console.log('supplier_payments table created successfully')
    res.json({ success: true, message: 'Database setup completed' })
  } catch (error) {
    console.error('Error setting up database:', error)
    res.status(500).json({ success: false, error: error.message })
  } finally {
    client.release()
  }
})

// GET /api/suppliers/:id/account - Get supplier account details
router.get('/:id/account', async (req, res) => {
  try {
    const { id } = req.params
    const { start_date, end_date } = req.query

    // 1. Get Supplier Details
    const supplierResult = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id])
    if (supplierResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Supplier not found' })
    }
    const supplier = supplierResult.rows[0]

    // 2. Get Purchase Orders (Debits - Deuda)
    let poQuery = `
      SELECT 
        id, order_number, total_amount as amount, status, created_at as date, 'purchase_order' as type
      FROM purchase_orders
      WHERE supplier_id = $1 AND deleted_at IS NULL
    `
    const poParams = [id]
    if (start_date) {
      poQuery += ` AND created_at >= $2`
      poParams.push(start_date)
    }
    const poResult = await pool.query(poQuery, poParams)

    // 3. Get Payments (Credits - Pagos)
    let payQuery = `
      SELECT 
        id, amount, payment_date as date, 'payment' as type, payment_method, reference_number
      FROM supplier_payments
      WHERE supplier_id = $1
    `
    const payParams = [id]
    if (start_date) {
      payQuery += ` AND payment_date >= $2`
      payParams.push(start_date)
    }
    const payResult = await pool.query(payQuery, payParams)

    // 4. Get Total Products Purchased
    const productCountQuery = `
      SELECT COALESCE(SUM(poi.quantity), 0) as total_quantity
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.purchase_order_id = po.id
      WHERE po.supplier_id = $1 AND po.deleted_at IS NULL
    `
    const productCountResult = await pool.query(productCountQuery, [id])
    const totalProducts = parseInt(productCountResult.rows[0].total_quantity)

    // 5. Combine and Sort
    const transactions = [
      ...poResult.rows.map(po => ({ ...po, is_debit: true })), // Increases debt
      ...payResult.rows.map(p => ({ ...p, is_credit: true }))  // Decreases debt
    ].sort((a, b) => new Date(b.date) - new Date(a.date))

    // 6. Calculate Balance & Last Purchase
    const totalPurchased = poResult.rows.reduce((sum, item) => sum + parseFloat(item.amount), 0)
    const totalPaid = payResult.rows.reduce((sum, item) => sum + parseFloat(item.amount), 0)
    const balance = totalPurchased - totalPaid

    // Get last purchase date from sorted transactions (looking for first purchase_order)
    const lastPurchase = transactions.find(t => t.type === 'purchase_order')
    const lastPurchaseDate = lastPurchase ? lastPurchase.date : null

    res.json({
      success: true,
      data: {
        supplier: {
          ...supplier,
          balance,
          total_purchased: totalPurchased,
          total_paid: totalPaid,
          products_count: totalProducts,
          last_purchase_date: lastPurchaseDate
        },
        transactions
      }
    })
  } catch (error) {
    console.error('Error fetching supplier account:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/suppliers - Get all suppliers with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const {
      search,
      status = 'active',
      sort_by = 'name',
      sort_order = 'ASC',
      page = 1,
      limit = 50
    } = req.query

    let query = `
      SELECT 
        s.*,
        (SELECT COALESCE(SUM(total_amount), 0) FROM purchase_orders WHERE supplier_id = s.id AND deleted_at IS NULL) as total_purchased,
        (SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_id = s.id) as total_paid,
        (SELECT MAX(created_at) FROM purchase_orders WHERE supplier_id = s.id AND deleted_at IS NULL) as last_purchase_date,
        0 as products_count
      FROM suppliers s
      WHERE 1=1
    `

    const queryParams = []
    let paramIndex = 1

    if (search) {
      query += ` AND (s.name ILIKE $${paramIndex} OR s.email ILIKE $${paramIndex} OR s.contact_person ILIKE $${paramIndex})`
      queryParams.push(`%${search}%`)
      paramIndex++
    }

    if (status) {
      query += ` AND s.status = $${paramIndex}`
      queryParams.push(status)
      paramIndex++
    }

    // Sorting
    const allowedSortFields = ['name', 'created_at', 'status']
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'name'
    const sortDirection = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'ASC'

    query += ` ORDER BY s.${sortField} ${sortDirection}`
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
    queryParams.push(limit, (page - 1) * limit)

    const result = await pool.query(query, queryParams)

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM suppliers s WHERE 1=1`
    let countParams = []
    let countParamIndex = 1

    if (search) {
      countQuery += ` AND (s.name ILIKE $${countParamIndex} OR s.email ILIKE $${countParamIndex} OR s.contact_person ILIKE $${countParamIndex})`
      countParams.push(`%${search}%`)
      countParamIndex++
    }

    if (status) {
      countQuery += ` AND s.status = $${countParamIndex}`
      countParams.push(status)
      countParamIndex++
    }

    const countResult = await pool.query(countQuery, countParams)
    const total = parseInt(countResult.rows[0].total)

    // Format the results
    const suppliers = result.rows.map(supplier => {
      const totalPurchased = parseFloat(supplier.total_purchased) || 0
      const totalPaid = parseFloat(supplier.total_paid) || 0

      return {
        ...supplier,
        products_count: 0,
        payment_terms: parseInt(supplier.payment_terms) || 30,
        total_purchased: totalPurchased,
        total_paid: totalPaid,
        balance: totalPurchased - totalPaid
      }
    })

    res.json({
      success: true,
      data: suppliers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Error fetching suppliers:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/suppliers/:id - Get specific supplier
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const query = `
      SELECT 
        s.*,
        0 as products_count
      FROM suppliers s
      WHERE s.id = $1
    `

    const result = await pool.query(query, [id])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      })
    }

    const supplier = {
      ...result.rows[0],
      products_count: 0,
      payment_terms: parseInt(result.rows[0].payment_terms) || 30,
      products: []
    }

    res.json({
      success: true,
      data: supplier
    })
  } catch (error) {
    console.error('Error fetching supplier:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/suppliers - Create new supplier
router.post('/', [
  body('name').notEmpty().withMessage('Supplier name is required'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('payment_terms').optional().isInt({ min: 1 }).withMessage('Payment terms must be a positive integer')
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
      contact_person,
      tax_id,
      status = 'active',
      payment_terms = 30
    } = req.body

    const query = `
      INSERT INTO suppliers 
      (name, email, phone, address, contact_person, tax_id, status, payment_terms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `

    const result = await pool.query(query, [
      name, email, phone, address, contact_person, tax_id, status, payment_terms
    ])

    res.status(201).json({
      success: true,
      data: {
        ...result.rows[0],
        payment_terms: parseInt(result.rows[0].payment_terms) || 30
      },
      message: 'Supplier created successfully'
    })
  } catch (error) {
    console.error('Error creating supplier:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// PUT /api/suppliers/:id - Update supplier
router.put('/:id', [
  body('name').notEmpty().withMessage('Supplier name is required'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('payment_terms').optional().isInt({ min: 1 }).withMessage('Payment terms must be a positive integer')
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
      contact_person,
      tax_id,
      status,
      payment_terms
    } = req.body

    // Check if supplier exists
    const existingSupplier = await pool.query(
      'SELECT * FROM suppliers WHERE id = $1',
      [id]
    )

    if (existingSupplier.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      })
    }

    const query = `
      UPDATE suppliers 
      SET name = $2, email = $3, phone = $4, address = $5, contact_person = $6, 
          tax_id = $7, status = $8, payment_terms = $9, 
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `

    const result = await pool.query(query, [
      id, name, email, phone, address, contact_person, tax_id, status, payment_terms
    ])

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        payment_terms: parseInt(result.rows[0].payment_terms) || 30
      },
      message: 'Supplier updated successfully'
    })
  } catch (error) {
    console.error('Error updating supplier:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// DELETE /api/suppliers/:id - Soft delete supplier
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Check if supplier exists
    const supplier = await pool.query(
      'SELECT * FROM suppliers WHERE id = $1',
      [id]
    )

    if (supplier.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Supplier not found'
      })
    }

    // Delete supplier
    await pool.query(
      'DELETE FROM suppliers WHERE id = $1',
      [id]
    )

    res.json({
      success: true,
      message: 'Supplier deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting supplier:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/suppliers/stats - Get supplier statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active_suppliers,
        COUNT(*) FILTER (WHERE status = 'inactive') as inactive_suppliers,
        COUNT(*) as total_suppliers,
        COALESCE(AVG(payment_terms), 30) as average_payment_terms
      FROM suppliers
    `

    const result = await pool.query(query)
    const stats = result.rows[0]

    res.json({
      success: true,
      data: {
        active_suppliers: parseInt(stats.active_suppliers) || 0,
        inactive_suppliers: parseInt(stats.inactive_suppliers) || 0,
        total_suppliers: parseInt(stats.total_suppliers) || 0,
        average_payment_terms: parseFloat(stats.average_payment_terms) || 30
      }
    })
  } catch (error) {
    console.error('Error fetching supplier stats:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/suppliers/stats/sales - Get sales statistics by supplier
router.get('/stats/sales', async (req, res) => {
  try {
    const { start_date, end_date } = req.query

    let query = `
      SELECT 
        s.id,
        s.name,
        COUNT(DISTINCT o.id) as orders_count,
        COUNT(oi.id) as items_sold,
        COALESCE(SUM(oi.total), 0) as total_sales,
        COALESCE(SUM(oi.quantity), 0) as total_quantity
      FROM suppliers s
      JOIN order_items oi ON s.id = oi.supplier_id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status != 'cancelled'
    `

    const params = []
    let paramIndex = 1

    if (start_date) {
      query += ` AND o.created_at >= $${paramIndex}`
      params.push(start_date)
      paramIndex++
    }

    if (end_date) {
      query += ` AND o.created_at <= $${paramIndex}`
      params.push(end_date + ' 23:59:59')
      paramIndex++
    }

    query += ` GROUP BY s.id, s.name ORDER BY total_sales DESC`

    const result = await pool.query(query, params)

    res.json({
      success: true,
      data: result.rows.map(row => ({
        ...row,
        total_sales: parseFloat(row.total_sales),
        total_quantity: parseFloat(row.total_quantity),
        orders_count: parseInt(row.orders_count),
        items_sold: parseInt(row.items_sold)
      }))
    })
  } catch (error) {
    console.error('Error fetching supplier sales stats:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

module.exports = router