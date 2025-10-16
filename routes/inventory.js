const express = require('express')
const router = express.Router()
const { Pool } = require('pg')
const { body, validationResult } = require('express-validator')

// Use the pool from server.js
const pool = require('../server').pool

// Helper function to check if deleted_at column exists
async function hasDeletedAtColumn(tableName) {
  try {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = $1 AND column_name = 'deleted_at'`,
      [tableName]
    )
    return result.rows.length > 0
  } catch (error) {
    console.warn(`Could not check for deleted_at column in ${tableName}:`, error.message)
    return false
  }
}

// GET /api/inventory/products - Get all products with filtering and pagination
router.get('/products', async (req, res) => {
  try {
    const {
      search,
      category_id,
      status = 'active',
      low_stock = false,
      sort_by = 'name',
      sort_order = 'ASC',
      page = 1,
      limit = 50
    } = req.query

    let query = `
      SELECT 
        p.id,
        p.name,
        p.description,
        p.category_id,
        p.sku,
        p.price,
        p.cost,
        p.stock,
        p.min_stock,
        p.unit,
        p.supplier as supplier,
        NULL as expiry_date,
        NULL as image_url,
        p.status,
        p.created_at,
        p.updated_at,
        c.name as category_name,
        c.color as category_color,
        CASE 
          WHEN p.stock <= p.min_stock THEN true 
          ELSE false 
        END as is_low_stock,
        (p.stock * p.price) as total_value
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    
    // Note: deleted_at filtering temporarily disabled until migration is run
    
    const queryParams = []
    let paramIndex = 1

    if (search) {
      query += ` AND (p.name ILIKE $${paramIndex} OR p.sku ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`
      queryParams.push(`%${search}%`)
      paramIndex++
    }

    if (category_id) {
      query += ` AND p.category_id = $${paramIndex}`
      queryParams.push(category_id)
      paramIndex++
    }

    if (status) {
      query += ` AND p.status = $${paramIndex}`
      queryParams.push(status)
      paramIndex++
    }

    if (low_stock === 'true') {
      query += ` AND p.stock <= p.min_stock`
    }

    // Sorting
    const allowedSortFields = ['name', 'sku', 'price', 'stock', 'created_at', 'category_name']
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'name'
    const sortDirection = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'ASC'

    if (sortField === 'category_name') {
      query += ` ORDER BY c.name ${sortDirection}, p.name ASC`
    } else if (sortField === 'created_at') {
      query += ` ORDER BY p.created_at ${sortDirection}`
    } else {
      query += ` ORDER BY p.${sortField} ${sortDirection}`
    }

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
    queryParams.push(limit, (page - 1) * limit)

    const result = await pool.query(query, queryParams)

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1 -- deleted_at check temporarily disabled
    `

    let countParams = []
    let countParamIndex = 1

    if (search) {
      countQuery += ` AND (p.name ILIKE $${countParamIndex} OR p.sku ILIKE $${countParamIndex} OR p.description ILIKE $${countParamIndex})`
      countParams.push(`%${search}%`)
      countParamIndex++
    }

    if (category_id) {
      countQuery += ` AND p.category_id = $${countParamIndex}`
      countParams.push(category_id)
      countParamIndex++
    }

    if (status) {
      countQuery += ` AND p.status = $${countParamIndex}`
      countParams.push(status)
      countParamIndex++
    }

    if (low_stock === 'true') {
      countQuery += ` AND p.stock <= p.min_stock`
    }

    const countResult = await pool.query(countQuery, countParams)
    const total = parseInt(countResult.rows[0].total)

    // Format the results
    const products = result.rows.map(product => ({
      ...product,
      stock: parseFloat(product.stock) || 0,
      min_stock: parseFloat(product.min_stock) || 0,
      max_stock: parseFloat(product.max_stock) || 0,
      price: parseFloat(product.price) || 0,
      cost: parseFloat(product.cost) || 0,
      total_value: parseFloat(product.total_value) || 0,
      is_low_stock: product.is_low_stock === true
    }))

    res.json({
      success: true,
      data: products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Error fetching products:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/inventory/products/:id - Get specific product
router.get('/products/:id', async (req, res) => {
  try {
    const { id } = req.params

    const query = `
      SELECT 
        p.id,
        p.name,
        p.description,
        p.category_id,
        p.sku,
        p.price,
        p.cost,
        p.stock,
        p.min_stock,
        p.unit,
        'Sin proveedor' as supplier,
        NULL as expiry_date,
        NULL as image_url,
        p.status,
        p.created_at,
        p.updated_at,
        c.name as category_name,
        c.color as category_color,
        CASE 
          WHEN p.stock <= p.min_stock THEN true 
          ELSE false 
        END as is_low_stock,
        (p.stock * p.price) as total_value,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', sm.id,
            'type', sm.movement_type,
            'quantity', sm.quantity,
            'reference_type', sm.reference_type,
            'reference_id', sm.reference_id,
            'created_at', sm.created_at,
            'notes', sm.notes
          )
          ORDER BY sm.created_at DESC
        ) FILTER (WHERE sm.id IS NOT NULL) as recent_movements
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN stock_movements sm ON p.id = sm.product_id
      WHERE p.id = $1 -- AND p.deleted_at IS NULL -- temporarily disabled
      GROUP BY p.id, p.name, p.description, p.category_id, p.sku, p.price, p.cost, p.stock, p.min_stock, p.unit, p.status, p.created_at, p.updated_at, c.name, c.color
    `

    const result = await pool.query(query, [id])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      })
    }

    const product = {
      ...result.rows[0],
      stock: parseFloat(result.rows[0].stock) || 0,
      min_stock: parseFloat(result.rows[0].min_stock) || 0,
      max_stock: parseFloat(result.rows[0].max_stock) || 0,
      price: parseFloat(result.rows[0].price) || 0,
      cost: parseFloat(result.rows[0].cost) || 0,
      total_value: parseFloat(result.rows[0].total_value) || 0,
      is_low_stock: result.rows[0].is_low_stock === true,
      recent_movements: result.rows[0].recent_movements || []
    }

    res.json({
      success: true,
      data: product
    })
  } catch (error) {
    console.error('Error fetching product:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/inventory/products - Create new product
router.post('/products', [
  body('name').notEmpty().withMessage('Product name is required'),
  body('sku').optional().isString(),
  body('price').isNumeric().withMessage('Price must be a number'),
  body('cost').optional().isNumeric().withMessage('Cost must be a number'),
  body('stock').optional().isNumeric().withMessage('Stock must be a number'),
  body('min_stock').optional().isNumeric().withMessage('Min stock must be a number'),
  body('category_id').optional().isUUID().withMessage('Category ID must be a valid UUID'),
  body('unit').optional().isString()
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
      sku,
      category_id,
      description,
      price,
      cost = 0,
      stock = 0,
      min_stock = 0,
      max_stock,
      unit = 'kg',
      supplier,
      barcode,
      expiry_date,
      image_url,
      status = 'active'
    } = req.body

    // Check if SKU already exists
    if (sku) {
      const existingProduct = await pool.query(
        'SELECT id FROM products WHERE sku = $1 -- AND deleted_at IS NULL -- temporarily disabled',
        [sku]
      )

      if (existingProduct.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Product with this SKU already exists'
        })
      }
    }

    const query = `
      INSERT INTO products 
      (name, description, category_id, sku, price, cost, stock, min_stock, unit, supplier, expiry_date, image_url, status) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `

    const result = await pool.query(query, [
      name, description, category_id, sku, price, cost, stock, min_stock,
      unit, supplier, expiry_date, image_url, status
    ])

    // Create initial stock movement if stock > 0
    if (parseFloat(stock) > 0) {
      await pool.query(`
        INSERT INTO stock_movements (product_id, movement_type, quantity, notes)
        VALUES ($1, 'adjustment', $2, 'Initial stock')
      `, [result.rows[0].id, stock])
    }

    res.status(201).json({
      success: true,
      data: {
        ...result.rows[0],
        stock: parseFloat(result.rows[0].stock) || 0,
        min_stock: parseFloat(result.rows[0].min_stock) || 0,
        max_stock: parseFloat(result.rows[0].max_stock) || 0,
        price: parseFloat(result.rows[0].price) || 0,
        cost: parseFloat(result.rows[0].cost) || 0
      },
      message: 'Product created successfully'
    })
  } catch (error) {
    console.error('Error creating product:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// PUT /api/inventory/products/:id - Update product
router.put('/products/:id', [
  body('name').notEmpty().withMessage('Product name is required'),
  body('price').isNumeric().withMessage('Price must be a number'),
  body('cost').optional().isNumeric().withMessage('Cost must be a number')
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
      sku,
      category_id,
      description,
      price,
      cost,
      min_stock,
      max_stock,
      unit,
      supplier,
      barcode,
      expiry_date,
      image_url,
      status
    } = req.body

    // Check if product exists
    const existingProduct = await pool.query(
      'SELECT * FROM products WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [id]
    )

    if (existingProduct.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      })
    }

    // Check if SKU is already used by another product
    if (sku) {
      const skuCheck = await pool.query(
        'SELECT id FROM products WHERE sku = $1 AND id != $2 -- AND deleted_at IS NULL -- temporarily disabled',
        [sku, id]
      )

      if (skuCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Product with this SKU already exists'
        })
      }
    }

    // Build dynamic update query to only update provided fields
    const updateFields = []
    const queryParams = [id]
    let paramIndex = 2

    if (name !== undefined) {
      updateFields.push(`name = $${paramIndex}`)
      queryParams.push(name)
      paramIndex++
    }

    if (sku !== undefined) {
      updateFields.push(`sku = $${paramIndex}`)
      queryParams.push(sku)
      paramIndex++
    }

    if (category_id !== undefined) {
      updateFields.push(`category_id = $${paramIndex}`)
      queryParams.push(category_id)
      paramIndex++
    }

    if (description !== undefined) {
      updateFields.push(`description = $${paramIndex}`)
      queryParams.push(description)
      paramIndex++
    }

    if (price !== undefined) {
      updateFields.push(`price = $${paramIndex}`)
      queryParams.push(price)
      paramIndex++
    }

    if (cost !== undefined) {
      updateFields.push(`cost = $${paramIndex}`)
      queryParams.push(cost)
      paramIndex++
    }

    if (min_stock !== undefined) {
      updateFields.push(`min_stock = $${paramIndex}`)
      queryParams.push(min_stock)
      paramIndex++
    }

    if (unit !== undefined) {
      updateFields.push(`unit = $${paramIndex}`)
      queryParams.push(unit)
      paramIndex++
    }

    if (supplier !== undefined) {
      updateFields.push(`supplier = $${paramIndex}`)
      queryParams.push(supplier)
      paramIndex++
    }

    if (expiry_date !== undefined) {
      updateFields.push(`expiry_date = $${paramIndex}`)
      queryParams.push(expiry_date)
      paramIndex++
    }

    if (image_url !== undefined) {
      updateFields.push(`image_url = $${paramIndex}`)
      queryParams.push(image_url)
      paramIndex++
    }

    if (status !== undefined) {
      updateFields.push(`status = $${paramIndex}`)
      queryParams.push(status)
      paramIndex++
    }

    // Always update the updated_at timestamp
    updateFields.push('updated_at = CURRENT_TIMESTAMP')

    if (updateFields.length === 1) { // Only updated_at field
      return res.status(400).json({
        success: false,
        error: 'No fields to update'
      })
    }

    const query = `
      UPDATE products 
      SET ${updateFields.join(', ')}
      WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled
      RETURNING *
    `

    const result = await pool.query(query, queryParams)

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        stock: parseFloat(result.rows[0].stock) || 0,
        min_stock: parseFloat(result.rows[0].min_stock) || 0,
        max_stock: parseFloat(result.rows[0].max_stock) || 0,
        price: parseFloat(result.rows[0].price) || 0,
        cost: parseFloat(result.rows[0].cost) || 0
      },
      message: 'Product updated successfully'
    })
  } catch (error) {
    console.error('Error updating product:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// PATCH /api/inventory/products/:id/stock - Adjust product stock
router.patch('/products/:id/stock', [
  body('quantity').isNumeric().withMessage('Quantity must be a number'),
  body('type').isIn(['adjustment', 'sale', 'purchase', 'return', 'loss']).withMessage('Invalid movement type'),
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
    const { quantity, type, notes, reference_id, reference_type } = req.body

    // Get current product stock
    const productResult = await client.query(
      'SELECT * FROM products WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [id]
    )

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      })
    }

    const product = productResult.rows[0]
    const currentStock = parseFloat(product.stock) || 0
    const adjustment = parseFloat(quantity)

    let newStock
    switch (type) {
      case 'adjustment':
      case 'purchase':
      case 'return':
        newStock = currentStock + adjustment
        break
      case 'sale':
      case 'loss':
        newStock = currentStock - Math.abs(adjustment)
        break
      default:
        newStock = currentStock + adjustment
    }

    // Prevent negative stock
    if (newStock < 0) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient stock available'
      })
    }

    // Update product stock
    await client.query(
      'UPDATE products SET stock = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id, newStock]
    )

    // Create stock movement record
    await client.query(`
      INSERT INTO stock_movements 
      (product_id, movement_type, quantity, reference_type, reference_id, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, type, adjustment, reference_type, reference_id, notes])

    await client.query('COMMIT')

    // Get updated product
    const updatedProduct = await pool.query(`
      SELECT 
        p.*,
        c.name as category_name,
        CASE 
          WHEN p.stock <= p.min_stock THEN true 
          ELSE false 
        END as is_low_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `, [id])

    res.json({
      success: true,
      data: {
        ...updatedProduct.rows[0],
        stock: parseFloat(updatedProduct.rows[0].stock) || 0,
        min_stock: parseFloat(updatedProduct.rows[0].min_stock) || 0,
        max_stock: parseFloat(updatedProduct.rows[0].max_stock) || 0,
        price: parseFloat(updatedProduct.rows[0].price) || 0,
        cost: parseFloat(updatedProduct.rows[0].cost) || 0,
        is_low_stock: updatedProduct.rows[0].is_low_stock === true
      },
      message: 'Stock updated successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating stock:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  } finally {
    client.release()
  }
})

