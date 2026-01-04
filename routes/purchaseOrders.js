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

// Helper function to generate purchase order number
async function generatePurchaseOrderNumber(trackingNumber = null) {
  const result = await pool.query(`
    SELECT order_number
    FROM purchase_orders
    WHERE order_number ~ '^PO-[0-9]+'
    ORDER BY created_at DESC
    LIMIT 1
  `)

  let sequentialNumber = 'PO-001'
  if (result.rows.length > 0) {
    const lastNumber = result.rows[0].order_number
    // Extract the sequential part (PO-XXX)
    const match = lastNumber.match(/^PO-(\d+)/)
    if (match) {
      const numberPart = parseInt(match[1])
      sequentialNumber = `PO-${String(numberPart + 1).padStart(3, '0')}`
    }
  }

  // If tracking number is provided, append it
  if (trackingNumber) {
    return `${sequentialNumber}-${trackingNumber}`
  }

  return sequentialNumber
}

// GET /api/purchase-orders - Get all purchase orders with filtering
router.get('/', async (req, res) => {
  try {
    const {
      status,
      supplier_id,
      date_from,
      date_to,
      search,
      page = 1,
      limit = 50
    } = req.query

    let query = `
      SELECT
        po.*,
        s.name as supplier_name,
        s.email as supplier_email,
        s.contact_person as supplier_contact,
        COUNT(poi.id) as items_count,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', poi.id,
              'product_id', poi.product_id,
              'product_name', p.name,
              'quantity', poi.quantity,
              'unit_cost', poi.unit_cost,
              'total_cost', poi.total_cost,
              'received_quantity', poi.received_quantity
            )
          ) FILTER (WHERE poi.id IS NOT NULL),
          '[]'::json
        ) as items
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_order_items poi ON po.id = poi.purchase_order_id
      LEFT JOIN products p ON poi.product_id = p.id
      WHERE po.deleted_at IS NULL
    `

    const queryParams = []
    let paramIndex = 1

    if (status) {
      query += ` AND po.status = $${paramIndex}`
      queryParams.push(status)
      paramIndex++
    }

    if (supplier_id) {
      query += ` AND po.supplier_id = $${paramIndex}`
      queryParams.push(supplier_id)
      paramIndex++
    }

    if (date_from) {
      query += ` AND po.order_date >= $${paramIndex}`
      queryParams.push(date_from)
      paramIndex++
    }

    if (date_to) {
      query += ` AND po.order_date <= $${paramIndex}`
      queryParams.push(date_to)
      paramIndex++
    }

    if (search) {
      query += ` AND (po.order_number ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`
      queryParams.push(`%${search}%`)
      paramIndex++
    }

    query += `
      GROUP BY po.id, s.name, s.email, s.contact_person
      ORDER BY po.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `

    queryParams.push(limit, (page - 1) * limit)

    const result = await pool.query(query, queryParams)

    // Format the results
    const purchaseOrders = result.rows.map(order => ({
      ...order,
      subtotal: parseFloat(order.subtotal) || 0,
      tax_amount: parseFloat(order.tax_amount) || 0,
      total_amount: parseFloat(order.total_amount) || 0,
      items_count: parseInt(order.items_count) || 0
    }))

    res.json({
      success: true,
      data: purchaseOrders
    })
  } catch (error) {
    console.error('Error fetching purchase orders:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/purchase-orders/:id - Get specific purchase order
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const query = `
      SELECT
        po.*,
        s.name as supplier_name,
        s.email as supplier_email,
        s.contact_person as supplier_contact,
        s.address as supplier_address,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', poi.id,
            'product_id', poi.product_id,
            'product_name', p.name,
            'quantity', poi.quantity,
            'unit_cost', poi.unit_cost,
            'total_cost', poi.total_cost,
            'received_quantity', poi.received_quantity
          )
        ) as items
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_order_items poi ON po.id = poi.purchase_order_id
      LEFT JOIN products p ON poi.product_id = p.id
      WHERE po.id = $1 AND po.deleted_at IS NULL
      GROUP BY po.id, s.name, s.email, s.contact_person, s.address
    `

    const result = await pool.query(query, [id])

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found'
      })
    }

    const purchaseOrder = {
      ...result.rows[0],
      subtotal: parseFloat(result.rows[0].subtotal) || 0,
      tax_amount: parseFloat(result.rows[0].tax_amount) || 0,
      total_amount: parseFloat(result.rows[0].total_amount) || 0
    }

    res.json({
      success: true,
      data: purchaseOrder
    })
  } catch (error) {
    console.error('Error fetching purchase order:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/purchase-orders - Create new purchase order
router.post('/', [
  body('supplier_id').isUUID().withMessage('Supplier ID is required and must be a valid UUID'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required and must not be empty'),
  body('items.*.product_id').isUUID().withMessage('Product ID is required and must be a valid UUID'),
  body('items.*.quantity').isNumeric().withMessage('Quantity must be numeric'),
  body('items.*.unit_cost').isNumeric().withMessage('Unit cost must be numeric')
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
      supplier_id,
      items,
      expected_delivery_date,
      notes,
      subtotal,
      tax_amount,
      total_amount,
      tracking_number
    } = req.body

    // Generate purchase order number with tracking number
    const orderNumber = await generatePurchaseOrderNumber(tracking_number)

    // Calculate totals if not provided
    let calculatedSubtotal = subtotal || 0
    if (!subtotal) {
      calculatedSubtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_cost), 0)
    }

    const calculatedTaxAmount = 0 // Tax removed as per requirement
    const calculatedTotal = total_amount || (calculatedSubtotal + calculatedTaxAmount)

    // Create purchase order
    const purchaseOrderQuery = `
      INSERT INTO purchase_orders
      (supplier_id, order_number, subtotal, tax_amount, total_amount,
       expected_delivery_date, notes, order_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)
      RETURNING *
    `

    const purchaseOrderResult = await client.query(purchaseOrderQuery, [
      supplier_id, orderNumber, calculatedSubtotal, calculatedTaxAmount, calculatedTotal,
      expected_delivery_date, notes
    ])

    const purchaseOrder = purchaseOrderResult.rows[0]

    // Create purchase order items
    for (const item of items) {
      // Verify product exists
      const productResult = await client.query(
        'SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL',
        [item.product_id]
      )

      if (productResult.rows.length === 0) {
        throw new Error(`Product with ID ${item.product_id} not found`)
      }

      const product = productResult.rows[0]
      const quantity = parseFloat(item.quantity)
      const unitCost = parseFloat(item.unit_cost)
      const totalCost = quantity * unitCost

      await client.query(`
        INSERT INTO purchase_order_items
        (purchase_order_id, product_id, quantity, unit_cost, total_cost)
        VALUES ($1, $2, $3, $4, $5)
      `, [purchaseOrder.id, item.product_id, quantity, unitCost, totalCost])
    }

    await client.query('COMMIT')

    // Fetch complete purchase order with items
    const completePurchaseOrder = await pool.query(`
      SELECT
        po.*,
        s.name as supplier_name,
        s.email as supplier_email,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', poi.id,
            'product_id', poi.product_id,
            'product_name', p.name,
            'quantity', poi.quantity,
            'unit_cost', poi.unit_cost,
            'total_cost', poi.total_cost,
            'received_quantity', poi.received_quantity
          )
        ) as items
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_order_items poi ON po.id = poi.purchase_order_id
      LEFT JOIN products p ON poi.product_id = p.id
      WHERE po.id = $1
      GROUP BY po.id, s.name, s.email
    `, [purchaseOrder.id])

    res.status(201).json({
      success: true,
      data: {
        ...completePurchaseOrder.rows[0],
        subtotal: parseFloat(completePurchaseOrder.rows[0].subtotal) || 0,
        tax_amount: parseFloat(completePurchaseOrder.rows[0].tax_amount) || 0,
        total_amount: parseFloat(completePurchaseOrder.rows[0].total_amount) || 0
      },
      message: 'Purchase order created successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error creating purchase order:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  } finally {
    client.release()
  }
})

// PATCH /api/purchase-orders/:id/status - Update purchase order status
router.patch('/:id/status', [
  body('status').isIn(['pending', 'confirmed', 'received', 'cancelled']).withMessage('Invalid status')
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
    const { status } = req.body

    // Get current purchase order
    const purchaseOrderResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [id])
    if (purchaseOrderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Purchase order not found'
      })
    }

    const currentOrder = purchaseOrderResult.rows[0]

    // If marking as received, update inventory
    if (status === 'received' && currentOrder.status !== 'received') {
      const orderItems = await client.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1', [id])

      for (const item of orderItems.rows) {
        // Update product stock
        const stockResult = await client.query('SELECT stock FROM products WHERE id = $1', [item.product_id])
        const currentStock = parseFloat(stockResult.rows[0].stock)
        const newStock = currentStock + parseFloat(item.quantity)

        await client.query('UPDATE products SET stock = $2 WHERE id = $1', [item.product_id, newStock])

        // Update received quantity
        await client.query(
          'UPDATE purchase_order_items SET received_quantity = quantity WHERE purchase_order_id = $1 AND product_id = $2',
          [id, item.product_id]
        )

        // Create stock movement
        await client.query(`
          INSERT INTO stock_movements
          (product_id, movement_type, quantity, reference_type, reference_id, notes)
          VALUES ($1, 'in', $2, 'purchase', $3, $4)
        `, [item.product_id, parseFloat(item.quantity), id, `Purchase order ${currentOrder.order_number} received`])
      }
    }

    // Update purchase order status
    const updateQuery = `UPDATE purchase_orders SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`
    const result = await client.query(updateQuery, [id, status])

    await client.query('COMMIT')

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        subtotal: parseFloat(result.rows[0].subtotal) || 0,
        tax_amount: parseFloat(result.rows[0].tax_amount) || 0,
        total_amount: parseFloat(result.rows[0].total_amount) || 0
      },
      message: 'Purchase order status updated successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating purchase order status:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  } finally {
    client.release()
  }
})

module.exports = router