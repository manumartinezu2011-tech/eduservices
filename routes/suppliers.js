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
    const suppliers = result.rows.map(supplier => ({
      ...supplier,
      products_count: 0,
      payment_terms: parseInt(supplier.payment_terms) || 30
    }))
    
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

module.exports = router