// DELETE /api/inventory/products/:id - Soft delete product
router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Check if product exists
    const product = await pool.query(
      'SELECT * FROM products WHERE id = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [id]
    )

    if (product.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      })
    }

    // Check if product is used in pending orders
    const hasActiveOrders = await pool.query(`
      SELECT COUNT(oi.id) as active_orders
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE oi.product_id = $1 AND o.status IN ('pending', 'processing')
    `, [id])

    if (parseInt(hasActiveOrders.rows[0].active_orders) > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete product with pending orders'
      })
    }

    // Soft delete
    await pool.query(
      'UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    )

    res.json({
      success: true,
      message: 'Product deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting product:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// ===== CATEGORIES ENDPOINTS =====

// GET /api/inventory/categories - Get all categories
router.get('/categories', async (req, res) => {
  try {
    const query = `
      SELECT 
        c.*,
        COUNT(p.id) as products_count
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id -- AND p.deleted_at IS NULL -- temporarily disabled
      WHERE 1=1 -- deleted_at check temporarily disabled
      GROUP BY c.id
      ORDER BY c.name ASC
    `

    const result = await pool.query(query)

    const categories = result.rows.map(category => ({
      ...category,
      products_count: parseInt(category.products_count) || 0
    }))

    res.json({
      success: true,
      data: categories
    })
  } catch (error) {
    console.error('Error fetching categories:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/inventory/categories - Create new category
router.post('/categories', [
  body('name').notEmpty().withMessage('Category name is required'),
  body('slug').notEmpty().withMessage('Category slug is required'),
  body('color').optional().isString()
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
    const { name, slug, description, color = '#10B981', parent_id } = req.body

    // Check if slug already exists
    const existingCategory = await pool.query(
      'SELECT id FROM categories WHERE slug = $1 -- AND deleted_at IS NULL -- temporarily disabled',
      [slug]
    )

    if (existingCategory.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Category with this slug already exists'
      })
    }

    const query = `
      INSERT INTO categories (name, slug, description, color, parent_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `

    const result = await pool.query(query, [name, slug, description, color, parent_id])

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Category created successfully'
    })
  } catch (error) {
    console.error('Error creating category:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/inventory/stats - Get inventory statistics
router.get('/stats', async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) as total_products,
        COUNT(*) FILTER (WHERE status = 'active') as active_products,
        COUNT(*) FILTER (WHERE stock <= min_stock) as low_stock_products,
        COUNT(*) FILTER (WHERE stock = 0) as out_of_stock_products,
        COALESCE(SUM(stock * price), 0) as total_inventory_value,
        COALESCE(SUM(stock * cost), 0) as total_inventory_cost,
        COALESCE(AVG(stock), 0) as average_stock_level
      FROM products
      WHERE 1=1 -- deleted_at check temporarily disabled
    `

    const result = await pool.query(query)
    const stats = result.rows[0]

    // Get category distribution
    const categoryQuery = `
      SELECT 
        c.name,
        c.color,
        COUNT(p.id) as products_count,
        COALESCE(SUM(p.stock * p.price), 0) as category_value
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id -- AND p.deleted_at IS NULL -- temporarily disabled
      WHERE 1=1 -- deleted_at check temporarily disabled
      GROUP BY c.id, c.name, c.color
      ORDER BY category_value DESC
    `

    const categoryResult = await pool.query(categoryQuery)

    res.json({
      success: true,
      data: {
        total_products: parseInt(stats.total_products) || 0,
        active_products: parseInt(stats.active_products) || 0,
        low_stock_products: parseInt(stats.low_stock_products) || 0,
        out_of_stock_products: parseInt(stats.out_of_stock_products) || 0,
        total_inventory_value: parseFloat(stats.total_inventory_value) || 0,
        total_inventory_cost: parseFloat(stats.total_inventory_cost) || 0,
        average_stock_level: parseFloat(stats.average_stock_level) || 0,
        profit_margin: stats.total_inventory_cost > 0 ?
          ((parseFloat(stats.total_inventory_value) - parseFloat(stats.total_inventory_cost)) / parseFloat(stats.total_inventory_cost) * 100) : 0,
        category_distribution: categoryResult.rows.map(cat => ({
          name: cat.name,
          color: cat.color,
          products_count: parseInt(cat.products_count) || 0,
          category_value: parseFloat(cat.category_value) || 0
        }))
      }
    })
  } catch (error) {
    console.error('Error fetching inventory stats:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/inventory/low-stock - Get products with low stock
router.get('/low-stock', async (req, res) => {
  try {
    const query = `
      SELECT 
        p.*,
        c.name as category_name,
        c.color as category_color,
        (p.min_stock - p.stock) as reorder_quantity
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.stock <= p.min_stock 
        AND p.status = 'active' 
        -- -- AND p.deleted_at IS NULL temporarily disabled -- temporarily disabled
      ORDER BY (p.min_stock - p.stock) DESC, p.name ASC
    `

    const result = await pool.query(query)

    const products = result.rows.map(product => ({
      ...product,
      stock: parseFloat(product.stock) || 0,
      min_stock: parseFloat(product.min_stock) || 0,
      price: parseFloat(product.price) || 0,
      reorder_quantity: parseFloat(product.reorder_quantity) || 0
    }))

    res.json({
      success: true,
      data: products
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

module.exports = router